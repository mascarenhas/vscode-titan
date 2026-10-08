import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export function compilerRocks(platform = process.platform) {
  const suffix = platform === "win32" ? "dll" : "so";
  return [
    { name: "argparse", rockName: "argparse", version: "0.7.2-1",
      payloads: [["share/lua/5.5/argparse.lua", "lua/argparse.lua"]],
      license: "doc/LICENSE", notice: "lua/argparse/LICENSE",
      markers: ["The MIT License (MIT)", "Peter Melnichenko"] },
    { name: "inspect", rockName: "inspect", version: "3.1.3-0",
      payloads: [["share/lua/5.5/inspect.lua", "lua/inspect.lua"]],
      embeddedLicense: "share/lua/5.5/inspect.lua", notice: "lua/inspect/LICENSE",
      markers: ["MIT LICENSE", "Enrique García Cota"] },
    { name: "LuaFileSystem", rockName: "luafilesystem", version: "1.9.0-1",
      payloads: [[`lib/lua/5.5/lfs.${suffix}`, `lib/lfs.${suffix}`]],
      license: "docs/license.html", notice: "lua/luafilesystem/LICENSE.html",
      markers: ["<h1>License</h1>", "The LuaFileSystem authors"] },
    { name: "LPegLabel", rockName: "LPegLabel", directory: "lpeglabel", version: "1.6.2-1",
      payloads: [[`lib/lua/5.5/lpeglabel.${suffix}`, `lib/lpeglabel.${suffix}`],
        ["share/lua/5.5/relabel.lua", "lua/relabel.lua"]],
      license: "doc/LICENSE", notice: "lua/lpeglabel/LICENSE",
      markers: ["The MIT License (MIT)", "Sérgio Medeiros"] },
    ...(platform === "win32" ? [{ name: "luv", rockName: "luv", version: "1.52.1-0",
      payloads: [["lib/lua/5.5/luv.dll", "lib/luv.dll"]],
      license: "doc/LICENSE.txt", notice: "lua/luv/LICENSE.txt",
      markers: ["Apache License", "Version 2.0, January 2004"] }] : [])
  ];
}

export function rockDirectory(sdk, component) {
  return path.join(sdk, "lib", "luarocks", "rocks-5.5",
    component.directory ?? component.rockName, component.version);
}

const manifestProgram = `
local environment = {}
assert(loadfile(arg[1], "t", environment))()
local function visit(value, prefix)
  assert(type(value) == "table", "invalid rock manifest table")
  local names = {}
  for name in pairs(value) do
    assert(type(name) == "string" and not name:find("[/%z\\\\]"), "invalid rock manifest member")
    names[#names + 1] = name
  end
  table.sort(names)
  for _, name in ipairs(names) do
    local member = prefix == "" and name or prefix .. "/" .. name
    if type(value[name]) == "table" then visit(value[name], member)
    else
      assert(type(value[name]) == "string", "invalid rock manifest checksum")
      io.write(member, "\\0", value[name], "\\0")
    end
  end
end
visit(assert(environment.rock_manifest), "")
`;

export function parseManifestOutput(output) {
  const words = output.split("\0");
  assert.equal(words.pop(), "", "invalid LuaRocks manifest response");
  assert(words.length > 0, "empty LuaRocks manifest response");
  assert.equal(words.length % 2, 0, "invalid LuaRocks manifest response");
  const entries = new Map();
  for (let index = 0; index < words.length; index += 2) {
    const [name, checksum] = words.slice(index, index + 2);
    assert(name && !name.includes("\\") && !name.startsWith("/") &&
      name.split("/").every((part) => part && part !== "." && part !== ".."),
    `unsafe LuaRocks manifest path: ${name}`);
    assert(!entries.has(name), `duplicate LuaRocks manifest path: ${name}`);
    assert(/^[a-f0-9]{32}$/.test(checksum), `invalid LuaRocks manifest checksum: ${name}`);
    entries.set(name, checksum);
  }
  return entries;
}

export function readRockManifest(filename, { lua, run = spawnSync }) {
  const result = run(lua, ["-E", "-", filename], {
    input: manifestProgram, encoding: "utf8", windowsHide: true, shell: false,
    timeout: 10000
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `cannot read LuaRocks manifest: ${filename}`);
  return parseManifestOutput(result.stdout);
}

async function regularFile(filename) {
  assert((await lstat(filename)).isFile(), `LuaRocks metadata requires a regular file: ${filename}`);
  return readFile(filename);
}

export function extractInspectLicense(contents, source) {
  const match = contents.match(/inspect\._LICENSE\s*=\s*\[\[\r?\n([\s\S]*?)\]\]/);
  assert(match, `inspect license source mismatch in ${source}: _LICENSE is missing`);
  return `${match[1].replace(/\r?\n$/, "")}\n`;
}

// LuaRocks owns installed module/version/checksum metadata. Use those ordinary
// manifests directly; the consumer does not invent a parallel source receipt.
export async function verifyCompilerRocks(sdk, {
  platform = process.platform,
  manifestReader = (filename) => readRockManifest(filename, {
    lua: path.join(sdk, "bin", platform === "win32" ? "lua.exe" : "lua")
  })
} = {}) {
  const result = [];
  for (const component of compilerRocks(platform)) {
    const directory = rockDirectory(sdk, component);
    const specName = `${component.directory ?? component.rockName}-${component.version}.rockspec`;
    const specFile = path.join(directory, specName);
    const spec = (await regularFile(specFile)).toString("utf8");
    for (const [field, expected] of [["package", component.rockName], ["version", component.version]]) {
      const actual = new RegExp(`^\\s*${field}\\s*=\\s*["']([^"']+)["']`, "m").exec(spec)?.[1];
      assert.equal(actual, expected, `bundled Lua component ${field} mismatch in ${specFile}`);
    }
    const manifestFile = path.join(directory, "rock_manifest");
    await regularFile(manifestFile);
    const manifest = await manifestReader(manifestFile);
    async function verify(filename, member) {
      const checksum = manifest.get(member);
      assert(checksum, `LuaRocks manifest does not own ${member}: ${manifestFile}`);
      const contents = await regularFile(filename);
      assert.equal(createHash("md5").update(contents).digest("hex"), checksum,
        `LuaRocks manifest checksum mismatch: ${filename}`);
      return contents;
    }
    await verify(specFile, specName);
    for (const [installed, member] of component.payloads) await verify(path.join(sdk, installed), member);
    const licenseSource = component.embeddedLicense
      ? path.join(sdk, component.embeddedLicense) : path.join(directory, component.license);
    const license = component.embeddedLicense
      ? extractInspectLicense((await regularFile(licenseSource)).toString("utf8"), licenseSource)
      : (await verify(licenseSource, component.license)).toString("utf8");
    for (const marker of component.markers) {
      assert(license.includes(marker), `${component.name} license source mismatch in ${licenseSource}: ${marker}`);
    }
    result.push({ ...component, licenseSource, license });
  }
  return result;
}
