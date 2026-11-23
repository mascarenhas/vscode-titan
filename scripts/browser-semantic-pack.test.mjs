import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureRoot } from "./browser-analysis-fixture.mjs";
import {
  installBrowserCompanion, semanticDirectory, semanticFiles, semanticNotices,
  verifyBrowserCompanion, verifyBrowserNotices, verifyInstalledBrowserPack
} from "./browser-semantic-pack.mjs";

const sdk = process.env.TITAN_ROOT;
const noSdk = sdk ? false : "set TITAN_ROOT to run the compiler-admission checks";
const noFullSdk = noSdk || (!existsSync(path.join(sdk, semanticDirectory))
  && "TITAN_ROOT has no installed browser semantic pack");

test("browser notice verification rejects different bytes at the correct path", async (context) => {
  const prefix = await mkdtemp(path.join(tmpdir(), "vscode-titan-semantic-notices-"));
  context.after(() => rm(prefix, { recursive: true, force: true }));
  const licenseDirectory = path.join(prefix, "share/titan");
  await mkdir(path.join(licenseDirectory, "LICENSES"), { recursive: true });
  for (const name of semanticNotices) await writeFile(path.join(licenseDirectory, name), `${name}\n`);
  const packaged = (name) => Buffer.from(`${name}\n`);
  await verifyBrowserNotices(prefix, packaged);
  await assert.rejects(verifyBrowserNotices(prefix, (name) =>
    name === "LICENSES/go-LICENSE" ? Buffer.from("different bytes\n") : packaged(name)),
  /packaged browser notice differs.*go-LICENSE/);
});

test("browser transport SHA is verified before decoding", () => {
  const invalid = Buffer.from("not a gzip archive");
  const digest = "0".repeat(64);
  assert.throws(() => verifyBrowserCompanion(invalid, {
    tag: "v0.6.99", packSha256: digest, rockSha256: digest, commit: "0".repeat(40), profile: "validation"
  }), /transport SHA-256 differs/);
});

test("the install CLI uses TITAN_RELEASE to select the exact companion basename", async (context) => {
  const prefix = await mkdtemp(path.join(tmpdir(), "vscode-titan-semantic-tag-"));
  context.after(() => rm(prefix, { recursive: true, force: true }));
  const archive = path.join(prefix, "titan-0.6.99-1-browser-semantics.tar.gz");
  await writeFile(archive, "not a companion");
  const script = fileURLToPath(new URL("./browser-semantic-pack.mjs", import.meta.url));
  const digest = "0".repeat(64);
  const run = (tag) => {
    const env = { ...process.env, TITAN_RELEASE: tag };
    if (tag === undefined) delete env.TITAN_RELEASE;
    return spawnSync(process.execPath, [script, "--install", prefix, archive,
      digest, digest, "0".repeat(40), "validation"], { env, encoding: "utf8" });
  };
  for (const [tag, pattern] of [
    ["v0.6.99", /transport SHA-256 differs/],
    ["v0.6.0", /unexpected browser companion basename/],
    ["v0.6.099", /TITAN_RELEASE must be/],
    ["v0.7.0", /TITAN_RELEASE must be/],
    [undefined, /TITAN_RELEASE must be/]
  ]) {
    const result = run(tag);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, pattern);
  }
});

async function copyPack(context, source) {
  const target = await mkdtemp(path.join(tmpdir(), "vscode-titan-semantic-pack-"));
  context.after(() => rm(target, { recursive: true, force: true }));
  const directory = path.join(target, semanticDirectory);
  await mkdir(directory, { recursive: true });
  for (const name of semanticFiles) {
    await copyFile(path.join(source, semanticDirectory, name), path.join(directory, name));
  }
  return { target, directory };
}

test("the full provider is valid in a prefix containing only the semantic files", { skip: noFullSdk }, async (context) => {
  const { target } = await copyPack(context, sdk);
  await verifyInstalledBrowserPack(sdk, target);
});

test("a missing, changed or native archive is not a semantic pack", { skip: noFullSdk }, async (context) => {
  const { target, directory } = await copyPack(context, sdk);
  const archive = path.join(directory, "titan.a");
  await rm(archive);
  await assert.rejects(verifyInstalledBrowserPack(sdk, target), /titan[.]a/);
  const native = process.platform === "win32" ? "titan.dll" : "titan.a";
  await copyFile(path.join(sdk, "lib/titan/0.6", native), archive);
  await assert.rejects(verifyInstalledBrowserPack(sdk, target), /digest disagrees with analysis-target/);
  await copyFile(path.join(sdk, semanticDirectory, "titan.a"), archive);
  await writeFile(path.join(directory, "absent-modules"), "titan.fs\tchanged\n");
  await assert.rejects(verifyInstalledBrowserPack(sdk, target), /digest disagrees with analysis-target/);
});

test("the valid protocol fixture is not the full packaging provider", { skip: noSdk }, async () => {
  await assert.rejects(verifyInstalledBrowserPack(sdk, path.join(fixtureRoot, "sdk")),
    /not the complete standard provider/);
});

const companion = process.env.TITAN_TEST_BROWSER_COMPANION;
const noCompanion = companion ? false : "set TITAN_TEST_BROWSER_COMPANION and its exact pairing values";
const expected = {
  tag: process.env.TITAN_RELEASE,
  packSha256: process.env.TITAN_TEST_BROWSER_COMPANION_SHA256,
  rockSha256: process.env.TITAN_TEST_BROWSER_ROCK_SHA256,
  commit: process.env.TITAN_TEST_BROWSER_COMMIT,
  profile: process.env.TITAN_TEST_BROWSER_PROFILE
};
test("the actual companion rejects wrong release, transport, rock, commit, profile and member bytes",
  { skip: noCompanion }, async () => {
    const bytes = await readFile(companion);
    const hash = (input) => createHash("sha256").update(input).digest("hex");
    const wrongDigest = "0".repeat(64);
    verifyBrowserCompanion(bytes, expected);
    assert.throws(() => verifyBrowserCompanion(bytes, { ...expected, packSha256: wrongDigest }), /transport SHA-256/);
    for (const wrong of [
      { tag: expected.tag === "v0.6.99" ? "v0.6.0" : "v0.6.99" },
      { rockSha256: wrongDigest }, { commit: "0".repeat(40) },
      { profile: expected.profile === "validation" ? "production" : "validation" }
    ]) {
      assert.throws(() => verifyBrowserCompanion(bytes, { ...expected, ...wrong }), /manifest disagrees/);
    }
    const appended = Buffer.concat([bytes, bytes]);
    assert.throws(() => verifyBrowserCompanion(appended, { ...expected, packSha256: hash(appended) }), /one gzip member/);
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 8] ^= 1;
    assert.throws(() => verifyBrowserCompanion(corrupt, { ...expected, packSha256: hash(corrupt) }), /gzip CRC differs/);
  });

test("a private SDK receives the full companion and refuses damaged warm caches",
  { skip: noCompanion || noSdk }, async (context) => {
    const prefix = await mkdtemp(path.join(tmpdir(), "vscode-titan-semantic-install-"));
    context.after(() => rm(prefix, { recursive: true, force: true }));
    for (const tree of ["bin", "lib/lua/5.5", "share/lua/5.5", "share/titan"]) {
      await cp(path.join(sdk, tree), path.join(prefix, tree), { recursive: true, dereference: true });
    }
    await installBrowserCompanion(prefix, companion, expected);
    const pack = path.join(prefix, semanticDirectory);
    assert.deepEqual((await readdir(path.dirname(pack))).sort(), ["0.6"]);
    assert.deepEqual((await readdir(pack)).sort(), semanticFiles);
    await installBrowserCompanion(prefix, companion, expected);

    const absent = path.join(pack, "absent-modules");
    await writeFile(absent, "different bytes\n");
    await assert.rejects(installBrowserCompanion(prefix, companion, expected), /differs from the exact companion/);
    assert.equal(await readFile(absent, "utf8"), "different bytes\n");
    await rm(absent);
    await assert.rejects(installBrowserCompanion(prefix, companion, expected), /partial browser companion/);
    assert.deepEqual((await readdir(pack)).sort(), ["analysis-target", "titan.a"]);
  });
