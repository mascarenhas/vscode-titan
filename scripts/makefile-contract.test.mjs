import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const located = spawnSync("bash", ["-c", "command -v make"], { encoding: "utf8" });
const make = located.status === 0 ? located.stdout.trim() : "";
const identified = spawnSync(make === "" ? "make" : make, ["--version"], { encoding: "utf8" });
const skip = identified.status === 0 && /GNU Make/.test(identified.stdout)
  ? false
  : "GNU Make is not installed";

// Targets that CI, the README, the docs or users invoke directly. `make help`
// is their discovery path, so it must keep every one of them listed.
const publicTargets = [
  "all", "help", "npm-ci", "server", "server-build", "server-objects",
  "server-test", "server-test-build", "server-test-objects", "server-test-run",
  "server-test-sharded", "shard-runner-test", "server-coverage",
  "server-coverage-build", "server-coverage-run", "server-protocol-test",
  "completion-protocol-test", "codex-native-test", "incremental-build-test",
  "extension", "extension-test", "extension-host-test", "test", "package",
  "verify", "inspect-server", "inspect-vsix", "plugin-validate",
  "install-server", "install-server-test", "install-vsix", "clean", "clean-node",
];

const minimum = "4.2";
const guardMessage = new RegExp(`GNU Make ${minimum.replace(".", "\\.")} or newer`);

function run(goals, environment = {}) {
  const env = { ...process.env };
  // A parent Make exports its goals, jobserver and level through these.
  for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL"]) delete env[name];
  return spawnSync(make, ["--no-print-directory", ...goals], {
    cwd: repository,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...env, ...environment },
  });
}

function helpTargets(stdout) {
  const listed = new Set();
  for (const line of stdout.split("\n")) {
    const entry = /^ {2,}(\S+)(?:\s|$)/.exec(line);
    if (entry === null || entry[1].endsWith(":")) continue;
    listed.add(entry[1]);
  }
  return listed;
}

test("make help lists every public target", { skip }, () => {
  const result = run(["help"]);
  assert.equal(result.status, 0, result.stderr);
  const listed = helpTargets(result.stdout);
  const missing = publicTargets.filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], `make help omits: ${missing.join(", ")}`);
});

test("the version guard rejects GNU Make older than 4.2", { skip }, () => {
  for (const version of ["3.81", "3.82", "4.0", "4.1"]) {
    const result = run(["help", `MAKE_VERSION=${version}`]);
    assert.notEqual(result.status, 0, `GNU Make ${version} was accepted`);
    assert.match(result.stderr, guardMessage);
    assert.match(result.stderr, /gnubin/, "the guard does not point at Homebrew's gnubin");
    assert.match(result.stderr, /docs\/native-build\.md/,
      "the guard does not name the build documentation");
  }
});

test("the version guard accepts 4.2 and newer, including CI's 4.3", { skip }, () => {
  for (const version of [minimum, "4.3", "4.4", "4.4.1", "5.0"]) {
    const result = run(["help", `MAKE_VERSION=${version}`]);
    assert.equal(result.status, 0, `GNU Make ${version} was rejected: ${result.stderr}`);
  }
});

test("the version guard runs before SDK discovery", { skip }, () => {
  // Without node, titanc or uname on PATH, an unguarded Makefile fails in SDK
  // discovery; the guard must report the version first.
  const empty = mkdtempSync(path.join(tmpdir(), "vscode-titan-make-path-"));
  try {
    const result = run(["server", "MAKE_VERSION=3.81"], { PATH: empty });
    assert.notEqual(result.status, 0, "an old Make built the server");
    assert.match(result.stderr, guardMessage);
    assert.doesNotMatch(result.stderr, /cannot select an installed Titan SDK/,
      "SDK discovery reported before the Make version guard");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
