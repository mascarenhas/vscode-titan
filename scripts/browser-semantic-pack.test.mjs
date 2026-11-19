import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixtureRoot } from "./browser-analysis-fixture.mjs";
import {
  installBrowserCompanion, semanticDirectory, semanticFiles, verifyBrowserCompanion, verifyInstalledBrowserPack
} from "./browser-semantic-pack.mjs";

const sdk = process.env.TITAN_ROOT;
assert.ok(sdk, "browser pack tests need the matching installed SDK in TITAN_ROOT");

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

test("the full provider is valid in a prefix containing only the semantic files", async (context) => {
  const { target } = await copyPack(context, sdk);
  await verifyInstalledBrowserPack(sdk, target);
});

test("a missing, changed or native archive is not a semantic pack", async (context) => {
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

test("the valid protocol fixture is not the full packaging provider", async () => {
  await assert.rejects(verifyInstalledBrowserPack(sdk, path.join(fixtureRoot, "sdk")),
    /not the complete standard provider/);
});

const companion = process.env.TITAN_TEST_BROWSER_COMPANION;
const expected = {
  packSha256: process.env.TITAN_TEST_BROWSER_COMPANION_SHA256,
  rockSha256: process.env.TITAN_TEST_BROWSER_ROCK_SHA256,
  commit: process.env.TITAN_TEST_BROWSER_COMMIT,
  profile: process.env.TITAN_TEST_BROWSER_PROFILE
};
test("the actual companion rejects wrong transport, rock, commit, profile and member bytes",
  { skip: !companion }, async () => {
    const bytes = await readFile(companion);
    const hash = (input) => createHash("sha256").update(input).digest("hex");
    const wrongDigest = "0".repeat(64);
    verifyBrowserCompanion(bytes, expected);
    assert.throws(() => verifyBrowserCompanion(bytes, { ...expected, packSha256: wrongDigest }), /transport SHA-256/);
    for (const wrong of [
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
  { skip: !companion }, async (context) => {
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
