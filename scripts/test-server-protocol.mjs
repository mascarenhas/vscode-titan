import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const server = process.argv[2];
const mode = process.argv[3] ?? "full";
if (!server) {
  console.error(
    "usage: node scripts/test-server-protocol.mjs PATH-TO-SERVER " +
      "[--self-contained-smoke]"
  );
  process.exit(2);
}
if (!["full", "--self-contained-smoke"].includes(mode)) {
  console.error(`unsupported protocol-test mode: ${mode}`);
  process.exit(2);
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
}

function withTimeout(promise, description, milliseconds = 5_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      milliseconds
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FrameReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.indexingStatuses = [];
    this.indexingStatusCursor = 0;
    this.lastIndexingEpoch = undefined;
    this.lastIndexingProgress = [];
    this.diagnosticPublications = [];
    this.diagnosticPublicationCursor = 0;
  }

  async read(milliseconds = 5_000) {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0) {
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const lines = header.split("\r\n");
        assert.equal(lines.length, 1, `unexpected response headers: ${header}`);
        const match = /^Content-Length: ([0-9]+)$/.exec(lines[0]);
        assert.ok(match, `stdout is not an LSP frame: ${header}`);
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length >= bodyEnd) {
          const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
          this.buffer = this.buffer.subarray(bodyEnd);
          return JSON.parse(body);
        }
      }

      const next = await withTimeout(
        this.iterator.next(),
        "a framed server response",
        milliseconds
      );
      if (next.done) {
        throw new Error(`server stdout ended with ${this.buffer.length} pending bytes`);
      }
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }

  async finish() {
    while (true) {
      const next = await withTimeout(
        this.iterator.next(),
        "server stdout to close"
      );
      if (next.done) return;
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }
}

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

async function makePhysicalTemporaryRoot(prefix) {
  // The standalone server indexes from its physical process cwd. Keep request
  // URIs in that same namespace on hosts where os.tmpdir() traverses a
  // directory symlink (the VS Code client performs this mapping itself).
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

function structuredLogRecords(buffer) {
  const prefix = "titan-language-server ";
  const output = buffer.toString("utf8");
  assert.ok(output.endsWith("\n"), "structured stderr lacked a final newline");
  const lines = output.slice(0, -1).split("\n");
  assert.ok(lines.length > 0, "server emitted no structured stderr records");
  return lines.map((line) => {
    assert.ok(
      line.startsWith(prefix),
      `server emitted unstructured stderr: ${line}`
    );
    const record = JSON.parse(line.slice(prefix.length));
    assert.ok(record !== null && typeof record === "object");
    assert.equal(typeof record.level, "string");
    assert.equal(typeof record.event, "string");
    return record;
  });
}

function launch(cwd = process.cwd(), logLevel = "off") {
  return spawn(path.resolve(server), [], {
    cwd,
    env: {
      ...process.env,
      TITAN_LANGUAGE_SERVER_LOG_LEVEL: logLevel
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function printedLuaPaths(environment) {
  const child = spawn(path.resolve(server), ["--print-paths"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exit = exitOf(child);
  const outcome = await awaitExit(exit);
  assert.deepEqual(
    outcome,
    { code: 0, signal: null },
    stderr().toString("utf8")
  );
  assert.equal(stderr().length, 0, stderr().toString("utf8"));
  return stdout().toString("utf8");
}

async function testLuaModulePathConfiguration() {
  const defaultEnvironment = {
    ...process.env,
    LUA_PATH: "/ambient/must-not-leak/?.lua",
    LUA_CPATH: "/ambient/must-not-leak/?.so"
  };
  delete defaultEnvironment.TITAN_LS_LUA_PATH;
  delete defaultEnvironment.TITAN_LS_LUA_CPATH;
  assert.equal(
    await printedLuaPaths(defaultEnvironment),
    "package.path=./?.lua\npackage.cpath=./?.so\n"
  );

  const sourcePath = "/extension with spaces/share/lua/5.5/?.lua";
  const nativePath = "/extension with spaces/lib/lua/5.5/?.so";
  assert.equal(
    await printedLuaPaths({
      ...defaultEnvironment,
      TITAN_LS_LUA_PATH: sourcePath,
      TITAN_LS_LUA_CPATH: nativePath
    }),
    `package.path=${sourcePath}\npackage.cpath=${nativePath}\n`
  );
}

function exitOf(child) {
  return once(child, "close").then(([code, signal]) => ({ code, signal }));
}

function awaitExit(exit) {
  return withTimeout(exit, "server exit");
}

async function responseFor(responses, id, milliseconds = 5_000) {
  while (true) {
    const message = await responses.read(milliseconds);
    if (message.id === undefined && typeof message.method === "string") {
      collectNotification(responses, message);
      continue;
    }
    assert.equal(message.jsonrpc, "2.0");
    assert.equal(message.id, id);
    return message;
  }
}

function validateDiagnosticPublication(params) {
  assert.ok(params !== null && typeof params === "object");
  assert.equal(typeof params.uri, "string");
  assert.ok(Array.isArray(params.diagnostics));
  for (const diagnostic of params.diagnostics) {
    assert.ok(diagnostic !== null && typeof diagnostic === "object");
    assert.equal(diagnostic.severity, 1);
    assert.ok(["syntax", "type", "compiler"].includes(diagnostic.code));
    assert.equal(diagnostic.source, "Titan");
    assert.equal(typeof diagnostic.message, "string");
    for (const position of [
      diagnostic.range?.start,
      diagnostic.range?.end
    ]) {
      assert.ok(position !== null && typeof position === "object");
      assert.ok(Number.isInteger(position.line) && position.line >= 0);
      assert.ok(Number.isInteger(position.character) && position.character >= 0);
    }
  }
}

function collectNotification(responses, message) {
  assert.equal(message.jsonrpc, "2.0");
  if (message.method === "titan/indexingStatus") {
    responses.indexingStatuses.push(message.params);
    return;
  }
  if (message.method === "textDocument/publishDiagnostics") {
    validateDiagnosticPublication(message.params);
    responses.diagnosticPublications.push(message.params);
    return;
  }
  assert.fail(`unexpected server notification ${message.method}`);
}

function validateIndexingStatus(status) {
  assert.ok(status !== null && typeof status === "object");
  assert.ok(Number.isInteger(status.epoch));
  assert.equal(typeof status.initial, "boolean");
  assert.ok(["indexing", "ready", "failed"].includes(status.state));
  if (status.generation !== undefined) {
    assert.ok(Number.isInteger(status.generation));
  }
  if (status.message !== undefined) {
    assert.equal(typeof status.message, "string");
  }
  const hasCompleted = status.completed_files !== undefined;
  const hasTotal = status.total_files !== undefined;
  assert.equal(
    hasCompleted,
    hasTotal,
    "indexing status supplied only one saved-file progress field"
  );
  if (hasCompleted) {
    assert.equal(
      status.state,
      "indexing",
      "terminal indexing status retained saved-file progress"
    );
    assert.ok(Number.isSafeInteger(status.completed_files));
    assert.ok(Number.isSafeInteger(status.total_files));
    assert.ok(status.completed_files >= 0);
    assert.ok(status.total_files >= 0);
    assert.ok(status.completed_files <= status.total_files);
  }
}

async function nextIndexingStatus(responses) {
  while (responses.indexingStatusCursor >= responses.indexingStatuses.length) {
    const message = await responses.read(30_000);
    assert.equal(message.id, undefined);
    assert.equal(typeof message.method, "string");
    collectNotification(responses, message);
  }
  const status = responses.indexingStatuses[responses.indexingStatusCursor];
  responses.indexingStatusCursor += 1;
  validateIndexingStatus(status);
  return status;
}

async function nextDiagnosticPublication(responses) {
  while (responses.diagnosticPublicationCursor >=
         responses.diagnosticPublications.length) {
    const message = await responses.read(30_000);
    assert.equal(message.id, undefined);
    assert.equal(typeof message.method, "string");
    collectNotification(responses, message);
  }
  const publication = responses.diagnosticPublications[
    responses.diagnosticPublicationCursor
  ];
  responses.diagnosticPublicationCursor += 1;
  validateDiagnosticPublication(publication);
  return publication;
}

async function waitForIndexing(
  responses,
  expectedState = "ready",
  cycleCount = 1,
  minimumEpoch
) {
  assert.ok(Number.isInteger(cycleCount) && cycleCount >= 1);
  let terminal;
  let acceptedCycles = 0;
  while (acceptedCycles < cycleCount) {
    let indexing;
    let activeWorkset;
    const progress = [];
    while (true) {
      const status = await nextIndexingStatus(responses);
      if (status.state === "indexing") {
        assert.equal(status.message, undefined);
        if (indexing === undefined) {
          assert.equal(status.completed_files, undefined);
          assert.equal(status.total_files, undefined);
          indexing = status;
          continue;
        }

        assert.equal(status.initial, indexing.initial);
        assert.ok(status.epoch >= indexing.epoch);
        if (status.completed_files === undefined) {
          assert.ok(
            status.epoch > indexing.epoch,
            "bare busy reset did not advance the saved epoch"
          );
          if (activeWorkset !== undefined) {
            assert.ok(
              status.epoch > activeWorkset.epoch,
              "bare busy reset retained the preceding workset epoch"
            );
          }
          indexing = status;
          activeWorkset = undefined;
          continue;
        }
        if (status.completed_files === 0) {
          activeWorkset = {
            epoch: status.epoch,
            total: status.total_files,
            completed: 0
          };
        } else {
          assert.ok(activeWorkset, "workset progress lacked an initial 0/M");
          assert.equal(status.epoch, activeWorkset.epoch);
          assert.equal(status.total_files, activeWorkset.total);
          assert.ok(status.completed_files >= activeWorkset.completed);
          activeWorkset.completed = status.completed_files;
        }
        progress.push(status);
        continue;
      }

      assert.ok(indexing, "indexing completion lacked busy status");
      assert.equal(status.initial, indexing.initial);
      assert.ok(status.epoch >= indexing.epoch);
      if (progress.length > 0) {
        assert.ok(status.epoch >= progress[progress.length - 1].epoch);
      }
      if (status.state === "failed") {
        assert.equal(typeof status.message, "string");
        assert.ok(status.message.length > 0);
      } else {
        assert.equal(status.message, undefined);
      }
      if (status.state === "ready") {
        assert.ok(Number.isInteger(status.generation));
      }
      responses.lastIndexingEpoch = Math.max(
        responses.lastIndexingEpoch ?? status.epoch,
        status.epoch
      );
      if (minimumEpoch !== undefined && status.epoch < minimumEpoch) {
        break;
      }
      assert.equal(status.state, expectedState);
      responses.lastIndexingProgress = progress;
      terminal = status;
      acceptedCycles += 1;
      break;
    }
  }
  return terminal;
}

async function testCoalescedIndexingResetStatus() {
  const responses = {
    indexingStatuses: [
      { state: "indexing", initial: true, epoch: 7 },
      {
        state: "indexing", initial: true, epoch: 7,
        completed_files: 0, total_files: 2
      },
      {
        state: "indexing", initial: true, epoch: 7,
        completed_files: 2, total_files: 2
      },
      { state: "indexing", initial: true, epoch: 8 },
      {
        state: "indexing", initial: true, epoch: 8,
        completed_files: 0, total_files: 1
      },
      {
        state: "indexing", initial: true, epoch: 8,
        completed_files: 1, total_files: 1
      },
      { state: "ready", initial: true, epoch: 8, generation: 2 }
    ],
    indexingStatusCursor: 0,
    lastIndexingEpoch: undefined,
    lastIndexingProgress: []
  };
  const terminal = await waitForIndexing(responses);
  assert.equal(terminal.epoch, 8);
  assert.equal(responses.lastIndexingProgress.at(-1).completed_files, 1);
  assert.equal(responses.indexingStatusCursor, responses.indexingStatuses.length);
}

async function testLifecycle() {
  const root = await makePhysicalTemporaryRoot("vscode-titan-lazy-");
  // Lifecycle-only sessions must not touch project configuration or load the
  // compiler. This file intentionally fails if the lazy boundary regresses.
  await writeFile(
    path.join(root, "titan-config.lua"),
    "this is not valid Lua and must not be evaluated\n",
    "utf8"
  );
  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    const initialize = frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    });
    child.stdin.write(initialize.subarray(0, 9));
    child.stdin.write(initialize.subarray(9, 27));
    child.stdin.write(initialize.subarray(27));

    const initialized = await responses.read();
    assert.equal(initialized.jsonrpc, "2.0");
    assert.equal(initialized.id, 1);
    assert.deepEqual(initialized.result, {
      capabilities: {
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
        hoverProvider: true,
        foldingRangeProvider: true,
        positionEncoding: "utf-16"
      }
    });

    child.stdin.write(Buffer.concat([
      frame({ jsonrpc: "2.0", method: "initialized", params: {} }),
      frame({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: { id: 999 }
      }),
      frame({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "shutdown",
        params: null
      })
    ]));

    const shutdown = await responseFor(responses, "shutdown");
    assert.equal(shutdown.jsonrpc, "2.0");
    assert.equal(shutdown.id, "shutdown");
    assert.equal(shutdown.result, null);

    // The server must stop after exit even while the client side of stdin
    // remains open; teardown cannot wait for another read to reach EOF.
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await awaitExit(exit), { code: 0, signal: null });
    await responses.finish();
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
    assert.equal(responses.buffer.length, 0, "unexpected bytes after responses");
  } catch (cause) {
    const diagnostic = stderr().toString("utf8").trim();
    throw new Error(
      `${cause.message}${diagnostic.length > 0 ? `; stderr: ${diagnostic}` : ""}`,
      { cause }
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function request(
  child,
  responses,
  id,
  method,
  params,
  milliseconds = 5_000
) {
  child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
  return responseFor(responses, id, milliseconds);
}

async function semanticRequest(
  child,
  responses,
  id,
  method,
  params,
  { expectedIndexingState = "ready", indexingCycles } = {}
) {
  const response = await request(
    child,
    responses,
    id,
    method,
    params,
    30_000
  );
  const cycleCount = indexingCycles ??
    (method === "textDocument/rename" ? 2 : 0);
  assert.ok(Number.isInteger(cycleCount) && cycleCount >= 0);
  if (cycleCount > 0) {
    await waitForIndexing(responses, expectedIndexingState, cycleCount);
  }
  return response;
}

async function writeSavedGeneration(
  responses,
  filename,
  contents,
  expectedIndexingState = "ready"
) {
  const previousEpoch = responses.lastIndexingEpoch;
  assert.ok(
    Number.isInteger(previousEpoch),
    "saved-generation wait requires completed initial indexing"
  );
  await writeFile(filename, contents, "utf8");
  return waitForIndexing(
    responses,
    expectedIndexingState,
    1,
    previousEpoch + 1
  );
}

async function testSavedProjectSemantics() {
  const root = await makePhysicalTemporaryRoot("vscode-titan-project-");
  const filename = path.join(root, "sample.titan");
  const sourceLines = [
    "function answer(item: integer): integer",
    "  return item * 2",
    "end",
    "function use(): integer",
    "  return answer(#\"😀\", answer(21))",
    "end",
    "function widen(item: integer): float",
    "  local widened: float = item",
    "  return widened",
    "end",
    ""
  ];
  await writeFile(
    path.join(root, "titan-config.lua"),
    'include = { "." }\nsource_module_roots = { "." }\n',
    "utf8"
  );
  await writeFile(filename, sourceLines.join("\n"), "utf8");

  const uri = pathToFileURL(filename).href;
  const firstUse = sourceLines[4].indexOf("answer");
  const unicodeUse = sourceLines[4].lastIndexOf("answer");
  assert.ok(unicodeUse > firstUse);
  assert.ok(
    Buffer.byteLength(sourceLines[4].slice(0, unicodeUse), "utf8") > unicodeUse,
    "fixture position did not cross a multibyte Unicode scalar"
  );

  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    const initialized = await request(child, responses, 1, "initialize", {});
    assert.equal(initialized.result.capabilities.completionProvider, undefined);
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));
    await waitForIndexing(responses);

    // V1 semantics are deliberately saved-file-only. Even if a client sends
    // text synchronization notifications that the server does not advertise,
    // their divergent in-memory text must not become compiler input. Keep the
    // buffer valid so a buffer-backed implementation cannot pass by falling
    // back to the last valid disk AST.
    const unsavedSource = [
      `local ${sourceLines[0]}`,
      ...sourceLines.slice(1)
    ].join("\n");
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: "titan",
          version: 1,
          text: unsavedSource
        }
      }
    }));
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: unsavedSource }]
      }
    }));

    const documentPosition = {
      textDocument: { uri },
      position: { line: 4, character: unicodeUse + 1 }
    };

    const definition = await semanticRequest(
      child,
      responses,
      "definition",
      "textDocument/definition",
      documentPosition
    );
    assert.equal(
      definition.error,
      undefined,
      `definition failed: ${JSON.stringify(definition.error)}`
    );
    assert.deepEqual(definition.result, {
      uri,
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 15 }
      }
    });

    const references = await semanticRequest(
      child,
      responses,
      "references",
      "textDocument/references",
      {
        ...documentPosition,
        context: { includeDeclaration: true }
      }
    );
    assert.equal(references.result.length, 3);
    assert.ok(references.result.some((location) =>
      location.range.start.line === 4 &&
      location.range.start.character === unicodeUse
    ));

    const hover = await semanticRequest(
      child,
      responses,
      "hover",
      "textDocument/hover",
      documentPosition
    );
    assert.equal(hover.result.contents.kind, "markdown");
    assert.match(hover.result.contents.value, /integer/);
    assert.match(hover.result.contents.value, /Visibility: exported/);
    assert.deepEqual(hover.result.range, {
      start: { line: 4, character: unicodeUse },
      end: { line: 4, character: unicodeUse + "answer".length }
    });

    const coercedItem = sourceLines[7].lastIndexOf("item");
    assert.ok(coercedItem >= 0, "coercion fixture has no item use");
    const coercionHover = await semanticRequest(
      child,
      responses,
      "coercion-hover",
      "textDocument/hover",
      {
        textDocument: { uri },
        position: { line: 7, character: coercedItem + 1 }
      }
    );
    assert.equal(coercionHover.result.contents.kind, "markdown");
    assert.match(coercionHover.result.contents.value,
      /Type: `integer`/);
    assert.match(coercionHover.result.contents.value,
      /Cast to: `float`/);
    assert.doesNotMatch(coercionHover.result.contents.value,
      /Inferred type|Declared type|Original type|Coerced type/);
    assert.match(coercionHover.result.contents.value, /Visibility: block/);
    assert.deepEqual(coercionHover.result.range, {
      start: { line: 7, character: coercedItem },
      end: { line: 7, character: coercedItem + "item".length }
    });

    const folding = await semanticRequest(
      child,
      responses,
      "folding",
      "textDocument/foldingRange",
      { textDocument: { uri } }
    );
    assert.ok(folding.result.some((range) =>
      range.startLine === 0 && range.endLine === 1
    ));
    assert.ok(folding.result.some((range) =>
      range.startLine === 3 && range.endLine === 4
    ));

    const rename = await semanticRequest(
      child,
      responses,
      "rename",
      "textDocument/rename",
      { ...documentPosition, newName: "solution" }
    );
    const edits = rename.result.changes[uri];
    assert.equal(edits.length, 3);
    assert.ok(edits.every((edit) => edit.newText === "solution"));
    assert.ok(edits.some((edit) =>
      edit.range.start.line === 4 &&
      edit.range.start.character === unicodeUse
    ));

    const invalid = await request(
      child,
      responses,
      "invalid",
      "textDocument/definition",
      { textDocument: { uri } }
    );
    assert.equal(invalid.error.code, -32602);

    const unsupported = await request(
      child,
      responses,
      "unsupported",
      "textDocument/completion",
      documentPosition
    );
    assert.equal(unsupported.error.code, -32601);

    // An invalid saved module must not fall back to its previously checked
    // AST or fail the whole workspace. It remains in the saved project used by
    // rename preflight, but contributes no semantic snapshot until repaired.
    await writeSavedGeneration(
      responses,
      filename,
      "function answer(\n",
      "ready"
    );
    const publishedFailure = await nextDiagnosticPublication(responses);
    assert.equal(publishedFailure.uri, uri);
    assert.equal(publishedFailure.diagnostics.length, 1);
    assert.equal(publishedFailure.diagnostics[0].code, "syntax");
    assert.match(publishedFailure.diagnostics[0].message, /syntax error/);
    const partial = await semanticRequest(
      child,
      responses,
      "partial",
      "textDocument/definition",
      documentPosition
    );
    assert.equal(partial.error, undefined);
    assert.equal(partial.result, null);

    await writeSavedGeneration(
      responses,
      filename,
      sourceLines.join("\n"),
      "ready"
    );
    const repairedDiagnostics = await nextDiagnosticPublication(responses);
    assert.equal(repairedDiagnostics.uri, uri);
    assert.deepEqual(repairedDiagnostics.diagnostics, []);
    const recovered = await semanticRequest(
      child,
      responses,
      "recovered",
      "textDocument/definition",
      documentPosition
    );
    assert.deepEqual(recovered.result, definition.result);

    // Diagnostic publication follows completed saved generations directly;
    // it must not depend on a hover/definition request to flush Problems.
    await writeSavedGeneration(
      responses,
      filename,
      "function answer(\n",
      "ready"
    );
    const beforeShutdown = await nextDiagnosticPublication(responses);
    assert.equal(beforeShutdown.uri, uri);
    assert.equal(beforeShutdown.diagnostics.length, 1);

    const shutdown = await request(
      child,
      responses,
      "shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    const shutdownClear = await nextDiagnosticPublication(responses);
    assert.equal(shutdownClear.uri, uri);
    assert.deepEqual(shutdownClear.diagnostics, []);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await awaitExit(exit), { code: 0, signal: null });
    await responses.finish();
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
    assert.equal(responses.buffer.length, 0, "unexpected bytes after responses");
  } catch (cause) {
    const diagnostic = stderr().toString("utf8").trim();
    throw new Error(
      `${cause.message}${diagnostic.length > 0 ? `; stderr: ${diagnostic}` : ""}`,
      { cause }
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSelfContainedCompilerModules() {
  const root = await makePhysicalTemporaryRoot(
    "vscode-titan-self-contained-"
  );
  const filename = path.join(root, "standard_module.titan");
  const lines = [
    'local strings = import "string"',
    'local http = import "http"',
    "",
    "function render(item: string): string",
    "  return strings.upper(item)",
    "end",
    "function request_scheme(request: http.Request): string",
    "  return request.url.scheme",
    "end",
    "function use(): string",
    '  return render("titan")',
    "end",
    ""
  ];
  await writeFile(
    path.join(root, "titan-config.lua"),
    'include = { "." }\nsource_module_roots = { "." }\n',
    "utf8"
  );
  await writeFile(filename, lines.join("\n"), "utf8");

  const uri = pathToFileURL(filename).href;
  const renderLine = lines.findIndex(
    (line) => line.startsWith("function render(")
  );
  assert.ok(renderLine >= 0);
  const useLine = lines.findIndex((line) => line.includes('render("titan")'));
  assert.ok(useLine >= 0);
  const useColumn = lines[useLine].indexOf("render");
  assert.ok(useColumn >= 0);
  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    await request(child, responses, 1, "initialize", {});
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));
    await waitForIndexing(responses);

    const definition = await semanticRequest(
      child,
      responses,
      "self-contained-definition",
      "textDocument/definition",
      {
        textDocument: { uri },
        position: { line: useLine, character: useColumn + 1 }
      }
    );
    assert.equal(definition.error, undefined, JSON.stringify(definition.error));
    assert.deepEqual(
      definition.result,
      {
        uri,
        range: {
          start: { line: renderLine, character: 9 },
          end: { line: renderLine, character: 15 }
        }
      },
      `self-contained definition failed; diagnostics: ${
        JSON.stringify(responses.diagnosticPublications)
      }`
    );
    assert.ok(
      responses.diagnosticPublications.every(
        (publication) => publication.diagnostics.length === 0
      ),
      `self-contained standard-module fixture produced diagnostics: ${
        JSON.stringify(responses.diagnosticPublications)
      }`
    );

    const shutdown = await request(
      child,
      responses,
      "self-contained-shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await awaitExit(exit), { code: 0, signal: null });
    await responses.finish();
    assert.equal(responses.buffer.length, 0);
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
  } catch (cause) {
    const diagnostic = stderr().toString("utf8").trim();
    throw new Error(
      `${cause.message}${diagnostic.length > 0 ? `; stderr: ${diagnostic}` : ""}`,
      { cause }
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testConfigCannotWriteProtocolStdout() {
  const root = await makePhysicalTemporaryRoot("vscode-titan-config-");
  const filename = path.join(root, "sample.titan");
  await writeFile(filename, "function answer(): integer return 42 end\n", "utf8");
  await writeFile(
    path.join(root, "titan-config.lua"),
    "print('unframed workspace output')\nreturn {}\n",
    "utf8"
  );

  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    await request(child, responses, 1, "initialize", {});
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));
    const indexing = await waitForIndexing(responses, "failed");
    assert.match(indexing.message, /cannot evaluate titan-config\.lua/);
    const rejected = await semanticRequest(
      child,
      responses,
      "config-output",
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(filename).href },
        position: { line: 0, character: 10 }
      },
      { expectedIndexingState: "failed" }
    );
    assert.equal(rejected.error.code, -32803);
    assert.match(rejected.error.message, /cannot evaluate titan-config\.lua/);

    const shutdown = await request(
      child,
      responses,
      "shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await awaitExit(exit), { code: 0, signal: null });
    await responses.finish();
    assert.equal(responses.buffer.length, 0, "config emitted unframed stdout");
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSourceImportCppflagsAndUnchangedRequests() {
  const root = await makePhysicalTemporaryRoot("vscode-titan-source-config-");
  const sourceRoot = path.join(root, "src");
  const secondarySourceRoot = path.join(sourceRoot, "stdlib");
  const lookupRoot = path.join(root, "lookup");
  const includeRoot = path.join(root, "include");
  await mkdir(sourceRoot);
  await mkdir(secondarySourceRoot);
  await mkdir(lookupRoot);
  await mkdir(includeRoot);
  await writeFile(
    path.join(root, "titan-config.lua"),
    [
      'include = { "src", "src/stdlib" }',
      'source_module_roots = { "src", "src/stdlib", "lookup" }',
      'exclude = { "src/stdlib/provider.titan" }',
      'extra_ffi_include_dirs = { "include" }',
      "extra_ffi_cppflags = \"-DVSCODE_TITAN_PROTOCOL_FLAG=17 " +
        "-UVSCODE_TITAN_PROTOCOL_FLAG " +
        "'-DVSCODE_TITAN_PROTOCOL_FLAG=42'\"",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(includeRoot, "vscode_titan_protocol_guard.h"),
    [
      "#if !defined(VSCODE_TITAN_PROTOCOL_FLAG)",
      "#error project preprocessing flag is missing",
      "#elif VSCODE_TITAN_PROTOCOL_FLAG != 42",
      "#error project preprocessing flag has the wrong value",
      "#endif",
      "typedef int vscode_titan_protocol_int;",
      ""
    ].join("\n"),
    "utf8"
  );

  const providerLines = [
    "local function secret(item: integer): integer",
    "  return item + 1",
    "end",
    ""
  ];
  const consumerLines = [
    'local provider = import "provider.titan"',
    'local external = import "external"',
    "function answer(): integer",
    "  return provider.secret(40) + external.external_answer()",
    "end",
    ""
  ];
  const externalLines = [
    "function external_answer(): integer",
    "  return 1",
    "end",
    ""
  ];
  const guardedLines = [
    'local c = foreign import "vscode_titan_protocol_guard.h"',
    "function guarded_answer(item: integer): integer",
    "  local converted: c.vscode_titan_protocol_int = item",
    "  return converted",
    "end",
    ""
  ];
  const providerFile = path.join(secondarySourceRoot, "provider.titan");
  const consumerFile = path.join(sourceRoot, "consumer.titan");
  const guardedFile = path.join(sourceRoot, "guarded.titan");
  const externalFile = path.join(lookupRoot, "external.titan");
  await writeFile(providerFile, providerLines.join("\n"), "utf8");
  await writeFile(consumerFile, consumerLines.join("\n"), "utf8");
  await writeFile(guardedFile, guardedLines.join("\n"), "utf8");
  await writeFile(externalFile, externalLines.join("\n"), "utf8");

  const providerUri = pathToFileURL(providerFile).href;
  const consumerUri = pathToFileURL(consumerFile).href;
  const guardedUri = pathToFileURL(guardedFile).href;
  const secretColumn = consumerLines[3].indexOf("secret");
  const guardedColumn = guardedLines[1].indexOf("guarded_answer");
  assert.ok(secretColumn >= 0 && guardedColumn >= 0);

  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    await request(child, responses, 1, "initialize", {});
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));
    await waitForIndexing(responses);
    const unchangedStatusStart = responses.indexingStatuses.length;

    const sourcePosition = {
      textDocument: { uri: consumerUri },
      position: { line: 3, character: secretColumn + 1 }
    };
    const definition = await semanticRequest(
      child,
      responses,
      "source-import-definition",
      "textDocument/definition",
      sourcePosition
    );
    assert.equal(definition.error, undefined, JSON.stringify(definition.error));
    assert.deepEqual(definition.result, {
      uri: providerUri,
      range: {
        start: { line: 0, character: 15 },
        end: { line: 0, character: 21 }
      }
    });

    const references = await semanticRequest(
      child,
      responses,
      "source-import-references",
      "textDocument/references",
      { ...sourcePosition, context: { includeDeclaration: true } }
    );
    assert.equal(references.error, undefined, JSON.stringify(references.error));
    assert.equal(references.result.length, 2);
    assert.deepEqual(
      new Set(references.result.map((location) => location.uri)),
      new Set([providerUri, consumerUri])
    );

    const guardedHover = await semanticRequest(
      child,
      responses,
      "configured-ffi-hover",
      "textDocument/hover",
      {
        textDocument: { uri: guardedUri },
        position: { line: 1, character: guardedColumn + 1 }
      }
    );
    assert.equal(
      guardedHover.error,
      undefined,
      JSON.stringify(guardedHover.error)
    );
    assert.ok(
      guardedHover.result,
      "project preprocessing configuration did not produce a semantic snapshot; " +
        `diagnostics: ${JSON.stringify(responses.diagnosticPublications)}`
    );
    assert.equal(guardedHover.result.contents.kind, "markdown");
    assert.match(guardedHover.result.contents.value, /guarded_answer/);

    const folding = await semanticRequest(
      child,
      responses,
      "unchanged-folding",
      "textDocument/foldingRange",
      { textDocument: { uri: consumerUri } }
    );
    assert.equal(folding.error, undefined, JSON.stringify(folding.error));
    assert.ok(Array.isArray(folding.result));

    const shutdown = await request(
      child,
      responses,
      "source-config-shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    // The shutdown response is an ordering barrier for every preceding
    // semantic request and notification. An unchanged definition, references,
    // hover, or folding request must not start an indexing chain.
    assert.equal(
      responses.indexingStatuses.length,
      unchangedStatusStart,
      "unchanged read-only requests emitted indexing notifications"
    );
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await awaitExit(exit), { code: 0, signal: null });
    await responses.finish();
    assert.equal(responses.buffer.length, 0, "unexpected source/config stdout");
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
  } catch (cause) {
    const diagnostic = stderr().toString("utf8").trim();
    throw new Error(
      `${cause.message}${diagnostic.length > 0 ? `; stderr: ${diagnostic}` : ""}`,
      { cause }
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testCrossModuleFolderAndIncrementalSemantics() {
  const root = await makePhysicalTemporaryRoot("vscode-titan-modules-");
  const sourceRoot = path.join(root, "src");
  const libraryRoot = path.join(sourceRoot, "library");
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(
    path.join(root, "titan-config.lua"),
    "include = { 'src' }\n",
    "utf8"
  );
  const mainFile = path.join(libraryRoot, "library.titan");
  const partFile = path.join(libraryRoot, "part.titan");
  const consumerFile = path.join(sourceRoot, "consumer.titan");
  await writeFile(
    mainFile,
    "function answer(item: integer): integer return item * 2 end\n",
    "utf8"
  );
  const validPart =
    "function extra(item: integer): integer return item + 1 end\n";
  await writeFile(partFile, validPart, "utf8");
  const consumerLines = [
    "local library = import \"library\"",
    "local strings = import \"string\"",
    "function use(): integer",
    "  return library.extra(library.answer(20)) + #strings.sub(\"x\", 1, 1)",
    "end",
    ""
  ];
  await writeFile(consumerFile, consumerLines.join("\n"), "utf8");

  const consumerUri = pathToFileURL(consumerFile).href;
  const partUri = pathToFileURL(partFile).href;
  const extraColumn = consumerLines[3].indexOf("extra");
  const subColumn = consumerLines[3].indexOf("sub");
  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    await request(child, responses, 1, "initialize", {});
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));
    await waitForIndexing(responses);

    const extraPosition = {
      textDocument: { uri: consumerUri },
      position: { line: 3, character: extraColumn + 1 }
    };
    const definition = await semanticRequest(
      child,
      responses,
      "folder-definition",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(
      definition.error,
      undefined,
      `folder definition failed: ${JSON.stringify(definition.error)}`
    );
    assert.deepEqual(definition.result, {
      uri: partUri,
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 14 }
      }
    });

    const references = await semanticRequest(
      child,
      responses,
      "cross-references",
      "textDocument/references",
      { ...extraPosition, context: { includeDeclaration: true } }
    );
    assert.equal(references.result.length, 2);
    assert.deepEqual(
      new Set(references.result.map((location) => location.uri)),
      new Set([partUri, consumerUri])
    );

    const rename = await semanticRequest(
      child,
      responses,
      "cross-rename",
      "textDocument/rename",
      { ...extraPosition, newName: "augment" }
    );
    assert.equal(rename.error, undefined, JSON.stringify(rename.error));
    assert.equal(rename.result.changes[partUri].length, 1);
    assert.equal(rename.result.changes[consumerUri].length, 1);
    assert.ok(Object.values(rename.result.changes).flat().every(
      (edit) => edit.newText === "augment"
    ));

    const externalDefinition = await semanticRequest(
      child,
      responses,
      "external-definition",
      "textDocument/definition",
      {
        textDocument: { uri: consumerUri },
        position: { line: 3, character: subColumn + 1 }
      }
    );
    assert.equal(externalDefinition.result, null);

    // An implementation-only change keeps the public manifest stable, so the
    // clean consumer remains reusable and navigation still succeeds.
    await writeSavedGeneration(
      responses,
      partFile,
      "function extra(item: integer): integer return item + 200 end\n"
    );
    const unchangedManifest = await semanticRequest(
      child,
      responses,
      "implementation-change",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(unchangedManifest.error, undefined);
    assert.equal(unchangedManifest.result.uri, partUri);

    // A public interface change invalidates and rechecks the consumer in the
    // same refresh fixed point. The changed provider remains indexed, while
    // the now-invalid consumer contributes no stale semantic snapshot.
    await writeSavedGeneration(
      responses,
      partFile,
      "function extra(item: integer): string return \"broken\" end\n"
    );
    const changedManifest = await semanticRequest(
      child,
      responses,
      "interface-change",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(changedManifest.error, undefined);
    assert.equal(changedManifest.result, null);

    await writeSavedGeneration(responses, partFile, validPart);
    const recovered = await semanticRequest(
      child,
      responses,
      "recovered-generation",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.result.uri, partUri);

    const shutdown = await request(
      child,
      responses,
      "shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await awaitExit(exit), { code: 0, signal: null });
    await responses.finish();
    assert.equal(responses.buffer.length, 0, "unexpected cross-module stdout");
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDebugCompilerProgress() {
  const root = await makePhysicalTemporaryRoot("vscode-titan-progress-");
  const moduleRoot = path.join(root, "sample");
  await mkdir(moduleRoot);
  await writeFile(
    path.join(root, "titan-config.lua"),
    'include = { "." }\nsource_module_roots = { "." }\n',
    "utf8"
  );
  await writeFile(
    path.join(moduleRoot, "sample.titan"),
    "function answer(): integer return 42 end\n",
    "utf8"
  );
  await writeFile(
    path.join(moduleRoot, "part.titan"),
    "function doubled(): integer return answer() * 2 end\n",
    "utf8"
  );

  const child = launch(root, "debug");
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    await request(child, responses, 1, "initialize", {});
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));
    await waitForIndexing(responses);
    assert.ok(
      responses.lastIndexingProgress.some((status) =>
        status.completed_files === 0 && status.total_files === 2
      ),
      "cold folder-module index did not announce its two saved files"
    );
    const finalProgress = responses.lastIndexingProgress.at(-1);
    assert.ok(finalProgress, "cold folder-module index emitted no progress");
    assert.equal(finalProgress.completed_files, 2);
    assert.equal(finalProgress.total_files, 2);

    const shutdown = await request(
      child,
      responses,
      "shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await awaitExit(exit), { code: 0, signal: null });
    await responses.finish();
    assert.equal(responses.buffer.length, 0, "debug logs polluted stdout");

    const records = structuredLogRecords(stderr());
    const serverStart = records.find((record) => record.event === "server.start");
    assert.ok(serverStart, "debug session lacked server.start");
    assert.equal(serverStart.log_level, "debug");

    const chainIndex = records.findIndex(
      (record) => record.event === "indexing.chain.start"
    );
    assert.ok(chainIndex >= 0, "debug session lacked indexing.chain.start");
    const chain = records[chainIndex];
    assert.equal(chain.level, "info");
    assert.ok(Number.isInteger(chain.chain));
    assert.equal(chain.reason, "initialized");
    assert.ok(Number.isInteger(chain.epoch));
    assert.equal(chain.initial, true);

    const startIndex = records.findIndex(
      (record) => record.event === "compiler.attempt.start"
    );
    assert.ok(startIndex > chainIndex, "compiler attempt preceded indexing start");
    const start = records[startIndex];
    assert.equal(start.level, "debug");
    assert.ok(Number.isInteger(start.attempt));
    assert.equal(start.root_module, "sample");

    const completeIndex = records.findIndex((record, index) =>
      index > startIndex &&
      record.event === "compiler.attempt.end" &&
      record.attempt === start.attempt
    );
    assert.ok(completeIndex > startIndex, "compiler attempt never completed");
    const complete = records[completeIndex];
    assert.equal(complete.level, "debug");
    assert.equal(complete.root_module, start.root_module);
    assert.equal(complete.outcome, "complete");
    assert.ok(Number.isInteger(complete.checked_modules));
    assert.ok(Number.isInteger(complete.completed_modules));
    assert.ok(Number.isFinite(complete.wall_ms));
    assert.ok(complete.wall_ms >= 0);

    const progress = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) =>
        record.event === "compiler.module.complete" &&
        record.attempt === start.attempt
      );
    assert.equal(
      progress.length,
      complete.completed_modules,
      "progress records were not bounded by the attempt summary"
    );
    assert.equal(
      progress.length,
      complete.checked_modules,
      "compiler did not emit one progress record per completed source module"
    );
    assert.ok(progress.length > 0, "compiler attempt emitted no progress");
    for (let index = 0; index < progress.length; index += 1) {
      const entry = progress[index];
      assert.ok(
        entry.index > startIndex && entry.index < completeIndex,
        "compiler progress was outside its attempt boundary"
      );
      assert.equal(entry.record.level, "debug");
      assert.equal(entry.record.root_module, start.root_module);
      assert.equal(typeof entry.record.module_name, "string");
      assert.equal(entry.record.completed_modules, index + 1);
      assert.ok(Number.isFinite(entry.record.wall_ms));
      assert.ok(entry.record.wall_ms >= 0);
      assert.ok(Number.isFinite(entry.record.cpu_ms));
      assert.ok(entry.record.cpu_ms >= 0);
    }
    assert.equal(progress.at(-1).record.module_name, "sample");

    const chainCompleteIndex = records.findIndex((record, index) =>
      index > completeIndex &&
      record.event === "indexing.chain.complete" &&
      record.chain === chain.chain
    );
    assert.ok(
      chainCompleteIndex > completeIndex,
      "initial indexing chain lacked a matching terminal record"
    );
    const chainComplete = records[chainCompleteIndex];
    assert.equal(chainComplete.level, "info");
    assert.equal(chainComplete.reason, "initialized");
    assert.equal(chainComplete.outcome, "ready");
    assert.equal(chainComplete.message, undefined);
    assert.equal(chainComplete.initial, true);
    assert.ok(Number.isInteger(chainComplete.attempted_epoch));
    assert.ok(Number.isInteger(chainComplete.completed_epoch));
    assert.ok(Number.isInteger(chainComplete.pending_epoch));
    assert.ok(Number.isInteger(chainComplete.passes));
    assert.ok(chainComplete.passes >= 1);
    assert.ok(Number.isFinite(chainComplete.wall_ms));
    assert.ok(chainComplete.wall_ms >= 0);
    assert.ok(Number.isFinite(chainComplete.cpu_ms));
    assert.ok(chainComplete.cpu_ms >= 0);
    assert.ok(Number.isInteger(chainComplete.generation));
  } catch (cause) {
    const diagnostic = stderr().toString("utf8").trim();
    throw new Error(
      `${cause.message}${diagnostic.length > 0 ? `; stderr: ${diagnostic}` : ""}`,
      { cause }
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testTruncatedFrame() {
  const child = launch(process.cwd(), "error");
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exit = exitOf(child);
  try {
    child.stdin.end(Buffer.from("Content-Length: 10\r\n\r\n{}", "ascii"));
    assert.deepEqual(await awaitExit(exit), { code: 1, signal: null });
    assert.equal(stdout().length, 0, "truncated input polluted stdout");
    const diagnostic = stderr().toString("utf8");
    assert.match(diagnostic, /^titan-language-server \{[^\n]+\}\n$/);
    const record = JSON.parse(
      diagnostic.trimEnd().slice("titan-language-server ".length)
    );
    assert.equal(record.level, "error");
    assert.equal(record.event, "server.failure");
    assert.match(record.message, /unexpected EOF in LSP frame/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

await testLuaModulePathConfiguration();
if (mode === "--self-contained-smoke") {
  await testSelfContainedCompilerModules();
  console.log("self-contained compiler-module protocol smoke passed");
} else {
  await testCoalescedIndexingResetStatus();
  await testLifecycle();
  await testSavedProjectSemantics();
  await testConfigCannotWriteProtocolStdout();
  await testSourceImportCppflagsAndUnchangedRequests();
  await testCrossModuleFolderAndIncrementalSemantics();
  await testDebugCompilerProgress();
  await testTruncatedFrame();
  console.log("native server protocol transcript passed");
}
