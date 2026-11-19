import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  browserDirectory, externalArchive, fixtureRoot, semanticFiles, stageBrowserFixture
} from "./browser-analysis-fixture.mjs";

const script = fileURLToPath(new URL("./browser-analysis-fixture.lua", import.meta.url));

function compiler(mode, root, error) {
  assert.ok(process.env.TITAN_ROOT, "set TITAN_ROOT to the installed test SDK");
  const sdk = resolve(process.env.TITAN_ROOT);
  const lua = join(sdk, "bin", process.platform === "win32" ? "lua.exe" : "lua");
  const result = spawnSync(lua, ["-E", script, mode, sdk, root], {
    encoding: "utf8", timeout: 30_000
  });
  assert.ifError(result.error);
  if (error) {
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
  } else {
    assert.equal(result.status, 0, result.stderr);
  }
  return result.stdout;
}

async function temporaryRoot(context) {
  const root = await mkdtemp(join(tmpdir(), "titan browser fixture "));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function stagedFixture(context) {
  const root = await temporaryRoot(context);
  await stageBrowserFixture(root);
  return root;
}

test("the browser fixture hashes cover the exact SDK, provider, source and notices", async () => {
  const expected = ["LICENSE", "lua-LICENSE", "provenance.json", `providers/${externalArchive}`,
    ...semanticFiles.map((name) => `sdk/${browserDirectory}/${name}`), "source/browser_external.titan"];
  const lines = (await readFile(join(fixtureRoot, "SHA256SUMS"), "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, expected.length);
  for (const [index, name] of expected.entries()) {
    const file = join(fixtureRoot, name);
    assert.ok((await lstat(file)).isFile(), `${file} is not a regular file`);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.equal(lines[index], `${digest}  ${name}`);
  }
});

test("the relocated Wasm fixture resolves the real SDK and explicit archive offline", async (context) => {
  const root = await stagedFixture(context);
  assert.match(compiler("verify", root), /validated browser semantic fixture/);
  await assert.rejects(stageBrowserFixture(root), { code: "EEXIST" });
});

test("fixture staging refuses a protected SDK even before it contains browser assets", async (context) => {
  const shared = await temporaryRoot(context);
  const previous = process.env.TITAN_PREFIX;
  context.after(() => {
    if (previous === undefined) delete process.env.TITAN_PREFIX;
    else process.env.TITAN_PREFIX = previous;
  });
  process.env.TITAN_PREFIX = shared;
  await assert.rejects(stageBrowserFixture(shared), /fixture root is not disposable/);
  await assert.rejects(lstat(join(shared, "sdk")), { code: "ENOENT" });
});

test("fixture staging cannot create files through an interior directory link", async (context) => {
  const root = await temporaryRoot(context);
  const shared = await temporaryRoot(context);
  await mkdir(join(root, "sdk"));
  await symlink(shared, join(root, "sdk", "lib"),
    process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(stageBrowserFixture(root), /fixture destination is not an owned directory/);
  await assert.rejects(lstat(join(shared, "titan-browser")), { code: "ENOENT" });
});

test("browser SDK admission rejects a missing descriptor, not an absent import", async (context) => {
  const root = await stagedFixture(context);
  await rm(join(root, "sdk", browserDirectory, "analysis-target"));
  compiler("verify", root, /analysis-target: (?:missing file|[Nn]o such file)/);
});

test("browser SDK admission rejects a descriptor for another target", async (context) => {
  const root = await stagedFixture(context);
  compiler("wrong-target", root);
  compiler("verify", root, /analysis-target: incompatible browser semantic target/);
});

test("browser SDK admission rejects authentic Wasm bytes from the wrong pack", async (context) => {
  const root = await stagedFixture(context);
  await copyFile(join(root, "providers", externalArchive), join(root, "sdk", browserDirectory, "titan.a"));
  compiler("verify", root, /titan\.a: digest disagrees with analysis-target/);
});
