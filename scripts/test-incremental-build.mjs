#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTitanSdk } from "./titan-sdk.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  assert(["--prefix", "--output"].includes(process.argv[index]) && process.argv[index + 1], "expected --prefix/--output PATH");
  options[process.argv[index].slice(2)] = path.resolve(process.argv[index + 1]);
}
const prefix = resolveTitanSdk({ prefix: options.prefix });
await mkdir(path.join(repository, ".build"), { recursive: true });
const output = options.output ?? await mkdtemp(path.join(repository, ".build", "incremental-smoke-"));
if (options.output) await mkdir(output);
const source = path.join(output, "src"), build = path.join(output, "build");
const server = path.join(output, "titan-language-server"), tests = path.join(build, "tests/server/tests");
await mkdir(path.join(source, "fixture"), { recursive: true });
await mkdir(path.join(source, "server"));
await writeFile(path.join(source, "fixture/leaf.titan"), "function answer(): integer return 7 end\n");
await writeFile(path.join(source, "titan_language_server.titan"), `local leaf = import "fixture.leaf"
function main(args: {string}): integer return leaf.answer() end
`);
await writeFile(path.join(source, "server/tests.titan"), `local test = import "test"
local leaf = import "fixture.leaf"
function test_answer(context: test.Context) test.assert(leaf.answer() == 7) end
`);
const env = { ...process.env };
for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "LUA_PATH", "LUA_CPATH", "LUA_PATH_5_5", "LUA_CPATH_5_5",
  "TITAN_SOURCE_PATH", "TITAN_PATH", "TITAN_PATH_0_6", "TITAN_FILTER"]) delete env[name];
function run(label, command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd: repository, env, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, expected, `${label}: ${result.error?.message ?? result.stderr}`);
  return (result.stdout ?? "") + (result.stderr ?? "");
}
async function make(label) {
  const log = run(label, "make", ["--no-print-directory", "-j2", `TITAN_PREFIX=${prefix}`, `SOURCE_ROOT=${source}`,
    `BUILD_ROOT=${build}`, `SERVER=${server}`, "BUILD_PROFILE=validation", "TITAN_FLAGS=-v", "server", "server-test-build"]);
  await writeFile(path.join(output, label + ".log"), log);
  assert.equal(run(label + " server", server, [], 7), "");
  const native = run(label + " tests", "make", ["--no-print-directory", `TITAN_PREFIX=${prefix}`, `BUILD_ROOT=${build}`, "server-test-run"]);
  assert.match(native, /\[  PASSED  \] 1 test\./);
  return log;
}
const tracked = [server, tests, ...["server", "tests"].flatMap((mode) => ["fixture/leaf.o", mode === "server" ? "titan_language_server.o" : "server/tests.o"]
  .map((name) => path.join(build, mode, name)))];
async function snapshot() {
  return Promise.all(tracked.map(async (name) => String((await stat(name, { bigint: true })).mtimeNs)));
}
try {
  await make("cold");
  const before = await snapshot();
  await make("noop");
  assert.deepEqual(await snapshot(), before, "no-op rewrote a module or executable");
  await writeFile(path.join(source, "fixture/leaf.titan"), "function answer(): integer return 7 + 0 end\n");
  await make("body-edit");
  const after = await snapshot();
  for (const index of [2, 4]) assert.notEqual(after[index], before[index], "edited leaf was not rebuilt");
  for (const index of [3, 5]) assert.equal(after[index], before[index], "implementation-only edit recompiled a consumer");
  console.log(`Incremental application smoke passed; verbose logs: ${output}`);
} catch (error) {
  console.error(`Incremental application smoke failed; logs: ${output}`);
  throw error;
}
