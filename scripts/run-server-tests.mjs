import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

// Keep compiler-backed owners apart. Each module's dynamic subtests stay with
// their parent. The import inventory below prevents silently dropping new owners.
export const serverTestShards = [
  [
    "compiler_bridge_test", "compiler_bridge_concurrency_test", "compiler_io_test",
    "completion_discovery_test", "diagnostics_test", "dispatcher_test", "document_buffers_test", "embedded_interfaces_test",
    "framing_test", "header_store_test", "indexing_status_test", "lifecycle_test",
    "logging_test", "lsp_types_test", "lua_paths_test", "protocol_test", "wire_test", "documentation_test",
    "roots_test", "root_settings_test", "worker_process_test", "router_test",
    "outbound_requests_test"
  ],
  [
    "application_test", "compiler_scheduler_test", "completion_service_test", "completion_store_test", "coordinator_test",
    "project_config_test", "project_discovery_test", "project_graph_test", "project_loader_test",
    "project_metadata_test", "project_service_test", "project_watcher_test",
    "semantic_features_test", "semantic_index_test", "source_text_test",
    "workspace_cache_test", "workspace_store_test", "indexing_progress_test"
  ]
].map((modules) => modules.map((name) => `server.${name}`));

export function validateShards(rootSource, shards = serverTestShards) {
  assert.equal(shards.length, 2, "the native suite must have exactly two shards");
  assert.ok(shards.every((shard) => shard.length > 0), "native shards must not be empty");
  const assigned = shards.flat();
  assert.equal(new Set(assigned).size, assigned.length, "a native test owner appears in both shards");
  const imported = [...rootSource.matchAll(/\bimport\s+"(server\.[A-Za-z_][A-Za-z_0-9]*)"/g)]
    .map((match) => match[1]);
  assert.deepEqual([...assigned].sort(), imported.sort(),
    "update serverTestShards to cover every import in src/server/tests.titan exactly once");
}

function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function runShards(binary, {
  shards = serverTestShards,
  logs = path.join(repository, ".build", "test-shards"),
  signal,
  output = (line) => console.log(line)
} = {}) {
  await mkdir(logs, { recursive: true });
  const work = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-shards-"));
  const children = [];
  let killTimer;
  const stop = () => {
    for (const child of children) signalGroup(child, "SIGTERM");
    killTimer ??= setTimeout(() => {
      for (const child of children) signalGroup(child, "SIGKILL");
    }, 3_000);
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    // Prepare both working directories before either process starts; compiler
    // fixture outputs and process cwd changes cannot affect the other shard.
    const directories = shards.map((_, index) => path.join(work, `${index + 1}`));
    await Promise.all(directories.map((directory) => mkdir(directory)));
    if (signal?.aborted) throw new Error("native test shards canceled");
    const results = await Promise.all(shards.map((modules, index) => new Promise((resolve) => {
      const number = index + 1;
      const started = performance.now();
      const chunks = [];
      const observed = new Set();
      const filters = modules.map((name) => `--filter=^${name.replaceAll(".", "%.")}%.`);
      output(`[native ${number}/2] starting ${modules.length} test modules`);
      const child = spawn(path.resolve(binary), filters, {
        cwd: directories[index], detached: true, stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(child);
      let failure;
      child.on("error", (error) => { failure = error.message; });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => chunks.push(chunk));
        createInterface({ input: stream }).on("line", (line) => {
          output(`[native ${number}/2] ${line}`);
          const match = /^\[ RUN\s+\] (server\.[A-Za-z_][A-Za-z_0-9]*)\./.exec(line);
          if (match) observed.add(match[1]);
        });
      }
      child.on("close", (code, childSignal) => {
        const elapsedSeconds = (performance.now() - started) / 1_000;
        const missing = modules.filter((name) => !observed.has(name));
        const unexpected = [...observed].filter((name) => !modules.includes(name));
        if (missing.length || unexpected.length) {
          failure ??= `test selection mismatch: missing ${missing.join(", ")}; unexpected ${unexpected.join(", ")}`;
        }
        output(`[native ${number}/2] finished in ${elapsedSeconds.toFixed(2)}s (exit ${code ?? childSignal})`);
        resolve({ number, code, signal: childSignal, elapsedSeconds, failure,
          log: Buffer.concat(chunks) });
      });
    })));
    for (const result of results) {
      await writeFile(path.join(logs, `shard-${result.number}.log`), result.log);
    }
    await writeFile(path.join(logs, "summary.json"), JSON.stringify(results.map(({ log, ...result }) => result), null, 2) + "\n");
    const failed = results.filter((result) => result.code !== 0 || result.failure);
    if (failed.length || signal?.aborted) {
      throw new Error(signal?.aborted ? "native test shards canceled" : failed.map((result) =>
        `native shard ${result.number} failed: ${result.failure ?? result.signal ?? `exit ${result.code}`}`).join("\n"));
    }
    return results.map(({ log, ...result }) => result);
  } finally {
    signal?.removeEventListener("abort", stop);
    clearTimeout(killTimer);
    // Reap any subprocess descendants left behind by a failed test or canceled
    // runner before removing their private fixture directories.
    for (const child of children) signalGroup(child, "SIGKILL");
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    assert.equal(process.argv.length, 3, "usage: node scripts/run-server-tests.mjs PATH-TO-NATIVE-TESTS");
    validateShards(await readFile(path.join(repository, "src/server/tests.titan"), "utf8"));
    await runShards(process.argv[2], { signal: controller.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
