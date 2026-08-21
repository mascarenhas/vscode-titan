#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const OPERATIONS = new Set([
  "definition",
  "references",
  "hover",
  "folding",
  "rename-preview"
]);
const POSITION_OPERATIONS = new Set([
  "definition",
  "references",
  "hover",
  "rename-preview"
]);
const MAX_LSP_INTEGER = 2_147_483_647;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TERMINATION_GRACE_MS = 1_000;

let activeChild;
let interruptedSignal;
let interruptTimer;

class QueryError extends Error {
  constructor(code, message, exitCode = 1, details = undefined) {
    super(message);
    this.name = "QueryError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function invalidArguments(message) {
  return new QueryError("invalid_arguments", message, 2);
}

function interruptionError() {
  const signal = interruptedSignal ?? "termination signal";
  const exitCode = signal === "SIGINT" ? 130 : 143;
  return new QueryError("interrupted", `received ${signal}`, exitCode);
}

function clearInterruptTimer() {
  if (interruptTimer !== undefined) {
    clearTimeout(interruptTimer);
    interruptTimer = undefined;
  }
}

function terminateActiveChild(signal) {
  if (activeChild === undefined ||
      activeChild.exitCode !== null || activeChild.signalCode !== null) {
    return;
  }
  activeChild.kill(signal);
  if (interruptTimer === undefined) {
    interruptTimer = setTimeout(() => {
      if (activeChild !== undefined &&
          activeChild.exitCode === null && activeChild.signalCode === null) {
        activeChild.kill("SIGKILL");
      }
    }, TERMINATION_GRACE_MS);
    interruptTimer.unref();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedSignal === undefined) interruptedSignal = signal;
    terminateActiveChild(signal);
  });
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
}

function withTimeout(promise, description, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new QueryError(
      "timeout",
      `timed out waiting for ${description}`
    )), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FrameReader {
  constructor(stream, timeoutMs) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.timeoutMs = timeoutMs;
  }

  async read(description) {
    while (true) {
      const message = this.extract();
      if (message !== undefined) return message;

      const next = await withTimeout(
        this.iterator.next(),
        description,
        this.timeoutMs
      );
      if (next.done) {
        throw new QueryError(
          "protocol_error",
          `language-server stdout ended with ${this.buffer.length} pending bytes`
        );
      }
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }

  extract() {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return undefined;

    const header = this.buffer.subarray(0, headerEnd).toString("ascii");
    let contentLength;
    for (const line of header.split("\r\n")) {
      const match = /^Content-Length:\s*([0-9]+)\s*$/i.exec(line);
      if (!match) continue;
      if (contentLength !== undefined) {
        throw new QueryError(
          "protocol_error",
          "language server sent duplicate Content-Length headers"
        );
      }
      contentLength = Number(match[1]);
    }
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new QueryError(
        "protocol_error",
        "language server sent a frame without a valid Content-Length header"
      );
    }
    if (contentLength > MAX_FRAME_BYTES) {
      throw new QueryError(
        "protocol_error",
        `language-server frame exceeds ${MAX_FRAME_BYTES} bytes`
      );
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) return undefined;

    const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    try {
      const message = JSON.parse(body);
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        throw new Error("message is not an object");
      }
      return message;
    } catch (cause) {
      throw new QueryError(
        "protocol_error",
        `language server sent invalid JSON: ${cause.message}`
      );
    }
  }
}

function parseInteger(value, flag, maximum = MAX_LSP_INTEGER) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw invalidArguments(`${flag} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw invalidArguments(`${flag} must not exceed ${maximum}`);
  }
  return parsed;
}

function requireText(value, flag) {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidArguments(`${flag} requires a nonempty value`);
  }
  if (value.includes("\0")) {
    throw invalidArguments(`${flag} must not contain a NUL byte`);
  }
  return value;
}

function parseArguments(argv) {
  if (argv.length === 0) {
    throw invalidArguments(
      "expected an operation: definition, references, hover, folding, or rename-preview"
    );
  }
  const operation = argv[0];
  if (!OPERATIONS.has(operation)) {
    throw invalidArguments(`unsupported operation ${JSON.stringify(operation)}`);
  }

  const values = new Map();
  const serverArguments = [];
  const knownFlags = new Set([
    "--root",
    "--file",
    "--line",
    "--character",
    "--new-name",
    "--server",
    "--server-arg",
    "--timeout-ms"
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!knownFlags.has(flag)) {
      throw invalidArguments(`unknown option ${JSON.stringify(flag)}`);
    }
    if (index + 1 >= argv.length) {
      throw invalidArguments(`${flag} requires a value`);
    }
    const value = requireText(argv[index + 1], flag);
    index += 1;
    if (flag === "--server-arg") {
      serverArguments.push(value);
    } else {
      if (values.has(flag)) {
        throw invalidArguments(`${flag} may be specified only once`);
      }
      values.set(flag, value);
    }
  }

  for (const flag of ["--root", "--file"]) {
    if (!values.has(flag)) throw invalidArguments(`${flag} is required`);
  }
  const hasPosition = POSITION_OPERATIONS.has(operation);
  for (const flag of ["--line", "--character"]) {
    if (hasPosition && !values.has(flag)) {
      throw invalidArguments(`${flag} is required for ${operation}`);
    }
    if (!hasPosition && values.has(flag)) {
      throw invalidArguments(`${flag} is not valid for ${operation}`);
    }
  }
  if (operation === "rename-preview") {
    if (!values.has("--new-name")) {
      throw invalidArguments("--new-name is required for rename-preview");
    }
  } else if (values.has("--new-name")) {
    throw invalidArguments(`--new-name is not valid for ${operation}`);
  }

  return {
    operation,
    rootInput: values.get("--root"),
    fileInput: values.get("--file"),
    line: hasPosition ? parseInteger(values.get("--line"), "--line") : undefined,
    character: hasPosition
      ? parseInteger(values.get("--character"), "--character")
      : undefined,
    newName: values.get("--new-name"),
    server: values.get("--server") ?? "titan-language-server",
    serverArguments,
    timeoutMs: values.has("--timeout-ms")
      ? parseInteger(values.get("--timeout-ms"), "--timeout-ms", 120_000)
      : DEFAULT_TIMEOUT_MS
  };
}

async function statOrInputError(filename, description) {
  try {
    return await stat(filename);
  } catch (cause) {
    throw new QueryError(
      "invalid_input",
      `${description} is not accessible: ${cause.message}`,
      2
    );
  }
}

function positionSplitsSurrogate(line, character) {
  if (character === 0 || character === line.length) return false;
  const previous = line.charCodeAt(character - 1);
  const current = line.charCodeAt(character);
  return previous >= 0xD800 && previous <= 0xDBFF &&
    current >= 0xDC00 && current <= 0xDFFF;
}

async function validateInputs(options) {
  requireText(options.server, "--server");
  if (options.timeoutMs < 100) {
    throw invalidArguments("--timeout-ms must be at least 100");
  }

  const root = path.resolve(options.rootInput);
  const rootStats = await statOrInputError(root, "project root");
  if (!rootStats.isDirectory()) {
    throw new QueryError("invalid_input", "project root must be a directory", 2);
  }

  const file = path.isAbsolute(options.fileInput)
    ? path.resolve(options.fileInput)
    : path.resolve(root, options.fileInput);
  const relativeFile = path.relative(root, file);
  if (relativeFile === "" || relativeFile === ".." ||
      relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) {
    throw new QueryError(
      "invalid_input",
      "--file must identify a file inside --root",
      2
    );
  }
  if (path.extname(file) !== ".titan") {
    throw new QueryError("invalid_input", "--file must end in .titan", 2);
  }
  const fileStats = await statOrInputError(file, "Titan source file");
  if (!fileStats.isFile()) {
    throw new QueryError("invalid_input", "Titan source file must be a regular file", 2);
  }

  let source;
  try {
    const bytes = await readFile(file);
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new QueryError(
      "invalid_input",
      `Titan source file is not readable UTF-8: ${cause.message}`,
      2
    );
  }

  if (POSITION_OPERATIONS.has(options.operation)) {
    const lines = source.split(/\r\n|\n|\r/);
    if (options.line >= lines.length) {
      throw new QueryError(
        "invalid_input",
        `--line ${options.line} is outside the saved file`,
        2
      );
    }
    const selectedLine = lines[options.line];
    if (options.character > selectedLine.length) {
      throw new QueryError(
        "invalid_input",
        `--character ${options.character} is outside saved line ${options.line}`,
        2
      );
    }
    if (positionSplitsSurrogate(selectedLine, options.character)) {
      throw new QueryError(
        "invalid_input",
        "--character must not split a UTF-16 surrogate pair",
        2
      );
    }
  }

  if (options.newName !== undefined && /[\u0000-\u001F\u007F]/.test(options.newName)) {
    throw new QueryError(
      "invalid_input",
      "--new-name must not contain control characters",
      2
    );
  }

  return {
    ...options,
    root,
    file,
    uri: pathToFileURL(file).href
  };
}

async function writeMessage(child, message) {
  if (!child.stdin.writable) {
    throw new QueryError("server_exit", "language-server stdin is closed");
  }
  const payload = frame(message);
  await new Promise((resolve, reject) => {
    child.stdin.write(payload, (cause) => cause ? reject(cause) : resolve());
  }).catch((cause) => {
    throw new QueryError(
      "server_exit",
      `could not write to language server: ${cause.message}`
    );
  });
}

async function request(child, reader, id, method, params) {
  await writeMessage(child, { jsonrpc: "2.0", id, method, params });
  while (true) {
    const message = await reader.read(`${method} response`);
    if (message.id === undefined) {
      if (typeof message.method === "string") continue;
      throw new QueryError(
        "protocol_error",
        `language server sent an unexpected message during ${method}`
      );
    }
    if (message.id !== id) {
      throw new QueryError(
        "protocol_error",
        `language server responded with unexpected id ${JSON.stringify(message.id)}`
      );
    }
    if (message.error !== undefined) {
      const error = message.error;
      const lspCode = error !== null && typeof error === "object"
        ? error.code
        : undefined;
      const lspMessage = error !== null && typeof error === "object" &&
        typeof error.message === "string"
        ? error.message
        : "language server returned an invalid error response";
      throw new QueryError(
        "lsp_error",
        lspMessage,
        1,
        Number.isInteger(lspCode) ? { lspCode } : undefined
      );
    }
    if (!("result" in message)) {
      throw new QueryError(
        "protocol_error",
        `language server omitted the result for ${method}`
      );
    }
    return message.result;
  }
}

function closedPromise(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function startedPromise(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      resolve();
    };
    const onError = (cause) => {
      child.off("spawn", onSpawn);
      reject(new QueryError(
        "server_start",
        `could not start language server: ${cause.message}`
      ));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function stopProcess(child, closed, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await withTimeout(
      closed,
      "language-server close",
      Math.min(timeoutMs, TERMINATION_GRACE_MS)
    );
    return;
  }
  child.kill("SIGTERM");
  try {
    await withTimeout(
      closed,
      "language-server termination",
      Math.min(timeoutMs, TERMINATION_GRACE_MS)
    );
    return;
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await withTimeout(
    closed,
    "language-server close after SIGKILL",
    TERMINATION_GRACE_MS
  );
}

async function query(options) {
  if (interruptedSignal !== undefined) throw interruptionError();
  const child = spawn(options.server, options.serverArguments, {
    cwd: options.root,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  activeChild = child;
  const closed = closedPromise(child);
  closed.then(() => {
    if (activeChild === child) activeChild = undefined;
    clearInterruptTimer();
  });
  if (interruptedSignal !== undefined) terminateActiveChild(interruptedSignal);
  const reader = new FrameReader(child.stdout, options.timeoutMs);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let initialized = false;
  let finished = false;
  let nextId = 1;
  try {
    await withTimeout(startedPromise(child), "language-server startup", options.timeoutMs);
    await request(child, reader, nextId, "initialize", {
      processId: process.pid,
      clientInfo: { name: "titan-lsp-query", version: "0.1.0" },
      rootPath: options.root,
      rootUri: pathToFileURL(options.root).href,
      capabilities: {},
      workspaceFolders: [{
        uri: pathToFileURL(options.root).href,
        name: path.basename(options.root)
      }]
    });
    nextId += 1;
    initialized = true;
    await writeMessage(child, { jsonrpc: "2.0", method: "initialized", params: {} });

    const textDocument = { uri: options.uri };
    const position = POSITION_OPERATIONS.has(options.operation)
      ? { line: options.line, character: options.character }
      : undefined;
    let method;
    let params;
    if (options.operation === "definition") {
      method = "textDocument/definition";
      params = { textDocument, position };
    } else if (options.operation === "references") {
      method = "textDocument/references";
      params = { textDocument, position, context: { includeDeclaration: true } };
    } else if (options.operation === "hover") {
      method = "textDocument/hover";
      params = { textDocument, position };
    } else if (options.operation === "folding") {
      method = "textDocument/foldingRange";
      params = { textDocument };
    } else {
      method = "textDocument/rename";
      params = { textDocument, position, newName: options.newName };
    }
    const queryId = nextId;
    nextId += 1;
    const result = await request(child, reader, queryId, method, params);

    await request(child, reader, nextId, "shutdown", null);
    await writeMessage(child, { jsonrpc: "2.0", method: "exit" });
    child.stdin.end();
    const outcome = await withTimeout(
      closed,
      "language-server exit",
      options.timeoutMs
    );
    finished = true;
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new QueryError(
        "server_exit",
        `language server exited with code ${outcome.code} and signal ${outcome.signal}`
      );
    }
    return result;
  } catch (cause) {
    if (interruptedSignal === undefined && initialized &&
        child.exitCode === null && child.signalCode === null) {
      try {
        await request(child, reader, nextId, "shutdown", null);
        await writeMessage(child, { jsonrpc: "2.0", method: "exit" });
        child.stdin.end();
        await withTimeout(closed, "language-server exit", Math.min(options.timeoutMs, 2_000));
        finished = true;
      } catch {
        // The original query failure is more useful; forced teardown follows.
      }
    }
    throw cause;
  } finally {
    if (!finished) await stopProcess(child, closed, options.timeoutMs);
  }
}

function errorPayload(cause) {
  const error = interruptedSignal !== undefined
    ? interruptionError()
    : cause instanceof QueryError
    ? cause
    : new QueryError("query_failed", cause instanceof Error ? cause.message : String(cause));
  return {
    exitCode: error.exitCode,
    payload: {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {})
      }
    }
  };
}

try {
  const options = await validateInputs(parseArguments(process.argv.slice(2)));
  if (interruptedSignal !== undefined) throw interruptionError();
  const result = await query(options);
  if (interruptedSignal !== undefined) throw interruptionError();
  const output = {
    ok: true,
    operation: options.operation,
    root: options.root,
    file: options.file,
    uri: options.uri,
    ...(POSITION_OPERATIONS.has(options.operation)
      ? { position: { line: options.line, character: options.character } }
      : {}),
    ...(options.operation === "rename-preview"
      ? { newName: options.newName, applied: false }
      : {}),
    result
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (cause) {
  const { exitCode, payload } = errorPayload(cause);
  process.stderr.write(`titan-lsp-query: ${payload.error.message}\n`);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = exitCode;
}
