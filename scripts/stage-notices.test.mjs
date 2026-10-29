import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageLuaNotices, stageTitanNotices } from "./stage-notices.mjs";
import { installedRocks } from "./fixtures/compiler-rocks.mjs";

test("Windows notices come from installed rocks with real MIT and Apache licenses", async (context) => {
  const fixture = await installedRocks(context);
  const destination = await mkdtemp(path.join(tmpdir(), "titan-rock-notices-"));
  context.after(() => rm(destination, { recursive: true, force: true }));
  const versions = await stageLuaNotices({ sdk: fixture.sdk, destination,
    platform: "win32", manifestReader: fixture.manifestReader });
  assert.equal(versions.length, 5);
  assert.deepEqual(await readdir(path.join(destination, "lua")),
    ["argparse", "inspect", "lpeglabel", "luafilesystem", "luv"]);
  assert.match(await readFile(path.join(destination, "lua/luv/LICENSE.txt"), "utf8"), /Apache License/);
  assert.match(await readFile(path.join(destination, "lua/luafilesystem/LICENSE.html"), "utf8"), /<h1>License<\/h1>/);
  assert.match(await readFile(path.join(destination, "lua/inspect/LICENSE"), "utf8"), /Enrique García Cota/);
  await assert.rejects(readFile(path.join(destination, "lua/compiler-dependencies.tsv")), { code: "ENOENT" });
});

for (const platform of ["win32", "linux", "darwin"]) {
  test(`${platform} luv staging requires notices for statically bundled libuv components`, async (context) => {
    const fixture = await installedRocks(context, platform);
    await rm(path.join(fixture.sdk, "share/titan/LICENSES/libuv-inet-LICENSE"));
    const destination = await mkdtemp(path.join(tmpdir(), "titan-rock-notices-"));
    context.after(() => rm(destination, { recursive: true, force: true }));
    await assert.rejects(stageLuaNotices({ sdk: fixture.sdk, destination,
      platform, manifestReader: fixture.manifestReader }),
    /cannot read luv bundled libuv license.*libuv-inet-LICENSE/);
  });
}

test("Unix compiler dependency notices need only installed rocks and omit LuaRocks itself", async (context) => {
  const fixture = await installedRocks(context, "linux");
  const destination = await mkdtemp(path.join(tmpdir(), "titan-rock-notices-"));
  context.after(() => rm(destination, { recursive: true, force: true }));
  const versions = await stageLuaNotices({ sdk: fixture.sdk, destination,
    platform: "linux", manifestReader: fixture.manifestReader });
  assert.equal(versions.length, 5);
  assert.deepEqual(await readdir(path.join(destination, "lua")),
    ["argparse", "inspect", "lpeglabel", "luafilesystem", "luv"]);
  await assert.rejects(readFile(path.join(destination, "lua/luarocks/COPYING")), { code: "ENOENT" });
});

test("Titan notices use the installed SDK license on every platform", async (context) => {
  const fixture = await installedRocks(context, "linux");
  const license = "Installed Titan license\n";
  await fixture.put(path.join(fixture.sdk, "share/titan/LICENSE"), license);
  await fixture.put(path.join(fixture.sdk, "share/titan/THIRD_PARTY_NOTICES.md"), "Third-party notices\n");
  const destination = await mkdtemp(path.join(tmpdir(), "titan-sdk-notices-"));
  context.after(() => rm(destination, { recursive: true, force: true }));
  await stageTitanNotices({ sdk: fixture.sdk, destination });
  assert.equal(await readFile(path.join(destination, "titan/LICENSE"), "utf8"), license);
  assert.match(await readFile(path.join(destination, "titan/LICENSES/libuv-LICENSE"), "utf8"), /Permission/);
  await rm(path.join(fixture.sdk, "share/titan/LICENSE"));
  await assert.rejects(stageTitanNotices({ sdk: fixture.sdk, destination }), /cannot stage Titan license/);
});

test("notice CLI runs through an absolute symlink", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-notice-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./stage-notices.mjs", import.meta.url));
  const alias = path.join(root, "notices-alias.mjs");
  try { await symlink(script, alias); }
  catch (error) {
    if (["EACCES", "EPERM", "ENOSYS"].includes(error.code)) {
      context.skip("file symlink fixture creation is unavailable"); return;
    }
    throw error;
  }
  const environment = { ...process.env, TITAN_PREFIX: path.join(root, "missing-sdk") };
  const cli = spawnSync(process.execPath, [alias], {
    cwd: root, env: environment, encoding: "utf8", shell: false
  });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /cannot stage Titan license/);
});

test("staging imports are safe from stdin without an installed SDK", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-staging-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = { ...process.env, TITAN_PREFIX: path.join(root, "missing-sdk") };
  const imported = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: root, env: environment, encoding: "utf8", shell: false,
    input: `await import(${JSON.stringify(new URL("./stage-notices.mjs", import.meta.url).href)});\n` +
      `await import(${JSON.stringify(new URL("./stage-lua-modules.mjs", import.meta.url).href)});\n`
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
});
