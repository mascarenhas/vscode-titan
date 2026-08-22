#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 2_000;
const INDEXING_STATUS_METHOD = "titan/indexingStatus";
const BENCHMARK_FILE = "src/server/application.titan";
const BENCHMARK_MARKER = 'self:start_refresh(true, "semantic_request")';
const BENCHMARK_SYMBOL = "start_refresh";
const LOG_LEVELS = new Set(["off", "error", "info", "debug", "trace"]);

class BenchmarkError extends Error {}

function usage() {
  return [
    "usage: node scripts/benchmark-server.mjs [options]",
    "",
    "options:",
    "  --server PATH       native server (default: bin/titan-language-server)",
    "  --root PATH         vscode-titan workspace (default: repository root)",
    "  --log-level LEVEL   server log emission (default: debug, like VS Code)",
    `  --timeout-ms N      indexing/message timeout (default: ${DEFAULT_TIMEOUT_MS})`,
    "  --help              show this help"
  ].join("\n");
}

function parseArguments(argv) {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const options = {
    root: repositoryRoot,
    server: undefined,
    logLevel: "debug",
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--server" || argument === "--root" ||
        argument === "--log-level" ||
        argument === "--timeout-ms") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new BenchmarkError(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--server") {
        options.server = value;
      } else if (argument === "--root") {
        options.root = path.resolve(value);
      } else if (argument === "--log-level") {
        if (!LOG_LEVELS.has(value)) {
          throw new BenchmarkError(
            "--log-level must be off, error, info, debug, or trace"
          );
        }
        options.logLevel = value;
      } else {
        const timeoutMs = Number(value);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
          throw new BenchmarkError("--timeout-ms must be a positive integer");
        }
        options.timeoutMs = timeoutMs;
      }
      continue;
    }
    throw new BenchmarkError(`unknown argument: ${argument}`);
  }

  options.root = path.resolve(options.root);
  options.server = path.resolve(
    options.server ?? path.join(options.root, "bin", "titan-language-server")
  );
  return options;
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
}

function withTimeout(promise, description, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new BenchmarkError(`timed out waiting for ${description}`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FrameReader {
  constructor(stream, timeoutMs) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
  }

  async read(description) {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0) {
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const headers = new Map();
        for (const line of header.split("\r\n")) {
          const separator = line.indexOf(":");
          if (separator <= 0) {
            throw new BenchmarkError(`malformed LSP response header: ${line}`);
          }
          const name = line.slice(0, separator).trim().toLowerCase();
          const value = line.slice(separator + 1).trim();
          if (headers.has(name)) {
            throw new BenchmarkError(`duplicate LSP response header: ${name}`);
          }
          headers.set(name, value);
        }
        const rawLength = headers.get("content-length");
        if (rawLength === undefined || !/^[0-9]+$/.test(rawLength)) {
          throw new BenchmarkError("LSP response omitted a valid Content-Length");
        }
        const length = Number(rawLength);
        if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
          throw new BenchmarkError(`invalid LSP response length: ${rawLength}`);
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length >= bodyEnd) {
          const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
          this.buffer = this.buffer.subarray(bodyEnd);
          let message;
          try {
            message = JSON.parse(body);
          } catch (cause) {
            throw new BenchmarkError(`invalid JSON-RPC response: ${cause.message}`);
          }
          if (typeof message !== "object" || message === null ||
              Array.isArray(message) || message.jsonrpc !== "2.0") {
            throw new BenchmarkError("server emitted an invalid JSON-RPC envelope");
          }
          return message;
        }
      } else if (this.buffer.length > MAX_FRAME_BYTES) {
        throw new BenchmarkError("LSP response header exceeded the frame limit");
      }

      const next = await withTimeout(
        this.iterator.next(),
        description,
        this.timeoutMs
      );
      if (next.done) {
        throw new BenchmarkError(
          `server stdout closed with ${this.buffer.length} pending bytes`
        );
      }
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }
}

class ProtocolClient {
  constructor(child, timeoutMs) {
    this.child = child;
    this.reader = new FrameReader(child.stdout, timeoutMs);
    this.timeoutMs = timeoutMs;
    this.responses = new Map();
    this.statuses = [];
    this.inputError = undefined;
    // EPIPE is reported asynchronously when the server exits. Retain it for a
    // useful synchronous failure on the next write instead of letting Node
    // treat it as an unhandled stream error.
    child.stdin.on("error", (cause) => { this.inputError = cause; });
  }

  write(payload) {
    if (this.inputError !== undefined) {
      throw new BenchmarkError(
        `cannot write to server stdin: ${this.inputError.message}`
      );
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new BenchmarkError(
        "server stdin closed before the benchmark completed"
      );
    }
    try {
      // Node retains the complete Buffer in order if this reports
      // backpressure. These bounded messages are intentionally not split.
      this.child.stdin.write(payload);
    } catch (cause) {
      throw new BenchmarkError(`cannot write to server stdin: ${cause.message}`);
    }
  }

  send(message) {
    this.write(frame(message));
  }

  sendTogether(messages) {
    this.write(Buffer.concat(messages.map(frame)));
  }

  async pumpUntil(predicate, description) {
    while (!predicate()) {
      const message = await this.reader.read(description);
      this.ingest(message, performance.now());
    }
  }

  async response(id, description) {
    await this.pumpUntil(() => this.responses.has(id), description);
    const response = this.responses.get(id);
    this.responses.delete(id);
    if (response.message.error !== undefined) {
      const error = response.message.error;
      const detail = typeof error?.message === "string"
        ? error.message
        : JSON.stringify(error);
      throw new BenchmarkError(`${description} failed: ${detail}`);
    }
    if (!("result" in response.message)) {
      throw new BenchmarkError(`${description} omitted its result`);
    }
    return {
      result: response.message.result,
      receivedAt: response.receivedAt
    };
  }

  ingest(message, receivedAt) {
    if (message.id !== undefined) {
      if (message.method !== undefined) {
        throw new BenchmarkError("benchmark client does not accept server requests");
      }
      if (this.responses.has(message.id)) {
        throw new BenchmarkError(`duplicate JSON-RPC response id: ${message.id}`);
      }
      this.responses.set(message.id, { message, receivedAt });
      return;
    }

    if (typeof message.method !== "string") {
      throw new BenchmarkError("server emitted an id-less non-notification");
    }
    if (message.method === INDEXING_STATUS_METHOD) {
      this.statuses.push(validateIndexingStatus(message.params, receivedAt));
    }
  }
}

function validateIndexingStatus(value, receivedAt) {
  const hasCompletedFiles = value?.completed_files !== undefined;
  const hasTotalFiles = value?.total_files !== undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !["indexing", "ready", "failed"].includes(value.state) ||
      typeof value.initial !== "boolean" ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
      (value.generation !== undefined &&
       (!Number.isSafeInteger(value.generation) || value.generation < 0)) ||
      (value.message !== undefined && typeof value.message !== "string") ||
      hasCompletedFiles !== hasTotalFiles ||
      (hasCompletedFiles &&
       (value.state !== "indexing" ||
        !Number.isSafeInteger(value.completed_files) ||
        value.completed_files < 0 ||
        !Number.isSafeInteger(value.total_files) ||
        value.total_files < 0 ||
        value.completed_files > value.total_files))) {
    throw new BenchmarkError(`invalid ${INDEXING_STATUS_METHOD} notification`);
  }
  return {
    state: value.state,
    initial: value.initial,
    epoch: value.epoch,
    generation: value.generation,
    message: value.message,
    completedFiles: value.completed_files,
    totalFiles: value.total_files,
    receivedAt
  };
}

function responseAt(client, id) {
  return client.responses.get(id);
}

function indexingCycleAfter(client, startIndex, initial, subject) {
  const statuses = client.statuses.slice(startIndex);
  if (statuses.length === 0) return undefined;
  const indexing = statuses[0];
  if (indexing.state !== "indexing" || indexing.initial !== initial) {
    throw new BenchmarkError(`${subject} did not begin with its busy status`);
  }
  let terminal;
  const progress = [];
  for (let index = 0; index < statuses.length; index += 1) {
    const status = statuses[index];
    if (status.state === "indexing") {
      if (terminal !== undefined || status.initial !== indexing.initial ||
          status.epoch < indexing.epoch) {
        throw new BenchmarkError(`${subject} emitted an invalid status sequence`);
      }
      progress.push(status);
    } else {
      if (terminal !== undefined || status.initial !== indexing.initial ||
          status.epoch < indexing.epoch) {
        throw new BenchmarkError(`${subject} emitted an invalid status sequence`);
      }
      terminal = status;
    }
  }
  if (terminal === undefined) return undefined;
  if (terminal.state === "failed") {
    throw new BenchmarkError(
      `${subject} failed${terminal.message ? `: ${terminal.message}` : ""}`
    );
  }
  if (!Number.isSafeInteger(terminal.generation)) {
    throw new BenchmarkError(`${subject} ready status omitted its generation`);
  }
  return { indexing, progress, ready: terminal };
}

function progressSummary(cycle) {
  const updates = cycle.progress.filter(
    (status) => status.completedFiles !== undefined
  );
  const latest = updates.at(-1);
  return {
    updates: updates.length,
    completedFiles: latest?.completedFiles,
    totalFiles: latest?.totalFiles
  };
}

async function validateInputs(options) {
  const serverInfo = await stat(options.server).catch(() => undefined);
  if (serverInfo === undefined || !serverInfo.isFile()) {
    throw new BenchmarkError(`native server does not exist: ${options.server}`);
  }
  await access(options.server, fsConstants.X_OK).catch(() => {
    throw new BenchmarkError(`native server is not executable: ${options.server}`);
  });
  const rootInfo = await stat(options.root).catch(() => undefined);
  if (rootInfo === undefined || !rootInfo.isDirectory()) {
    throw new BenchmarkError(`workspace root is not a directory: ${options.root}`);
  }
}

async function benchmarkTarget(root) {
  const filename = path.join(root, BENCHMARK_FILE);
  const source = await readFile(filename, "utf8").catch((cause) => {
    throw new BenchmarkError(`cannot read benchmark target ${filename}: ${cause.message}`);
  });
  const markerOffset = source.indexOf(BENCHMARK_MARKER);
  if (markerOffset < 0 || source.indexOf(BENCHMARK_MARKER, markerOffset + 1) >= 0) {
    throw new BenchmarkError(
      `${BENCHMARK_FILE} must contain exactly one ${BENCHMARK_MARKER}`
    );
  }
  const symbolOffset = markerOffset + BENCHMARK_MARKER.indexOf(BENCHMARK_SYMBOL);
  const preceding = source.slice(0, symbolOffset);
  const newline = preceding.lastIndexOf("\n");
  return {
    filename,
    relativeFile: BENCHMARK_FILE,
    uri: pathToFileURL(filename).href,
    symbol: BENCHMARK_SYMBOL,
    position: {
      line: preceding.split("\n").length - 1,
      // JavaScript string length is exactly the UTF-16 code-unit count LSP uses.
      character: preceding.slice(newline + 1).length
    }
  };
}

function clockTicksPerSecond() {
  if (process.platform !== "linux") return undefined;
  const result = spawnSync("getconf", ["CLK_TCK"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const ticks = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isFinite(ticks) || ticks <= 0) {
    throw new BenchmarkError("cannot determine Linux process clock tick rate");
  }
  return ticks;
}

async function processSample(pid, ticksPerSecond) {
  if (process.platform !== "linux" || ticksPerSecond === undefined) {
    return { cpuMs: undefined, peakRssKiB: undefined };
  }
  const [rawStat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/status`, "utf8")
  ]).catch((cause) => {
    throw new BenchmarkError(`cannot sample server process ${pid}: ${cause.message}`);
  });
  const commandEnd = rawStat.lastIndexOf(")");
  if (commandEnd < 0) {
    throw new BenchmarkError("malformed Linux process stat record");
  }
  const fields = rawStat.slice(commandEnd + 1).trim().split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const rssMatch = /^VmHWM:\s+([0-9]+)\s+kB$/m.exec(status);
  if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks) ||
      rssMatch === null) {
    throw new BenchmarkError("Linux process resource record is incomplete");
  }
  return {
    cpuMs: (userTicks + systemTicks) * 1000 / ticksPerSecond,
    peakRssKiB: Number(rssMatch[1])
  };
}

function createProcessOutcome(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function collectStderr(stream, maximumBytes = 64 * 1024) {
  let contents = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    contents = Buffer.concat([contents, chunk]);
    if (contents.length > maximumBytes) {
      contents = contents.subarray(contents.length - maximumBytes);
    }
  });
  return () => contents.toString("utf8").trim();
}

async function startServer(options) {
  const child = spawn(options.server, [], {
    cwd: options.root,
    env: {
      ...process.env,
      TITAN_LANGUAGE_SERVER_LOG_LEVEL: options.logLevel
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (cause) => reject(
      new BenchmarkError(`cannot launch native server: ${cause.message}`)
    ));
  });
  await withTimeout(spawned, "native server startup", options.timeoutMs);
  return child;
}

async function terminateOwnedChild(child, outcome) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await outcome;
    return;
  }
  child.stdin.destroy();
  child.kill("SIGTERM");
  try {
    await withTimeout(outcome, "owned server termination", TERMINATION_GRACE_MS);
    return;
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await withTimeout(outcome, "owned server exit after SIGKILL", TERMINATION_GRACE_MS);
}

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function definitionSummary(result, target) {
  const location = Array.isArray(result) ? result[0] : result;
  const start = location?.range?.start;
  return {
    found: location !== null && typeof location === "object",
    sameFile: location?.uri === target.uri,
    line: Number.isSafeInteger(start?.line) ? start.line : undefined,
    character: Number.isSafeInteger(start?.character)
      ? start.character
      : undefined
  };
}

async function benchmark(options) {
  await validateInputs(options);
  const target = await benchmarkTarget(options.root);
  const ticksPerSecond = clockTicksPerSecond();
  const child = await startServer(options);
  const outcome = createProcessOutcome(child);
  const stderr = collectStderr(child.stderr);
  const client = new ProtocolClient(child, options.timeoutMs);
  let exitedCleanly = false;

  try {
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        clientInfo: { name: "vscode-titan-benchmark", version: "1" },
        rootPath: options.root,
        rootUri: pathToFileURL(options.root).href,
        capabilities: { general: { positionEncodings: ["utf-16"] } },
        workspaceFolders: [{
          uri: pathToFileURL(options.root).href,
          name: path.basename(options.root)
        }]
      }
    });
    const initialize = await client.response(1, "initialize response");
    if (initialize.result?.capabilities?.positionEncoding !== "utf-16") {
      throw new BenchmarkError("server did not negotiate UTF-16 positions");
    }

    const coldStartResources = await processSample(child.pid, ticksPerSecond);
    const coldSentAt = performance.now();
    const initialStatusStart = client.statuses.length;
    client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await client.pumpUntil(() => {
      const status = client.statuses[initialStatusStart];
      return status !== undefined;
    }, "cold indexing busy status");
    const observedInitial = client.statuses[initialStatusStart];
    if (observedInitial.state !== "indexing" || !observedInitial.initial) {
      throw new BenchmarkError("cold indexing did not begin with its busy status");
    }

    const immediateHoverSentAt = performance.now();
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: target.uri },
        position: target.position
      }
    });

    await client.pumpUntil(() => {
      const cycle = indexingCycleAfter(
        client, initialStatusStart, true, "cold indexing"
      );
      return responseAt(client, 2) !== undefined &&
        cycle !== undefined;
    }, "cold indexing and immediate hover");
    const immediateHover = await client.response(2, "immediate hover response");
    const initialCycle = indexingCycleAfter(
      client, initialStatusStart, true, "cold indexing"
    );
    if (initialCycle === undefined) {
      throw new BenchmarkError("cold indexing omitted its terminal status");
    }
    const initialIndexing = initialCycle.indexing;
    const initialReady = initialCycle.ready;
    const coldEndResources = await processSample(child.pid, ticksPerSecond);
    if (immediateHover.result !== null) {
      throw new BenchmarkError(
        "immediate hover unexpectedly returned data during initial indexing"
      );
    }
    if (immediateHoverSentAt < initialIndexing.receivedAt) {
      throw new BenchmarkError(
        "immediate hover was sent before the busy status was observed"
      );
    }
    if (immediateHover.receivedAt < initialIndexing.receivedAt ||
        immediateHover.receivedAt >= initialReady.receivedAt) {
      throw new BenchmarkError(
        "immediate hover did not complete within the observed indexing interval"
      );
    }
    if (initialReady.epoch !== initialIndexing.epoch) {
      throw new BenchmarkError(
        "workspace changed while measuring cold indexing"
      );
    }

    const refreshStatusStart = client.statuses.length;
    const refreshStartResources = await processSample(child.pid, ticksPerSecond);
    const readyQueriesSentAt = performance.now();
    client.sendTogether([
      {
        jsonrpc: "2.0",
        id: 3,
        method: "textDocument/hover",
        params: {
          textDocument: { uri: target.uri },
          position: target.position
        }
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "textDocument/definition",
        params: {
          textDocument: { uri: target.uri },
          position: target.position
        }
      }
    ]);

    await client.pumpUntil(() => {
      const cycle = indexingCycleAfter(
        client, refreshStatusStart, false, "unchanged refresh"
      );
      return responseAt(client, 3) !== undefined &&
        responseAt(client, 4) !== undefined &&
        cycle !== undefined;
    }, "ready queries and unchanged refresh");
    const readyHover = await client.response(3, "ready hover response");
    const definition = await client.response(4, "method definition response");
    const refreshCycle = indexingCycleAfter(
      client, refreshStatusStart, false, "unchanged refresh"
    );
    if (refreshCycle === undefined) {
      throw new BenchmarkError("unchanged refresh omitted its terminal status");
    }
    const refreshIndexing = refreshCycle.indexing;
    const refreshReady = refreshCycle.ready;
    if (readyHover.receivedAt < refreshIndexing.receivedAt ||
        definition.receivedAt < refreshIndexing.receivedAt) {
      throw new BenchmarkError(
        "ready queries completed before the observed refresh began"
      );
    }
    if (refreshReady.epoch !== refreshIndexing.epoch) {
      throw new BenchmarkError(
        "workspace changed while measuring the unchanged refresh"
      );
    }
    if (refreshReady.generation !== initialReady.generation) {
      throw new BenchmarkError(
        "workspace generation changed while measuring the unchanged refresh"
      );
    }
    if (readyHover.result === null) {
      throw new BenchmarkError("ready hover returned no data at the benchmark target");
    }
    const summarizedDefinition = definitionSummary(definition.result, target);
    if (!summarizedDefinition.found) {
      throw new BenchmarkError(
        "method definition returned no location at the benchmark target"
      );
    }
    const refreshEndResources = await processSample(child.pid, ticksPerSecond);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "shutdown",
      params: null
    });
    await withTimeout(
      client.response(5, "shutdown response"),
      "shutdown response",
      SHUTDOWN_TIMEOUT_MS
    );
    client.send({ jsonrpc: "2.0", method: "exit" });
    child.stdin.end();
    const exit = await withTimeout(
      outcome,
      "clean server exit",
      SHUTDOWN_TIMEOUT_MS
    );
    exitedCleanly = exit.code === 0 && exit.signal === null;
    if (!exitedCleanly) {
      throw new BenchmarkError(
        `server exited with code ${exit.code} and signal ${exit.signal}`
      );
    }

    const cpuDelta = coldEndResources.cpuMs === undefined ||
      coldStartResources.cpuMs === undefined
      ? undefined
      : coldEndResources.cpuMs - coldStartResources.cpuMs;
    const refreshCpuDelta = refreshEndResources.cpuMs === undefined ||
      refreshStartResources.cpuMs === undefined
      ? undefined
      : refreshEndResources.cpuMs - refreshStartResources.cpuMs;
    return {
      server: options.server,
      workspace: options.root,
      logLevel: options.logLevel,
      target: {
        file: target.relativeFile,
        symbol: target.symbol,
        position: target.position
      },
      coldIndex: {
        wallMs: roundMilliseconds(initialReady.receivedAt - coldSentAt),
        childCpuMs: cpuDelta === undefined
          ? undefined
          : roundMilliseconds(cpuDelta),
        peakRssKiB: coldEndResources.peakRssKiB,
        epoch: initialReady.epoch,
        generation: initialReady.generation,
        progress: progressSummary(initialCycle)
      },
      immediateHover: {
        latencyMs: roundMilliseconds(
          immediateHover.receivedAt - immediateHoverSentAt
        ),
        completedBeforeReady: immediateHover.receivedAt < initialReady.receivedAt,
        returnedNoData: immediateHover.result === null
      },
      readyHover: {
        latencyMs: roundMilliseconds(readyHover.receivedAt - readyQueriesSentAt),
        hasResult: readyHover.result !== null
      },
      methodDefinition: {
        latencyMs: roundMilliseconds(definition.receivedAt - readyQueriesSentAt),
        ...summarizedDefinition
      },
      unchangedRefresh: {
        wallMs: roundMilliseconds(
          refreshReady.receivedAt - readyQueriesSentAt
        ),
        childCpuMs: refreshCpuDelta === undefined
          ? undefined
          : roundMilliseconds(refreshCpuDelta),
        epoch: refreshReady.epoch,
        generation: refreshReady.generation,
        progress: progressSummary(refreshCycle)
      }
    };
  } catch (cause) {
    const diagnostics = stderr();
    if (diagnostics.length > 0 && cause instanceof Error) {
      cause.message = `${cause.message}; server stderr: ${diagnostics}`;
    }
    throw cause;
  } finally {
    if (!exitedCleanly) {
      await terminateOwnedChild(child, outcome).catch(() => undefined);
    }
  }
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
  const result = await benchmark(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
