#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat, unlink, chmod } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = { prefix: path.join(repository, ".titan") };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  assert.ok(["--prefix", "--output"].includes(flag), `unknown argument ${flag}`);
  assert.ok(process.argv[index + 1], `${flag} requires a pathname`);
  options[flag.slice(2)] = path.resolve(process.argv[index + 1]);
}
await mkdir(path.join(repository, ".build"), { recursive: true });
const output = options.output ?? await mkdtemp(path.join(repository, ".build", "incremental-check-"));
if (options.output) await mkdir(output);
const source = path.join(output, "source");
const build = path.join(output, "build");
const server = path.join(output, "titan-language-server");
const tests = path.join(build, "tests", "server", "tests");
const callsFile = path.join(output, "compiler-calls.jsonl");
const failureMarker = path.join(output, "fail-next-server-link");
const linkedServer = path.join(build, "server", "titan_language_server");
const compiler = path.join(options.prefix, "bin", "titanc");
const launcher = path.join(output, "titanc");
const environment = { ...process.env, CCACHE_DISABLE: "1", TITAN_ROCKS_ROOT: options.prefix };
for (const name of ["C_INCLUDE_PATH", "LUA_PATH", "LUA_CPATH", "LUA_PATH_5_5", "LUA_CPATH_5_5",
  "TITAN_PREFIX", "TITAN_PATH", "TITAN_PATH_0_6", "TITAN_EXTRA_CPPFLAGS", "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS"]) {
  delete environment[name];
}
const policy = {
  TITAN_EXTRA_CPPFLAGS: "",
  TITAN_EXTRA_CFLAGS: "-O0 -fno-lto",
  TITAN_EXTRA_LDFLAGS: "-O0 -fno-lto"
};
const report = { completed: false, source, build, compiler, steps: [] };
let commandNumber = 0;

async function put(relative, contents) {
  const filename = path.join(source, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

async function command(label, executable, args, expectedStatus = 0) {
  const started = performance.now();
  const result = spawnSync(executable, args, {
    cwd: repository, env: environment, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000
  });
  const log = `${String(++commandNumber).padStart(2, "0")}-${label}.log`;
  await writeFile(path.join(output, log), (result.stdout ?? "") + (result.stderr ?? ""));
  assert.equal(result.status, expectedStatus,
    `${label} exited ${result.status}: ${result.error?.message ?? result.stderr ?? ""}\nSee ${log}`);
  return { output: result.stdout, wallMs: Math.round(performance.now() - started), log };
}

async function calls() {
  try {
    return (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function make(label, { relativeBuildRoot = false, goals = ["server", "server-test-build"], expectedStatus = 0 } = {}) {
  const before = (await calls()).length;
  const result = await command(label, "make", ["--no-print-directory", "-j2",
    `SOURCE_ROOT=${source}`, `BUILD_ROOT=${relativeBuildRoot ? path.relative(repository, build) : build}`, `SERVER=${server}`,
    `TITAN_PREFIX=${options.prefix}`, `TITANC=${launcher}`,
    ...Object.entries(policy).map(([name, value]) => `${name}=${value}`),
    ...goals], expectedStatus);
  result.calls = (await calls()).slice(before);
  report.steps.push({ label, wallMs: result.wallMs, compilerCalls: result.calls.length, log: result.log });
  return result;
}

async function observedFiles() {
  const result = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (/\.(?:o|c|ffi\.h|titan\.h)$/.test(entry.name)) {
        const info = await stat(filename, { bigint: true });
        result[path.relative(build, filename)] = `${info.mtimeNs}:${info.size}`;
      }
    }
  }
  await visit(build);
  for (const [name, filename] of [["server-executable", server], ["test-executable", tests]]) {
    const info = await stat(filename, { bigint: true });
    result[name] = `${info.mtimeNs}:${info.size}`;
  }
  return result;
}

function changed(before, after, filename) {
  assert.ok(before[filename] && after[filename], `missing tracked output ${filename}`);
  assert.notEqual(after[filename], before[filename], `${filename} was not rebuilt`);
}

function unchanged(before, after, filename) {
  assert.ok(before[filename] && after[filename], `missing tracked output ${filename}`);
  assert.equal(after[filename], before[filename], `${filename} rebuilt outside the changed import closure`);
}

async function runtime(label, expected, names) {
  await command(`${label}-server`, server, [], expected);
  const result = await make(`${label}-tests`, { goals: ["server-test-run"] });
  assert.ok(result.output.includes(`[  PASSED  ] ${names.length} tests.`), "test discovery count changed");
  for (const name of names) assert.ok(result.output.includes(`[ RUN      ] ${name}`), `missing case ${name}`);
  return result.output;
}

async function noOp(label, options) {
  const before = await observedFiles();
  const result = await make(label, options);
  assert.equal(result.calls.length, 0, `${label} invoked Titan during a no-op build`);
  assert.deepEqual(await observedFiles(), before, `${label} rewrote native outputs`);
}

const app = (dependency, expression = "extra()") => `local leaf = import "fixture.${dependency}"
local strings = import "string"
-- This literal must never enter the build import graph.
local example = 'local bogus = import "missing.fixture"'
function answer(): integer return leaf.value() + ${expression} end
`;
const leaf = (adjustment) => `foreign import "value.h"
foreign function native_value(): int return ffi.incremental_header_value() end
local function hidden(): integer return ${adjustment} end
function value(): integer return native_value() + hidden() - 1 end
`;
const appTests = (name, extra = "") => `local test = import "test"
local app = import "fixture.app"
local leaf = import "fixture.leaf.titan"
function ${name}(context: test.Context)
  test.assert(test.testing() and app.answer() > 0 and leaf.native_value() > 0)
end
${extra}`;
let names = ["fixture.app_test.test_initial", "fixture.other_test.test_unrelated"];

try {
  await put("fixture/leaf.titan", leaf(1));
  await put("fixture/detail.h", "#define INCREMENTAL_HEADER_VALUE 3\n");
  await put("fixture/value.h", `#ifndef INCREMENTAL_VALUE_H
#define INCREMENTAL_VALUE_H
#include "detail.h"
#ifndef INCREMENTAL_BIAS
#define INCREMENTAL_BIAS 0
#endif
static inline int incremental_header_value(void) {
  return INCREMENTAL_HEADER_VALUE + INCREMENTAL_BIAS;
}
#endif
`);
  await put("fixture/app/app.titan", app("leaf"));
  await put("fixture/app/extra.titan", 'local function extra(): integer return #strings.upper("ok") end\n');
  await put("fixture/unrelated.titan", "function value(): integer return 0 end\n");
  await put("fixture/app_test.titan", appTests("test_initial"));
  await put("fixture/other_test.titan", `local test = import "test"
local unrelated = import "fixture.unrelated"
function test_unrelated(context: test.Context) test.assert(unrelated.value() == 0) end
`);
  await put("server/tests.titan", `local first = import "fixture.app_test"
local second = import "fixture.other_test"
`);
  await put("titan_language_server.titan", `local app = import "fixture.app"
local unrelated = import "fixture.unrelated"
function main(args: {string}): integer return app.answer() + unrelated.value() end
`);
  for (const header of ["compiler_io_clock.h", "embedded_interfaces_native.h"]) {
    await put(`server/${header}`, await readFile(path.join(repository, "src/server", header)));
  }
  const wrapper = path.join(output, "record-compiler.mjs");
  await writeFile(wrapper, `import {appendFileSync, existsSync, unlinkSync, writeFileSync, chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({args})+'\\n');
if (!args.includes('-c') && !args.includes('--test') && args.includes('titan_language_server') && existsSync(${JSON.stringify(failureMarker)})) {
  unlinkSync(${JSON.stringify(failureMarker)});
  writeFileSync(${JSON.stringify(linkedServer)}, '');
  chmodSync(${JSON.stringify(linkedServer)}, 0o755);
  console.error('injected failure after the linker created its output');
  process.exit(91);
}
const child=spawnSync(${JSON.stringify(compiler)},args,{stdio:'inherit',env:process.env});
if(child.error) console.error(child.error.message);
process.exit(child.status ?? 1);
`);
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(wrapper)} "$@"\n`);
  await chmod(launcher, 0o755);

  await make("initial");
  await runtime("initial", 5, names);
  // CI starts without a Titan search path. Also reject a developer's unrelated
  // SDK: both version-specific and fallback runtime variables must be pinned.
  environment.TITAN_PATH_0_6 = path.join(output, "unrelated-versioned-sdk");
  environment.TITAN_PATH = path.join(output, "unrelated-fallback-sdk");
  environment.LUA_PATH_5_5 = path.join(output, "unrelated-lua/?.lua");
  environment.LUA_CPATH_5_5 = path.join(output, "unrelated-c/?.so");
  await runtime("hostile-runtime-paths", 5, names);
  delete environment.LUA_PATH_5_5;
  delete environment.LUA_CPATH_5_5;
  await noOp("initial-noop");
  await noOp("relative-build-root-noop", { relativeBuildRoot: true });

  await put("fixture/app_test.titan", "function unfinished(");
  await noOp("server-ignores-malformed-test", { goals: ["server"] });
  await put("fixture/app_test.titan", appTests("test_initial"));
  await make("restore-test-source");

  let before = await observedFiles();
  await put("fixture/leaf.titan", leaf(2));
  await make("leaf-change");
  let after = await observedFiles();
  for (const mode of ["server-src", "test-src"]) {
    changed(before, after, `${mode}/fixture/leaf.o`);
    changed(before, after, `${mode}/fixture/app/app.o`);
    unchanged(before, after, `${mode}/fixture/unrelated.o`);
  }
  await runtime("leaf-change", 6, names);

  await put("fixture/alternate.titan", "function value(): integer return 12 end\n");
  await put("fixture/app/app.titan", app("alternate"));
  await make("import-change");
  after = await observedFiles();
  for (const mode of ["server-src", "test-src"]) assert.ok(after[`${mode}/fixture/alternate.o`]);
  await runtime("import-change", 14, names);

  await put("fixture/app/app.titan", app("leaf", '#strings.upper("ok")'));
  await unlink(path.join(source, "fixture/app/extra.titan"));
  await make("folder-member-removal");
  for (const mode of ["server-src", "test-src"]) {
    await assert.rejects(stat(path.join(build, mode, "fixture/app/extra.titan")), { code: "ENOENT" });
  }
  await runtime("folder-member-removal", 6, names);

  await unlink(path.join(source, "fixture/alternate.titan"));
  await make("module-removal");
  for (const mode of ["server-src", "test-src"]) {
    for (const suffix of [".titan", ".c", ".o", ".ffi.h", ".titan.h"]) {
      await assert.rejects(stat(path.join(build, mode, `fixture/alternate${suffix}`)), { code: "ENOENT" });
    }
  }

  await put("fixture/app.titan", app("leaf", '#strings.upper("ok")'));
  await unlink(path.join(source, "fixture/app/app.titan"));
  await make("folder-to-flat-layout");
  for (const mode of ["server-src", "test-src"]) {
    assert.ok((await stat(path.join(build, mode, "fixture/app.o"))).isFile());
    for (const suffix of [".titan", ".c", ".o", ".ffi.h", ".titan.h"]) {
      await assert.rejects(stat(path.join(build, mode, `fixture/app/app${suffix}`)), { code: "ENOENT" });
    }
  }
  await runtime("folder-to-flat-layout", 6, names);

  before = await observedFiles();
  await put("fixture/detail.h", "#define INCREMENTAL_HEADER_VALUE 8\n");
  await make("transitive-header-change");
  after = await observedFiles();
  for (const mode of ["server-src", "test-src"]) {
    changed(before, after, `${mode}/fixture/leaf.o`);
  }
  await runtime("transitive-header-change", 11, names);

  policy.TITAN_EXTRA_CPPFLAGS = "-DINCREMENTAL_BIAS=4";
  before = await observedFiles();
  await make("preprocessor-flags-change");
  after = await observedFiles();
  for (const mode of ["server-src", "test-src"]) changed(before, after, `${mode}/fixture/leaf.o`);
  await runtime("preprocessor-flags-change", 15, names);
  await noOp("flags-noop");

  policy.TITAN_EXTRA_CFLAGS += " -fno-omit-frame-pointer";
  before = await observedFiles();
  await make("compile-flags-change");
  after = await observedFiles();
  for (const mode of ["server-src", "test-src"]) changed(before, after, `${mode}/fixture/unrelated.o`);
  policy.TITAN_EXTRA_LDFLAGS += " -O1";
  before = await observedFiles();
  await make("link-flags-change");
  after = await observedFiles();
  changed(before, after, "server-executable");
  changed(before, after, "test-executable");
  await runtime("link-flags-change", 15, names);

  before = await observedFiles();
  await writeFile(launcher, `${await readFile(launcher, "utf8")}# changed compiler launcher input\n`);
  await make("compiler-change");
  after = await observedFiles();
  for (const mode of ["server-src", "test-src"]) changed(before, after, `${mode}/fixture/unrelated.o`);

  before = await observedFiles();
  await put("fixture/app_test.titan", appTests("test_renamed", `function test_added(context: test.Context)
  test.assert(test.testing())
end
`));
  await make("test-discovery-change");
  after = await observedFiles();
  unchanged(before, after, "server-executable");
  changed(before, after, "test-executable");
  names = ["fixture.app_test.test_renamed", "fixture.app_test.test_added", "fixture.other_test.test_unrelated"];
  const execution = await runtime("test-discovery-change", 15, names);
  assert.ok(!execution.includes("fixture.app_test.test_initial"), "removed test remained in the cached runner");

  await unlink(path.join(build, "test-src", "fixture", "leaf.titan.h"));
  await make("missing-generated-header");
  assert.ok((await stat(path.join(build, "test-src", "fixture", "leaf.titan.h"))).isFile());
  await runtime("missing-generated-header", 15, names);

  // A failed linker can leave an empty executable newer than every input.
  // Make must delete the failed target and retry the unchanged link next time.
  await unlink(linkedServer);
  await writeFile(failureMarker, "fail one final link\n");
  const failedLink = await make("failed-link", { goals: ["server"], expectedStatus: 2 });
  assert.equal(failedLink.calls.length, 1, "failed-link fixture unexpectedly compiled modules");
  await assert.rejects(stat(linkedServer), { code: "ENOENT" });
  const retriedLink = await make("failed-link-retry", { goals: ["server"] });
  assert.equal(retriedLink.calls.length, 1, "failed link was not retried exactly once");
  assert.ok(!retriedLink.calls[0].args.includes("-c"), "link retry rebuilt a module object");
  await runtime("failed-link-retry", 15, names);

  // Completeness checks also recover an interrupted output without a failed
  // Make process available to remove it.
  await writeFile(linkedServer, "");
  await chmod(linkedServer, 0o755);
  const recoveredLink = await make("empty-output-recovery", { goals: ["server"] });
  assert.equal(recoveredLink.calls.length, 1, "an empty executable was accepted as complete");
  assert.ok((await stat(linkedServer)).size > 0);
  await runtime("empty-output-recovery", 15, names);
  await noOp("final-noop");
  report.completed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ completed: report.completed, evidence: output, error: report.error }));
}
