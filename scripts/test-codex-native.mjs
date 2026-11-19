import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverArgument = process.argv[2];
if (!serverArgument) {
  console.error("usage: node scripts/test-codex-native.mjs PATH-TO-SERVER");
  process.exit(2);
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const server = path.resolve(serverArgument);
const projectRoot = repositoryRoot;
const relativeSourceFile = path.join(
  "src", "server", "application", "indexing_lifecycle.titan"
);
const sourceFile = path.join(projectRoot, relativeSourceFile);
const sourceLines = (await readFile(sourceFile, "utf8")).split("\n");
const callLine = sourceLines.findIndex((line) => line.includes("service:latest()"));
assert.ok(callLine >= 0, "workspace fixture has no Service:latest call");
const callCharacter = sourceLines[callLine].indexOf("latest") + 1;
const declarationFile = path.join(
  projectRoot, "src", "server", "project_service", "project_service.titan"
);
const declarationLines = (await readFile(declarationFile, "utf8")).split("\n");
const declarationLine = declarationLines.findIndex((line) =>
  line.includes("function Service:latest()")
);
assert.ok(declarationLine >= 0, "workspace fixture has no Service:latest declaration");
const declarationCharacter = declarationLines[declarationLine].indexOf("latest");
const query = path.join(
  repositoryRoot,
  "plugins",
  "titan-lsp",
  "skills",
  "titan-lsp-query",
  "scripts",
  "titan-lsp-query.mjs"
);

function withTimeout(promise, description, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      milliseconds
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const child = spawn(process.execPath, [
  query,
  "definition",
  "--root", projectRoot,
  "--file", relativeSourceFile,
  "--line", String(callLine),
  "--character", String(callCharacter),
  "--server", server,
  // A cold index of this repository takes about 260 s on the two-CPU CI
  // runner, so allow the adapter's maximum.
  "--timeout-ms", "600000"
], {
  cwd: repositoryRoot,
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    TITAN_LANGUAGE_SERVER_LOG_LEVEL: "off"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let closed = false;
const close = once(child, "close").then((status) => {
  closed = true;
  return status;
});

function terminate(signal) {
  if (closed) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (cause) {
    if (cause.code !== "ESRCH") throw cause;
  }
}

let interruptedSignal;
let resolveInterruption;
const interruption = new Promise((resolve) => {
  resolveInterruption = resolve;
});
const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => {
    if (interruptedSignal === undefined) {
      interruptedSignal = signal;
      resolveInterruption();
    }
    terminate(signal);
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

let outcome;
try {
  outcome = await withTimeout(Promise.race([
    close.then((status) => ({ status })),
    interruption.then(() => ({ status: undefined }))
  ]), "native Codex adapter", 630_000);
} finally {
  if (!closed) {
    terminate("SIGTERM");
    try {
      await withTimeout(close, "native Codex adapter after SIGTERM", 5_000);
    } catch {
      terminate("SIGKILL");
      await withTimeout(close, "native Codex adapter after SIGKILL", 5_000);
    }
  }
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
}

if (interruptedSignal !== undefined) {
  process.kill(process.pid, interruptedSignal);
}

const [code, signal] = outcome.status;
assert.deepEqual(
  { code, signal, stderr },
  { code: 0, signal: null, stderr: "" },
  "Codex adapter failed against the native language server"
);

const lines = stdout.trimEnd().split("\n");
assert.equal(lines.length, 1, "Codex adapter did not emit exactly one JSON line");
const result = JSON.parse(lines[0]);
assert.deepEqual({
  ok: result.ok,
  operation: result.operation,
  root: result.root,
  file: result.file,
  position: result.position,
  result: result.result
}, {
  ok: true,
  operation: "definition",
  root: projectRoot,
  file: sourceFile,
  position: { line: callLine, character: callCharacter },
  result: {
    uri: pathToFileURL(declarationFile).href,
    range: {
      start: { line: declarationLine, character: declarationCharacter },
      end: {
        line: declarationLine,
        character: declarationCharacter + "latest".length
      }
    }
  }
});

console.log("native Codex adapter workspace smoke passed");
