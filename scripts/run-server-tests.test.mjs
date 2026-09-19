import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runShards, serverTestShards, validateShards } from "./run-server-tests.mjs";

const shards = [["server.first_test"], ["server.second_test"]];

async function fixture(context, mode = "success") {
  const root = await mkdtemp(path.join(os.tmpdir(), "titan-shard-runner-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "suite");
  const script = path.join(root, "suite.mjs");
  await writeFile(binary, `#!/bin/sh\nunset NODE_TEST_CONTEXT\nexec '${process.execPath}' '${script}' "$@"\n`);
  await writeFile(script, `import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
const owner = process.argv[2].slice("--filter=^".length, -2).replaceAll("%.", ".");
await writeFile(path.join(root, owner + ".started"), JSON.stringify({pid: process.pid, cwd: process.cwd()}));
// Neither worker proceeds until both start, proving actual overlap rather than
// relying on an elapsed-time threshold for the scheduler.
const deadline = Date.now() + 5000;
while ((await readdir(root)).filter((name) => name.endsWith(".started")).length !== 2) {
  if (Date.now() > deadline) throw new Error("other shard never started");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (mode === "cancel") {
  const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("descendant ready"); setInterval(() => {}, 1000)'], {stdio: ["ignore", "pipe", "inherit"]});
  grandchild.stdout.once("data", async () => {
    await writeFile(path.join(root, owner + ".descendant"), String(grandchild.pid));
    console.log("[ RUN      ] " + owner + ".test_case");
  });
} else {
  if (mode !== "empty") console.log("[ RUN      ] " + owner + ".test_case");
  if (mode === "failure" && owner === "server.first_test") process.exitCode = 17;
}
`);
  await chmod(binary, 0o755);
  return { root, binary, options: { shards, logs: path.join(root, "logs"), output() {} } };
}

test("shards cover the canonical native test imports once", async () => {
  const source = await readFile(new URL("../src/server/tests.titan", import.meta.url), "utf8");
  validateShards(source);
  assert.throws(() => validateShards(source + '\nlocal missing = import "server.missing_test"'), /cover every import/);
  assert.throws(() => validateShards(source, [serverTestShards[0], [...serverTestShards[1], serverTestShards[0][0]]]), /both shards/);
});

test("runs both shards concurrently in isolated directories and records results", async (context) => {
  const { root, binary, options } = await fixture(context);
  const results = await runShards(binary, options);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.code === 0 && result.elapsedSeconds > 0));
  const first = JSON.parse(await readFile(path.join(root, "server.first_test.started"), "utf8"));
  const second = JSON.parse(await readFile(path.join(root, "server.second_test.started"), "utf8"));
  assert.notEqual(first.cwd, second.cwd);
  await assert.rejects(readdir(first.cwd), { code: "ENOENT" });
  await assert.rejects(readdir(second.cwd), { code: "ENOENT" });
  assert.deepEqual(await readdir(options.logs), ["shard-1.log", "shard-2.log", "summary.json"]);
});

test("Make execution targets query the selected Lua for paths outside its installed tree", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "titan-test-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "src/server"), { recursive: true });
  await writeFile(path.join(root, "scripts/run-server-tests.mjs"),
    await readFile(new URL("./run-server-tests.mjs", import.meta.url)));
  await writeFile(path.join(root, "src/server/tests.titan"),
    await readFile(new URL("../src/server/tests.titan", import.meta.url)));
  const binary = path.join(root, "suite");
  const script = path.join(root, "suite.mjs");
  await writeFile(binary, `#!/bin/sh\nunset NODE_TEST_CONTEXT\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(binary, 0o755);
  await writeFile(script, `import { writeFile } from "node:fs/promises";
import * as path from "node:path";
await writeFile(path.join(${JSON.stringify(root)}, process.pid + ".environment"), JSON.stringify({
  versioned: process.env.TITAN_PATH_0_6 ?? null, fallback: process.env.TITAN_PATH ?? null,
  lua: process.env.LUA_PATH_5_5, c: process.env.LUA_CPATH_5_5, cache: process.env.CCACHE_DISABLE
}));
for (const filter of process.argv.slice(2)) {
  const owner = filter.slice("--filter=^".length, -2).replaceAll("%.", ".");
  console.log("[ RUN      ] " + owner + ".test_case");
}
`);
  const prefix = path.join(root, "selected-sdk");
  await mkdir(path.join(prefix, "bin"), { recursive: true });
  const lua = path.join(prefix, "bin/lua");
  const query = path.join(prefix, "bin/query.mjs");
  await writeFile(lua, `#!/bin/sh\nunset NODE_TEST_CONTEXT\nexec '${process.execPath}' '${query}' "$@"\n`);
  await chmod(lua, 0o755);
  await writeFile(query, `import assert from "node:assert/strict";
import * as path from "node:path";
assert.deepEqual(process.argv.slice(2, 4), ["-E", "-e"]);
const prefix = path.dirname(path.dirname(process.argv[1]));
switch (process.argv[4]) {
  case "io.write(package.path)": process.stdout.write(prefix + "/share/lua/5.5/?.lua"); break;
  case "io.write(package.cpath)": process.stdout.write(prefix + "/lib/titan/0.6/?.so;" + prefix + "/lib/lua/5.5/?.so"); break;
  default: throw new Error("unexpected Lua query");
}
`);
  for (const ambient of [false, true]) {
    const env = { ...process.env };
    delete env.TITAN_PATH_0_6;
    delete env.TITAN_PATH;
    if (ambient) {
      env.TITAN_PATH_0_6 = path.join(root, "unrelated-versioned");
      env.TITAN_PATH = path.join(root, "unrelated-fallback");
      env.LUA_PATH_5_5 = path.join(root, "unrelated-lua/?.lua");
      env.LUA_CPATH_5_5 = path.join(root, "unrelated-c/?.so");
    }
    for (const target of ["server-test-run", "server-test-sharded"]) {
      const result = spawnSync("make", ["--no-print-directory",
        "-f", fileURLToPath(new URL("../Makefile", import.meta.url)),
        "-o", "server-test-build", "NON_NATIVE_GOALS=server-test-run server-test-sharded",
        `TITAN_PREFIX=${prefix}`, `SERVER_TEST=${binary}`, "CCACHE_DISABLE=1", target],
      { cwd: root, env, encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    }
  }
  const captures = (await readdir(root)).filter((name) => name.endsWith(".environment"));
  assert.equal(captures.length, 6, "two serial executions and four shards must run");
  for (const filename of captures) {
    assert.deepEqual(JSON.parse(await readFile(path.join(root, filename), "utf8")), {
      versioned: null, fallback: null,
      lua: path.join(prefix, "share/lua/5.5/?.lua"),
      c: path.join(prefix, "lib/titan/0.6/?.so") + ";" + path.join(prefix, "lib/lua/5.5/?.so"), cache: "1"
    });
  }
});

test("propagates a failed shard while collecting both results", async (context) => {
  const { binary, options } = await fixture(context, "failure");
  await assert.rejects(runShards(binary, options), /native shard 1 failed: exit 17/);
  const summary = JSON.parse(await readFile(path.join(options.logs, "summary.json"), "utf8"));
  assert.deepEqual(summary.map((result) => result.code), [17, 0]);
});

test("rejects zero selected tests even when the native runner exits successfully", async (context) => {
  const { binary, options } = await fixture(context, "empty");
  await assert.rejects(runShards(binary, options), /test selection mismatch/);
});

test("cancellation terminates both worker process groups", { timeout: 10_000 }, async (context) => {
  const { root, binary, options } = await fixture(context, "cancel");
  const controller = new AbortController();
  let started = 0;
  await assert.rejects(runShards(binary, { ...options, signal: controller.signal,
    output(line) {
      if (line.includes("[ RUN")) {
        started += 1;
        if (started === 2) controller.abort();
      }
    }
  }), /canceled/);
  const descendants = (await readdir(root)).filter((name) => name.endsWith(".descendant"));
  assert.equal(descendants.length, 2);
  for (const filename of descendants) {
    const pid = Number(await readFile(path.join(root, filename), "utf8"));
    // On Linux an orphan can briefly remain as a zombie until init reaps it;
    // either missing or zombie proves it cannot continue executing the fixture.
    try {
      const status = await readFile(`/proc/${pid}/stat`, "utf8");
      assert.match(status, /^\d+ \(.+\) Z /);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});
