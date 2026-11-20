# Chapter 2: Framing, JSON-RPC Transport, and Cooperative Concurrency

A language server multiplexes concurrent requests, notifications, file-watcher hints, and server-initiated client queries over one pair of byte streams (`stdin` and `stdout`) while emitting diagnostics to `stderr`. In `vscode-titan`, every stream has a single owning Task, every JSON-RPC boundary converts dynamic values into nominal Titan types immediately, and every cooperative wait carries explicit cancellation cleanup.

## Single-owner streams and transport separation

The protocol stack isolates six narrow responsibilities under `src/server/`:

1. **Byte framing** (`server.framing`) turns arbitrary read chunks into bounded `Content-Length` message bodies.
2. **Wire decoding** (`server.wire`) converts UTF-8 JSON text into native Maps, Arrays, and an explicit null sentinel.
3. **LSP schema and lifecycle** (`server.lsp_types`, `server.lifecycle`, `server.dispatcher`) validates JSON-RPC 2.0 envelopes, enforces `initialize`/`shutdown`/`exit` ordering, and classifies each frame into a typed `Route` union.
4. **Serialized queues** (`server.response_queue`, `server.protocol`) decouple non-yielding producers from single-owner reader and writer Tasks with explicit backpressure.
5. **Request coordination** (`server.coordinator`, `server.outbound_requests`) runs semantic requests in cooperative `async.Task` handles, captures mutable editor state before scheduling, and bounds server-initiated client queries.
6. **Structured logging** (`server.logging`) queues JSON log lines to a dedicated `stderr` writer Task so no log call ever touches `stdout` or yields in a sensitive transition.

## Polymorphic `Content-Length` framing over `io.Reader`

The same framing parser reads client messages from `os.stdin`, worker replies from child pipes (`os.InputStream`), and fragmented byte streams from `strings.reader` in unit tests. Titan's structural `io.Reader` and `io.Writer` Interfaces let `FrameReader:read` accept any conforming stream with zero adapter boilerplate:

```titan
record FrameReader
  local buffer: string
end

function frame(body: string): string
  return "Content-Length: " .. #body .. "\r\n\r\n" .. body
end

function FrameReader:read(source: io.Reader): string?
  while true do
    local body? = self:next()
    if body ~= nil then return body end

    local chunk? = source:read()
    if chunk == nil then
      if #self.buffer > 0 then
        return reject<|string|>("unexpected EOF in LSP frame")
      end
      return nil
    end
    self:feed(chunk)
  end
  return nil
end
```
*Source: [`src/server/framing.titan`](../src/server/framing.titan) — `FrameReader`, `frame`, `FrameReader:read`*

`FrameReader` retains every byte read past the end of one body so coalesced OS pipe reads never drop the start of the next frame. `FrameReader:next` enforces strict transport bounds and raises `FrameError` on any violation:

- **Size limits:** 64 KiB maximum header block (`MAX_HEADER_BYTES`) and 16 MiB maximum body (`MAX_CONTENT_BYTES`), checked against partial buffers even before `\r\n\r\n` arrives.
- **Header syntax:** CRLF line endings only, ASCII header names and values, exact unsigned decimal parsing with integer-overflow guard (`decimal_length`), and rejection of duplicate `Content-Length` or `Content-Type` headers.
- **Content type:** An optional `Content-Type` header must select `application/vscode-jsonrpc` and may carry at most one `charset` parameter equal to `utf-8` or `utf8`.

## JSON null sentinels, hoisted option spreads, and `titan.reflect`

In Titan and Lua, `nil` represents absence in Maps and Arrays, whereas JSON-RPC distinguishes an omitted member from an explicit `null` (such as `"id": null` on a parse-error reply or `"result": null` on a void request). [`src/server/wire.titan`](../src/server/wire.titan) solves this with a private zero-field `NullToken` record instantiated once in the module initializer.

Decoding and encoding also share fixed safety budgets: 128-level container nesting (`MAX_NESTING`), 16 MiB input limit (`MAX_INPUT_BYTES`), and a 16 MiB + 4 KiB output budget (`MAX_OUTPUT_BYTES`) so an error envelope around a maximum-size string request ID always fits. Rather than rebuilding option tables on every message, the module initializer configures the PEG stack once (`peg.set_max_stack(PEG_MATCH_STACK_LIMIT)`) and stores immutable `const {json.DecodeOption}` and `const {json.EncodeOption}` arrays that `decode` and `encode` forward via Titan's spread syntax:

```titan
local record NullToken
end

local const null_token: value
local const DECODE_OPTIONS: (const {json.DecodeOption})?
local const ENCODE_OPTIONS: (const {json.EncodeOption})?

function decode(source: string): value
  return json.decode(source, nil, ...DECODE_OPTIONS)
end

function as_array(subject: value): Array?
  case reflect.inspect(subject)
  when is_array{array = value} then return array
  else return nil
  end
end

function as_integer(subject: value): integer?
  case reflect.inspect(subject)
  when is_integer(number) then return number
  else return nil
  end
end
```
*Source: [`src/server/wire.titan`](../src/server/wire.titan) — `NullToken`, `decode`, `as_array`, `as_integer`*

Using `reflect.inspect` inside `as_object`, `as_array`, `as_string`, `as_integer`, and `as_boolean` guarantees strict JSON typing. Unlike a broad `value is integer` check (which accepts an integral float such as `1.0`), `when is_integer(number)` accepts only an exact Lua integer tag, and `when is_array{array = value}` distinguishes Titan's dense Array proxy from a Lua Map table.

Immediately above `wire`, [`src/server/lsp_types.titan`](../src/server/lsp_types.titan) parses raw `wire.Object` maps into nominal `const` records (`TextDocument`, `DocumentPosition`, `CompletionParams`, `DiagnosticParams`, `ReferencesParams`, `RenameParams`, `ClientCapabilities`) and the `DocumentNotification` union (`opened`, `changed`, `closed`, `saved`). Parameter validation happens once at this boundary, keeping untyped `value` maps out of downstream indexing and query modules.

## Lifecycle state machine and envelope dispatch

Two small, synchronous modules validate protocol state transitions without touching I/O or Tasks:

- **`server.lifecycle`** ([`src/server/lifecycle.titan`](../src/server/lifecycle.titan)) owns the five-state `Phase` union (`before_initialize`, `awaiting_initialized`, `running`, `shutdown`, `exited`) and returns an exhaustive `Decision` union (`unhandled`, `result`, `failure`, `notification`, `initialized`, `exit`). Both the router and workers answer `initialize` through `Lifecycle:dispatch`, guaranteeing identical advertised capabilities (`positionEncoding = "utf-16"`, `diagnosticProvider` unless disabled via `initializationOptions.pullDiagnostics`, `completionProvider` with triggers `.` and `:`, and router-only `workspace.workspaceFolders`). An `exit` notification yields exit code `0` after `shutdown` and `1` otherwise.
- **`server.dispatcher`** ([`src/server/dispatcher.titan`](../src/server/dispatcher.titan)) enforces JSON-RPC 2.0 framing rules (`"jsonrpc": "2.0"`, request IDs restricted to strings or signed 32-bit integers via the nominal `RequestId` union), recognizes client answers to server-initiated requests (`ClientResponse` when `method` is absent and `id` is a string with `result` or `error`), invokes `Lifecycle:dispatch`, and routes remaining messages into one `Route` union (`immediate`, `initialized`, `semantic`, `completion`, `document`, `client_response`, `cancel`, `shutdown`, `exit`).

`dispatcher.result_body` and `dispatcher.failure_body` also guard against `json.Error` during encoding: if a semantic error message contains invalid UTF-8 from a native or filesystem failure, `failure_body` falls back to a fixed `"Internal error"` payload while retaining the validated request ID.

## O(1) cursor queues, backpressure, and `async.ResumeToken`

Multiple concurrent request Tasks, watcher callbacks, and Task terminal listeners all publish JSON-RPC frames onto stdout. Terminal listeners and scheduler transitions cannot yield, so outbound publication must be strictly non-yielding while preserving FIFO order.

`ResponseQueue` in [`src/server/response_queue.titan`](../src/server/response_queue.titan) implements a single-consumer FIFO backed by an integer `head` cursor. Pushing appends to `self.items` and wakes any suspended writer Task without yielding:

```titan
record ResponseQueue
  local items: {string}
  local head: integer
  local waiter: async.Task?
  local const resume_token: async.ResumeToken
  local stopped: boolean
end

function ResponseQueue:push(message: string)
  if self.stopped then raise "protocol response queue is stopped" end
  self.items[#self.items + 1] = message
  self:wake()
end
```
*Source: [`src/server/response_queue.titan`](../src/server/response_queue.titan) — `ResponseQueue`, `ResponseQueue:push`*

`ResponseQueue:take` consumes in O(1) time by advancing `self.head`, clearing the consumed slot to release the string to the garbage collector, and resetting the backing array to `{}` whenever the queue drains. When the queue is empty and live, the consumer suspends on `self.resume_token` with a `defer detach()` guard so cancellation clears `self.waiter` before unwinding:

```titan
function ResponseQueue:take(): string?
  if self:pending() == 0 then
    if self.stopped then return nil end
    if self.waiter ~= nil then
      raise "protocol response queue already has a waiting consumer"
    end

    local current = async.running()
    self.waiter = current
    local detach = function ()
      if self.waiter == current then self.waiter = nil end
    end
    defer detach()
    async.suspend(self.resume_token, detach)
  end

  if self:pending() == 0 then return nil end

  local index = self.head
  local message = self.items[index]
  self.items[index] = nil
  self.head = index + 1
  if self.head > #self.items then
    self.items = {}
    self.head = 1
  end
  return message
end
```
*Source: [`src/server/response_queue.titan`](../src/server/response_queue.titan) — `ResponseQueue:take`*

[`src/server/protocol.titan`](../src/server/protocol.titan) applies the same cursor-and-token pattern to incoming messages (`InputQueue`), adding one-message backpressure via `InputDelivery`. `read_messages` wraps each framed body in an `InputDelivery`, pushes `InputEvent.message(delivery)`, and suspends on `delivery:wait()` until `protocol.run` processes the envelope and calls `delivery:acknowledge()`. Two properties follow from this handshake:

1. **Clean exit without EOF:** When `coordinator:handle` returns an exit code for `exit`, `protocol.run` acknowledges and returns immediately without requesting another read, leaving the reader Task suspended or cancelable even when a client keeps its stdin pipe open until process termination.
2. **Fairness under burst traffic:** After acknowledging each envelope, `protocol.run` calls `async.yield()` so the reader Task, spawned semantic Tasks, and sole writer Task all advance between buffered frames.

`Session:close` enforces an exact teardown order through `defer session:close()`:

1. Cancel and join every active request Task (`coordinator:cancel_all`).
2. Fail every pending server-initiated request (`requests:close`) so waiting Tasks unwind immediately rather than waiting on deadlines.
3. Cancel and join `reader`.
4. Call `output:stop()` and join `writer` so every terminal reply queued by step 1 flushes to stdout before the process exits.

## Pre-Task state capture, cancellation, and outbound deadlines

Spawning work with `async.run` schedules the new Task to execute on a subsequent turn of the event loop. For document-state queries (`textDocument/completion` and `textDocument/hover`), reading the open editor buffer *inside* the spawned Task would race with a subsequent `textDocument/didChange` or `textDocument/didClose` already queued behind it.

`Coordinator` in [`src/server/coordinator.titan`](../src/server/coordinator.titan) eliminates that race by splitting capture from execution. `Coordinator:start_completion` (and the hover branch in `Coordinator:handle`) runs the synchronous `capture(request)` callback *before* calling `async.run(work)`, binding the immutable buffer snapshot into the returned `CompletionWork` closure. Every started Task registers a `task:add_terminal_listener` callback (`Coordinator:complete`) guarded by `active.responded` so each request emits exactly one JSON-RPC reply (`succeeded`, `failed`, or `cancelled` with `-32800`) through the non-yielding `ResponseQueue`:

```titan
local function Coordinator:start_completion(request: dispatcher.CompletionRequest)
  if self:find(request.id) ~= nil then
    self:publish(dispatcher.failure_response(
      request.id, INVALID_REQUEST, "Duplicate active request id"))
    return
  end
  local capture? = self.completion_capture
  if capture == nil then
    self:publish(dispatcher.failure_response(
      request.id, METHOD_NOT_FOUND, "Method not found"))
    return
  end
  local work?: CompletionWork
  do
    work = capture(request)
  catch
    self:publish(dispatcher.failure_response(
      request.id, INTERNAL_ERROR, "Internal error"))
    return
  end
  self:start(request.id, "textDocument/completion", work)
end
```
*Source: [`src/server/coordinator.titan`](../src/server/coordinator.titan) — `Coordinator:start_completion`*

Cancellation follows the rule that requesting cancellation is not completion: `Coordinator:cancel` invokes `task:cancel(...)` and immediately calls `async.join(task)` so the handler's deferred cleanups settle before control returns to the protocol loop. During shutdown or session close, `Coordinator:cancel_all` snapshots `{...self.active}`, sends cancellation to every live Task first so they unwind concurrently, and joins every Task in that snapshot:

```titan
local function Coordinator:cancel(id: dispatcher.RequestId)
  local active? = self:find(id)
  if active == nil then return end
  local task = active.task
  -- ...
  if not task:status():has_finished() then
    task:cancel(async.CancellationReason.simple("LSP request cancelled"))
  end
  async.join(task)
end
```
*Source: [`src/server/coordinator.titan`](../src/server/coordinator.titan) — `Coordinator:cancel`*

Server-initiated requests — such as `window/workDoneProgress/create` during indexing — flow through `OutboundRequests` in [`src/server/outbound_requests.titan`](../src/server/outbound_requests.titan). `OutboundRequests:start` allocates a string ID (`"titan/<n>"`), writes the request envelope through the shared `ResponseQueue`, and returns a `PendingRequest`. When a matching client response arrives, `Coordinator:handle` routes it to `OutboundRequests:route`, which settles the pending record and resumes the waiter.

`PendingRequest:wait` supports an optional millisecond deadline by racing settlement against a `timer.sleep` Task. Two cleanup paths keep timer handles deterministic without masking caller cancellation:

```titan
function PendingRequest:wait(milliseconds: integer?): (value?, string?)
  if self.settled then return self.result, self.failure end
  if self.waiter ~= nil then
    raise "outbound request already has a waiting reader"
  end

  local current = async.running()
  self.waiter = current
  local detach = function ()
    if self.waiter == current then self.waiter = nil end
  end
  defer detach()

  local deadline: async.Task<|nil, value|>? = nil
  if milliseconds ~= nil then
    deadline = async.run<|nil, value|>(function (): nil
      timer.sleep(milliseconds)
      self:settle(nil, "timeout")
      return nil
    end)
  end
  defer do
    if deadline ~= nil and not deadline:status():has_finished() then
      deadline:cancel(async.CancellationReason.simple("request settled"))
    end
  end

  async.suspend(self.resume_token, detach)

  local pending_deadline? = deadline
  if pending_deadline ~= nil then
    if not pending_deadline:status():has_finished() then
      pending_deadline:cancel(async.CancellationReason.simple("request settled"))
    end
    async.join(pending_deadline)
  end
  return self.result, self.failure
end
```
*Source: [`src/server/outbound_requests.titan`](../src/server/outbound_requests.titan) — `PendingRequest:wait`*

If the waiting Task itself is cancelled during `async.suspend`, the `defer` block cancels `deadline` without calling `async.join` (which would re-raise the pending cancellation inside cleanup). On normal return, the epilogue cancels and joins `pending_deadline` so the libuv timer handle is terminal before the caller proceeds.

## Non-yielding structured stderr logging

[`src/server/logging.titan`](../src/server/logging.titan) reuses `response_queue.ResponseQueue` to own `os.stderr` through one background writer Task (`logging.start` / `logging.close`). Every log entry passes through `logging.format`, which checks the configured severity rank (`off`, `error`, `info`, `debug`, `trace`), encodes a flat JSON object via `wire.encode`, and prefixes `"titan-language-server "` so the extension client can separate structured records from unstructured native library stderr output.

Both `logging.emit` and `logging.raw` (used by the router to forward child worker stderr lines) are strictly non-yielding and wrap queue pushes and JSON encoding in `catch` blocks. A malformed non-UTF-8 error string from a filesystem call or a closed logging queue during teardown can never interrupt a Task terminal listener, watcher callback, or compiler permit release. For debug records summarizing large module lists, `logging.summarize_strings` bounds the emitted sample to `STRING_SAMPLE_LIMIT` (8 entries) while retaining the total count and a `truncated` flag.

---

← Previous: [Chapter 1](server-data-flow.md) | [Table of Contents](index.md) | Next: [Chapter 3: Crossing the Lua and C Boundaries](compiler-bridge.md) →
