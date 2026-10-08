import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageLuaNotices } from "./stage-notices.mjs";
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

test("Windows luv staging requires notices for statically bundled libuv components", async (context) => {
  const fixture = await installedRocks(context);
  await rm(path.join(fixture.sdk, "share/titan/LICENSES/libuv-inet-LICENSE"));
  const destination = await mkdtemp(path.join(tmpdir(), "titan-rock-notices-"));
  context.after(() => rm(destination, { recursive: true, force: true }));
  await assert.rejects(stageLuaNotices({ sdk: fixture.sdk, destination,
    platform: "win32", manifestReader: fixture.manifestReader }),
  /cannot read luv bundled libuv license.*libuv-inet-LICENSE/);
});
