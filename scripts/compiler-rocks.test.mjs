import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { compilerRocks, parseManifestOutput, readRockManifest, verifyCompilerRocks } from "./compiler-rocks.mjs";
import { installedRocks } from "./fixtures/compiler-rocks.mjs";

test("installed compiler dependencies include portable luv and ordinary rock versions", () => {
  assert.equal(compilerRocks("linux").length, 5);
  const luv = compilerRocks("win32").find((component) => component.rockName === "luv");
  assert.equal(luv.version, "1.52.1-0");
  assert.equal(luv.license, "doc/LICENSE.txt");
  assert.deepEqual(luv.payloads, [["lib/lua/5.5/luv.dll", "lib/luv.dll"]]);
  assert.deepEqual(compilerRocks("linux").find((component) => component.rockName === "luv").payloads,
    [["lib/lua/5.5/luv.so", "lib/luv.so"]]);
});

test("manifest decoding rejects unsafe ownership paths and invalid checksums", () => {
  const checksum = "a".repeat(32);
  assert.deepEqual([...parseManifestOutput(`lib/luv.dll\0${checksum}\0`)], [["lib/luv.dll", checksum]]);
  for (const response of ["", `lib/luv.dll\0${checksum}`, `lib/luv.dll\0short\0`,
    `../luv.dll\0${checksum}\0`, `lib\\luv.dll\0${checksum}\0`,
    `lib//luv.dll\0${checksum}\0`, `lib/luv.dll\0${checksum}\0lib/luv.dll\0${checksum}\0`]) {
    assert.throws(() => parseManifestOutput(response));
  }
});

test("LuaRocks manifest loading uses selected Lua, text data and native argv", () => {
  const filename = path.resolve("SDK space 路径/rock_manifest"), lua = path.resolve("SDK space/bin/lua.exe");
  const entries = readRockManifest(filename, { lua, run(command, args, options) {
    assert.equal(command, lua);
    assert.deepEqual(args, ["-E", "-", filename]);
    assert.equal(options.shell, false);
    assert.match(options.input, /loadfile\(arg\[1\], "t", environment\)/);
    return { status: 0, stdout: `lib/luv.dll\0${"a".repeat(32)}\0` };
  } });
  assert.equal(entries.size, 1);
  assert.throws(() => readRockManifest(filename, { lua, run: () => ({ status: 1, stderr: "broken manifest" }) }),
    /broken manifest/);
});

test("ordinary manifests verify deployed dependencies and license bytes", async (context) => {
  const fixture = await installedRocks(context);
  const rocks = await verifyCompilerRocks(fixture.sdk, { platform: "win32", manifestReader: fixture.manifestReader });
  assert.equal(rocks.length, 5);
  assert.match(rocks.find((rock) => rock.name === "inspect").license, /Enrique García Cota/);
  assert.match(rocks.find((rock) => rock.name === "luv").license, /Apache License/);
  await fixture.put(path.join(fixture.sdk, "lib/lua/5.5/luv.dll"), "modified native module");
  await assert.rejects(verifyCompilerRocks(fixture.sdk, { platform: "win32", manifestReader: fixture.manifestReader }),
    /manifest checksum mismatch.*luv.dll/);
});

test("missing manifest ownership and altered licenses fail closed", async (context) => {
  const fixture = await installedRocks(context);
  const manifestFile = path.join(fixture.sdk, "lib/luarocks/rocks-5.5/luv/1.52.1-0/rock_manifest");
  const manifest = fixture.manifests.get(manifestFile);
  const checksum = manifest.get("lib/luv.dll");
  manifest.delete("lib/luv.dll");
  await assert.rejects(verifyCompilerRocks(fixture.sdk, { platform: "win32", manifestReader: fixture.manifestReader }),
    /manifest does not own lib\/luv.dll/);
  manifest.set("lib/luv.dll", checksum);
  await fixture.put(path.join(path.dirname(manifestFile), "doc/LICENSE.txt"), "changed license");
  await assert.rejects(verifyCompilerRocks(fixture.sdk, { platform: "win32", manifestReader: fixture.manifestReader }),
    /manifest checksum mismatch.*LICENSE.txt/);
});

test("unreviewed installed rock versions fail before staging", async (context) => {
  const fixture = await installedRocks(context);
  await fixture.put(path.join(fixture.sdk, "lib/luarocks/rocks-5.5/luv/1.52.1-0/luv-1.52.1-0.rockspec"),
    'package = "luv"\nversion = "1.99.0-0"\n');
  await assert.rejects(verifyCompilerRocks(fixture.sdk, { platform: "win32", manifestReader: fixture.manifestReader }),
    /version mismatch/);
});
