import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";

const repositoryRoot = path.resolve(__dirname, "../../../..");
const queryScript = path.join(
  repositoryRoot,
  "plugins",
  "titan-lsp",
  "skills",
  "titan-lsp-query",
  "scripts",
  "titan-lsp-query.mjs"
);
const fakeServer = path.join(
  repositoryRoot,
  "test",
  "fixtures",
  "fake-lsp-server.cjs"
);

interface AdapterRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface AdapterSuccess {
  ok: true;
  operation: string;
  root: string;
  file: string;
  uri: string;
  position?: { line: number; character: number };
  newName?: string;
  applied?: boolean;
  result: unknown;
}

interface AdapterFailure {
  ok: false;
  error: { code: string; message: string };
}

function startAdapter(arguments_: string[]) {
  const child = spawn(process.execPath, [queryScript, ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).then((outcome): AdapterRun => ({
    ...outcome,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  }));
  return { child, completion };
}

async function runAdapter(arguments_: string[]): Promise<AdapterRun> {
  return startAdapter(arguments_).completion;
}

function parseSingleJsonLine<T>(output: string): T {
  assert.match(output, /^\{[^\n]*\}\n$/);
  return JSON.parse(output) as T;
}

async function readEvents(
  filename: string
): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(filename, "utf8");
  return source.trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForEvent(
  filename: string,
  eventName: string,
  timeoutMs = 3_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = await readEvents(filename);
      const event = events.find((candidate) => candidate.event === eventName);
      if (event !== undefined) return event;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${eventName} in ${filename}`);
}

function assertProcessGone(pid: number) {
  assert.throws(
    () => process.kill(pid, 0),
    (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ESRCH"
  );
}

describe("Codex Titan LSP query adapter", () => {
  test("runs every supported saved-file query and returns machine-readable results", {
    timeout: 20_000
  }, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "titan-codex-adapter-"));
    const root = path.join(temporary, "project");
    const file = path.join(root, "sample.titan");
    const lifecycleMarker = path.join(temporary, "lifecycle.jsonl");
    const semanticMarker = path.join(temporary, "semantic.jsonl");
    await mkdir(root);
    await writeFile(
      file,
      "function answer(): integer\n  return 42\nend\n",
      "utf8"
    );
    const uri = pathToFileURL(file).href;
    const serverOptions = [
      "--server", process.execPath,
      "--server-arg", fakeServer,
      "--server-arg", lifecycleMarker,
      "--server-arg", "--semantic",
      "--server-arg", "--semantic-marker",
      "--server-arg", semanticMarker,
      "--server-arg", "--indexing-progress",
      "--timeout-ms", "2000"
    ];

    const cases = [
      {
        operation: "definition",
        arguments: ["--line", "0", "--character", "10"],
        expectedMethod: "textDocument/definition"
      },
      {
        operation: "references",
        arguments: ["--line", "0", "--character", "10"],
        expectedMethod: "textDocument/references"
      },
      {
        operation: "hover",
        arguments: ["--line", "0", "--character", "10"],
        expectedMethod: "textDocument/hover"
      },
      {
        operation: "folding",
        arguments: [],
        expectedMethod: "textDocument/foldingRange"
      },
      {
        operation: "rename-preview",
        arguments: [
          "--line", "0", "--character", "10", "--new-name", "solution"
        ],
        expectedMethod: "textDocument/rename"
      }
    ];

    try {
      for (const fixture of cases) {
        const run = await runAdapter([
          fixture.operation,
          "--root", root,
          "--file", "sample.titan",
          ...fixture.arguments,
          ...serverOptions
        ]);
        assert.deepEqual(
          { code: run.code, signal: run.signal, stderr: run.stderr },
          { code: 0, signal: null, stderr: "" }
        );
        const output = parseSingleJsonLine<AdapterSuccess>(run.stdout);
        assert.equal(output.ok, true);
        assert.equal(output.operation, fixture.operation);
        assert.equal(output.root, root);
        assert.equal(output.file, file);
        assert.equal(output.uri, uri);

        if (fixture.operation === "definition") {
          assert.deepEqual(output.result, {
            uri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 }
            }
          });
        } else if (fixture.operation === "references") {
          assert.equal((output.result as unknown[]).length, 1);
        } else if (fixture.operation === "hover") {
          assert.deepEqual(output.result, {
            contents: { kind: "plaintext", value: "fixture hover" },
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 }
            }
          });
        } else if (fixture.operation === "folding") {
          assert.deepEqual(output.result, [{ startLine: 0, endLine: 1 }]);
          assert.equal(output.position, undefined);
        } else {
          assert.equal(output.newName, "solution");
          assert.equal(output.applied, false);
          assert.deepEqual(output.result, {
            changes: {
              [uri]: [{
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 1 }
                },
                newText: "solution"
              }]
            }
          });
        }
      }

      const semanticEvents = await readEvents(semanticMarker);
      assert.deepEqual(
        semanticEvents.map((event) => event.method),
        cases.map((fixture) => fixture.expectedMethod)
      );
      assert.ok(semanticEvents.every((event) => event.uri === uri));
      assert.deepEqual(semanticEvents[0].position, { line: 0, character: 10 });
      assert.deepEqual(semanticEvents[1].context, { includeDeclaration: true });
      assert.deepEqual(semanticEvents[3].position, undefined);
      assert.equal(semanticEvents[4].newName, "solution");

      const lifecycleEvents = await readEvents(lifecycleMarker);
      const physicalRoot = await realpath(root);
      assert.equal(lifecycleEvents.length, cases.length * 3);
      for (let index = 0; index < lifecycleEvents.length; index += 3) {
        assert.deepEqual(
          lifecycleEvents.slice(index, index + 3).map((event) => event.event),
          ["initialize", "shutdown", "exit"]
        );
        assert.equal(lifecycleEvents[index].cwd, physicalRoot);
        assert.equal(lifecycleEvents[index].rootPath, root);
        assert.equal(lifecycleEvents[index].rootUri, pathToFileURL(root).href);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects invalid requests before launching the language server", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "titan-codex-invalid-"));
    const root = path.join(temporary, "project");
    const file = path.join(root, "sample.titan");
    const lifecycleMarker = path.join(temporary, "lifecycle.jsonl");
    await mkdir(root);
    await writeFile(file, "function answer(): integer return 42 end\n", "utf8");
    try {
      const run = await runAdapter([
        "rename-preview",
        "--root", root,
        "--file", file,
        "--line", "0",
        "--character", "10",
        "--server", process.execPath,
        "--server-arg", fakeServer,
        "--server-arg", lifecycleMarker
      ]);
      assert.deepEqual(
        { code: run.code, signal: run.signal },
        { code: 2, signal: null }
      );
      const output = parseSingleJsonLine<AdapterFailure>(run.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error.code, "invalid_arguments");
      assert.match(output.error.message, /--new-name is required/);
      assert.match(run.stderr, /^titan-lsp-query: --new-name is required/);
      assert.equal(existsSync(lifecycleMarker), false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("propagates adapter termination and does not orphan the server", {
    timeout: 10_000
  }, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "titan-codex-signal-"));
    const root = path.join(temporary, "project");
    const file = path.join(root, "sample.titan");
    const lifecycleMarker = path.join(temporary, "lifecycle.jsonl");
    const semanticMarker = path.join(temporary, "semantic.jsonl");
    await mkdir(root);
    await writeFile(file, "function answer(): integer return 42 end\n", "utf8");
    try {
      const running = startAdapter([
        "definition",
        "--root", root,
        "--file", file,
        "--line", "0",
        "--character", "10",
        "--server", process.execPath,
        "--server-arg", fakeServer,
        "--server-arg", lifecycleMarker,
        "--server-arg", "--semantic",
        "--server-arg", "--hang-semantic",
        "--server-arg", "--semantic-marker",
        "--server-arg", semanticMarker,
        "--timeout-ms", "5000"
      ]);
      await waitForEvent(semanticMarker, "semantic");
      assert.equal(running.child.kill("SIGTERM"), true);
      const run = await running.completion;
      const output = parseSingleJsonLine<AdapterFailure>(run.stdout);
      assert.deepEqual(
        { code: run.code, signal: run.signal, output, stderr: run.stderr },
        {
          code: 143,
          signal: null,
          output: {
            ok: false,
            error: { code: "interrupted", message: "received SIGTERM" }
          },
          stderr: "titan-lsp-query: received SIGTERM\n"
        }
      );
      assert.equal(output.error.code, "interrupted");
      assert.match(output.error.message, /SIGTERM/);
      assert.match(run.stderr, /^titan-lsp-query: received SIGTERM/);

      const events = await readEvents(lifecycleMarker);
      const initialize = events.find((event) => event.event === "initialize");
      assert.ok(initialize);
      assert.ok(events.some((event) =>
        event.event === "terminate" && event.signal === "SIGTERM"
      ));
      assertProcessGone(initialize.pid as number);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("shuts down cleanly after an indexing timeout", {
    timeout: 10_000
  }, async () => {
    const temporary = await mkdtemp(path.join(
      os.tmpdir(), "titan-codex-index-timeout-"));
    const root = path.join(temporary, "project");
    const file = path.join(root, "sample.titan");
    const lifecycleMarker = path.join(temporary, "lifecycle.jsonl");
    await mkdir(root);
    await writeFile(file, "function answer(): integer return 42 end\n", "utf8");
    try {
      const run = await runAdapter([
        "definition",
        "--root", root,
        "--file", file,
        "--line", "0",
        "--character", "10",
        "--server", process.execPath,
        "--server-arg", fakeServer,
        "--server-arg", lifecycleMarker,
        "--server-arg", "--semantic",
        "--server-arg", "--indexing-delay-ms",
        "--server-arg", "500",
        "--timeout-ms", "100"
      ]);
      assert.deepEqual(
        { code: run.code, signal: run.signal },
        { code: 1, signal: null }
      );
      const output = parseSingleJsonLine<AdapterFailure>(run.stdout);
      assert.equal(output.error.code, "timeout");
      assert.match(output.error.message, /language-server indexing/);

      const events = await readEvents(lifecycleMarker);
      assert.deepEqual(
        events.map((event) => event.event),
        ["initialize", "shutdown", "exit"]
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects an incomplete indexing ready status and shuts down", async () => {
    const temporary = await mkdtemp(path.join(
      os.tmpdir(), "titan-codex-index-status-"));
    const root = path.join(temporary, "project");
    const file = path.join(root, "sample.titan");
    const lifecycleMarker = path.join(temporary, "lifecycle.jsonl");
    await mkdir(root);
    await writeFile(file, "function answer(): integer return 42 end\n", "utf8");
    try {
      const run = await runAdapter([
        "definition",
        "--root", root,
        "--file", file,
        "--line", "0",
        "--character", "10",
        "--server", process.execPath,
        "--server-arg", fakeServer,
        "--server-arg", lifecycleMarker,
        "--server-arg", "--semantic",
        "--server-arg", "--omit-indexing-generation",
        "--timeout-ms", "2000"
      ]);
      assert.deepEqual(
        { code: run.code, signal: run.signal },
        { code: 1, signal: null }
      );
      const output = parseSingleJsonLine<AdapterFailure>(run.stdout);
      assert.equal(output.error.code, "protocol_error");
      assert.match(output.error.message, /ready status is incomplete/);

      const events = await readEvents(lifecycleMarker);
      assert.deepEqual(
        events.map((event) => event.event),
        ["initialize", "shutdown", "exit"]
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("force-kills and reaps a server that ignores shutdown and SIGTERM", {
    timeout: 10_000
  }, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "titan-codex-force-"));
    const root = path.join(temporary, "project");
    const file = path.join(root, "sample.titan");
    const lifecycleMarker = path.join(temporary, "lifecycle.jsonl");
    await mkdir(root);
    await writeFile(file, "function answer(): integer return 42 end\n", "utf8");
    try {
      const run = await runAdapter([
        "definition",
        "--root", root,
        "--file", file,
        "--line", "0",
        "--character", "10",
        "--server", process.execPath,
        "--server-arg", fakeServer,
        "--server-arg", lifecycleMarker,
        "--server-arg", "--semantic",
        "--server-arg", "--hang-semantic",
        "--server-arg", "--ignore-shutdown",
        "--server-arg", "--ignore-terminate",
        "--timeout-ms", "100"
      ]);
      assert.deepEqual(
        { code: run.code, signal: run.signal },
        { code: 1, signal: null }
      );
      const output = parseSingleJsonLine<AdapterFailure>(run.stdout);
      assert.equal(output.error.code, "timeout");
      assert.match(run.stderr, /^titan-lsp-query: timed out waiting/);

      const events = await readEvents(lifecycleMarker);
      const initialize = events.find((event) => event.event === "initialize");
      assert.ok(initialize);
      assert.ok(events.some((event) => event.event === "shutdown"));
      assert.ok(events.some((event) =>
        event.event === "terminate" && event.signal === "SIGTERM"
      ));
      assertProcessGone(initialize.pid as number);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
