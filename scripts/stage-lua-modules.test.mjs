import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeRootInventory, requiredShareFiles, stageLuaModules, validateStagedLuaModules } from "./stage-lua-modules.mjs";
import { validateSdkIncludeInventory } from "./sdk-include-inventory.mjs";

test("Windows SDK headers permit only the complete regular libbacktrace pair", () => {
  const base = ["lauxlib.h", "llhttp.h", "luaconf.h", "lua.h", "lua.hpp", "lualib.h",
    "minicoro.h", "sqlite3.h", "titan.h", "transfer.h", "uv.h"].map((name) => `${name}:file`)
    .concat(["titan:directory", "uv:directory"]);
  validateSdkIncludeInventory(base, "win32");
  const pair = ["backtrace.h:file", "backtrace-supported.h:file"];
  validateSdkIncludeInventory([...base, ...pair], "win32");
  validateSdkIncludeInventory([...base, ...pair, "openssl:directory"], "win32");
  for (const extra of [[pair[0]], [pair[1]],
    ["backtrace.h:symbolic link", pair[1]], [pair[0], "backtrace-supported.h:directory"]]) {
    assert.throws(() => validateSdkIncludeInventory([...base, ...extra], "win32"),
      /SDK include tree inventory changed/);
  }
  validateSdkIncludeInventory(base, "linux");
  assert.deepEqual(validateSdkIncludeInventory([...base, ...pair, "unreviewed.h:file"], "linux"),
    [...base].sort());
  assert.deepEqual(validateSdkIncludeInventory([...base, ...pair, "unreviewed.h:file"], "win32"),
    [...base, ...pair].sort());
  for (const platform of ["linux", "darwin", "win32"]) {
    const withoutTransfer = base.filter((entry) => entry !== "transfer.h:file");
    assert.deepEqual(validateSdkIncludeInventory(withoutTransfer, platform), [...withoutTransfer].sort());
    assert.throws(() => validateSdkIncludeInventory([...withoutTransfer, "transfer.h:symbolic link"], platform),
      /SDK include tree inventory changed/);
  }
});

test("native compiler payload includes luv on every supported platform", () => {
  assert.deepEqual(nativeRootInventory("win32"), ["lfs.dll:file", "lpeglabel.dll:file", "luv.dll:file"]);
  assert.deepEqual(nativeRootInventory("linux"), ["lfs.so:file", "lpeglabel.so:file", "luv.so:file"]);
});

test("staging requires and copies the portable compiler path helper", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-staging-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk");
  const put = async (relative, data = "fixture\n") => {
    const filename = path.join(sdk, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, data);
  };
  for (const file of requiredShareFiles.filter((file) => file !== "titan-compiler/path.lua"))
    await put(`share/lua/5.5/${file}`);
  await put("share/lua/5.5/titan-compiler/version.lua", 'LUA_VERSION="5.5"\nTITAN_ABI_VERSION="2"\nTITAN_VERSION="0.6.0"\n');
  await put("share/lua/5.5/titan-compiler/driver.lua", "driver.LANGUAGE_SERVER_API_VERSION = 1\n");
  await put("share/lua/5.5/argparse.lua");
  await mkdir(path.join(sdk, "share/lua/5.5/titan"));
  for (const member of nativeRootInventory()) await put(`lib/lua/5.5/${member.split(":")[0]}`);
  for (const file of ["lauxlib.h", "llhttp.h", "luaconf.h", "lua.h", "lua.hpp", "lualib.h", "minicoro.h",
    "sqlite3.h", "titan.h", "transfer.h", "uv.h"]) await put(`include/${file}`);
  for (const directory of ["include/titan", "include/uv", "src/lua-5.5.1"])
    await mkdir(path.join(sdk, directory), { recursive: true });
  const script = fileURLToPath(new URL("./stage-lua-modules.mjs", import.meta.url));
  const run = () => spawnSync(process.execPath, [script], {
    cwd: root, env: { ...process.env, TITAN_PREFIX: sdk }, encoding: "utf8", shell: false
  });
  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /required Lua module titan-compiler\/path.lua/);
  await put("share/lua/5.5/titan-compiler/path.lua", "return { portable = true }\n");
  const staged = run();
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(await readFile(path.join(root, "dist/titan/share/lua/5.5/titan-compiler/path.lua"), "utf8"),
    "return { portable = true }\n");
  assert.equal(await readFile(path.join(root, "dist/titan/include/transfer.h"), "utf8"), "fixture\n");
  await rm(path.join(sdk, "include/transfer.h"));
  const legacyDestination = path.join(root, "legacy");
  await stageLuaModules({ sdk, destination: legacyDestination });
  await validateStagedLuaModules(sdk, legacyDestination);
  await assert.rejects(readFile(path.join(legacyDestination, "include/transfer.h")), { code: "ENOENT" });
  await put("include/transfer.h");

  // The installed compiler tree can contain LuaRocks itself and other packages;
  // only the reviewed compiler and SDK roots belong in the delivered payload.
  for (const extra of ["share/lua/5.5/luarocks/core/cfg.lua", "share/lua/5.5/unrelated.lua",
    "lib/lua/5.5/unrelated.so", "include/unrelated.h", "src/unrelated/source.c"]) await put(extra);
  const destination = path.join(root, "selected");
  await stageLuaModules({ sdk, destination });
  await validateStagedLuaModules(sdk, destination);
  const inspect = (entry = script) => spawnSync(process.execPath, [entry, "--check-payload", sdk, destination], {
    cwd: root, env: { ...process.env, TITAN_PREFIX: sdk }, encoding: "utf8", shell: false
  });
  const inspected = inspect();
  assert.equal(inspected.status, 0, inspected.stderr);
  for (const extra of ["share/lua/5.5/luarocks", "share/lua/5.5/unrelated.lua",
    "lib/lua/5.5/unrelated.so", "include/unrelated.h", "src/unrelated"]) {
    await assert.rejects(readFile(path.join(destination, extra)), { code: "ENOENT" });
  }
  await writeFile(path.join(destination, "share/lua/5.5/unrelated.lua"), "unrelated\n");
  await assert.rejects(validateStagedLuaModules(sdk, destination), /does not exactly match selected inputs/);
  await rm(path.join(destination, "share/lua/5.5/unrelated.lua"));
  await writeFile(path.join(destination, "share/lua/5.5/titan-compiler/path.lua"), "changed\n");
  await assert.rejects(validateStagedLuaModules(sdk, destination), /does not exactly match selected inputs/);
  const changed = inspect();
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /does not exactly match selected inputs/);
  await context.test("payload CLI follows an absolute script symlink", async (aliasContext) => {
    const alias = path.join(root, "stage-alias.mjs");
    try { await symlink(script, alias); }
    catch (error) {
      if (["EACCES", "EPERM", "ENOSYS"].includes(error.code)) {
        aliasContext.skip("file symlink fixture creation is unavailable"); return;
      }
      throw error;
    }
    const rejected = inspect(alias);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /does not exactly match selected inputs/);
    await writeFile(path.join(destination, "share/lua/5.5/titan-compiler/path.lua"),
      await readFile(path.join(sdk, "share/lua/5.5/titan-compiler/path.lua")));
    const accepted = inspect(alias);
    assert.equal(accepted.status, 0, accepted.stderr);
  });
  await context.test("staging rejects a selected SDK file symlink", async (linkContext) => {
    await rm(path.join(sdk, "share/lua/5.5/titan-compiler/path.lua"));
    try {
      await symlink(path.join(sdk, "share/lua/5.5/inspect.lua"), path.join(sdk, "share/lua/5.5/titan-compiler/path.lua"));
    } catch (error) {
      if (["EACCES", "EPERM", "ENOSYS"].includes(error.code)) {
        linkContext.skip("file symlink fixture creation is unavailable"); return;
      }
      throw error;
    }
    await assert.rejects(stageLuaModules({ sdk, destination }), /not a regular file/);
  });
});
