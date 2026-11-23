import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { compilerDiscoveryEnvironment, resolveTitanSdk, titanLibrarySeries, titanReleaseSeries } from "./titan-sdk.mjs";

export const semanticDirectory = `lib/titan-browser/${titanLibrarySeries}`;
export const semanticFiles = ["absent-modules", "analysis-target", "titan.a"];
export const semanticNotices = ["LICENSE", "LICENSES/go-LICENSE", "LICENSES/lpeg-LICENSE",
  "LICENSES/lpeg-patterns-LICENSE", "LICENSES/lpeglabel-LICENSE", "LICENSES/lua-LICENSE",
  "LICENSES/ta-regex-LICENSE", "THIRD_PARTY_NOTICES.md"];
const semanticPaths = semanticFiles.map((name) => `${semanticDirectory}/${name}`);
const noticePaths = semanticNotices.map((name) => `share/titan/${name}`);
const payloadPaths = [...semanticPaths, ...noticePaths];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hexDigest = /^[0-9a-f]{64}$/;
const block = 512;
const record = 20 * block;
const maxPack = 96 * 1024 * 1024;

function releaseFromTag(tag) {
  assert(
    typeof tag === "string" && tag.startsWith("v") && titanReleaseSeries(tag.slice(1)) === titanLibrarySeries,
    `TITAN_RELEASE must be a v${titanLibrarySeries}.PATCH tag`
  );
  return tag.slice(1);
}

// The producer writes sorted regular files in a fixed POSIX ustar encoding.
// Validate this small closed format instead of extracting transport paths.
function tarHeader(name, size) {
  const header = Buffer.alloc(block);
  header.write(name, 0, "ascii");
  header.write("0000644\0" + "0000000\0".repeat(2), 100, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0` + "00000000000\0", 124, "ascii");
  header.fill(32, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\u000000", 257, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function readPack(bytes) {
  assert(bytes.length >= 18 && bytes.subarray(0, 10).equals(Buffer.from("1f8b08000000000002ff", "hex")),
    "browser companion has a noncanonical gzip header");
  const { buffer: tar, engine } = inflateRawSync(bytes.subarray(10), { info: true, maxOutputLength: maxPack });
  const trailer = bytes.length - 8;
  assert.equal(10 + engine.bytesWritten, trailer, "browser companion must have one gzip member");
  assert.equal(bytes.readUInt32LE(trailer), crc32(tar), "browser companion gzip CRC differs");
  assert.equal(bytes.readUInt32LE(trailer + 4), tar.length, "browser companion gzip size differs");
  const members = new Map();
  let offset = 0;
  for (const name of [...payloadPaths, "manifest.json"].sort()) {
    const header = tar.subarray(offset, offset + block);
    const rawSize = header.subarray(124, 136).toString("latin1");
    assert(/^[0-7]{11}\0$/.test(rawSize), `missing or malformed browser companion member ${name}`);
    const size = Number.parseInt(rawSize, 8);
    assert(size > 0 && header.equals(tarHeader(name, size)), `noncanonical browser companion member ${name}`);
    const start = offset + block;
    const end = start + size;
    offset = Math.ceil(end / block) * block;
    assert(offset <= tar.length && tar.subarray(end, offset).every((byte) => byte === 0),
      `truncated or unpadded browser companion member ${name}`);
    members.set(name, tar.subarray(start, end));
  }
  assert(tar.length === Math.ceil((offset + 2 * block) / record) * record &&
    tar.subarray(offset).every((byte) => byte === 0), "unexpected browser companion members or trailer");
  return members;
}

export function verifyBrowserCompanion(bytes, { tag, packSha256, rockSha256, commit, profile }) {
  const release = releaseFromTag(tag);
  assert(hexDigest.test(packSha256) && hexDigest.test(rockSha256) && /^[0-9a-f]{40}$/.test(commit),
    "browser companion needs exact SHA-256 values and a Titan commit");
  assert(profile === "production" || profile === "validation", "invalid browser companion profile");
  assert.equal(sha256(bytes), packSha256, "browser companion transport SHA-256 differs");
  const members = readPack(bytes);
  const files = payloadPaths.map((name) => {
    const contents = members.get(name);
    return { path: name, sha256: sha256(contents), size: contents.length };
  });
  // With fixed keys, ordering and values, an exact comparison also rejects
  // duplicate keys, extra provenance fields and noncanonical encodings.
  const manifest = {
    abi: "2",
    build_profile: profile,
    emscripten_version: "6.0.13",
    files,
    language_server_api: 1,
    library_version: titanLibrarySeries,
    release,
    sdk_digests: files.slice(0, semanticFiles.length).map(({ path, sha256 }) => ({ path, sha256 })),
    source_rock: { name: `titan-${release}-1.src.rock`, sha256: rockSha256 },
    tag,
    titan_commit: commit
  };
  assert(members.get("manifest.json").equals(Buffer.from(`${JSON.stringify(manifest)}\n`)),
    "browser companion manifest disagrees with the exact release pair, SDK inventory or build profile");
  return members;
}

async function regularBytes(root, relative) {
  const filename = path.join(root, relative);
  const metadata = await lstat(filename);
  assert(metadata.isFile() && metadata.size > 0 && metadata.size <= maxPack,
    `not a nonempty regular browser pack file: ${filename}`);
  return readFile(filename);
}

export async function verifyBrowserNotices(sdk, readNotice) {
  for (const name of semanticNotices) {
    const expected = await regularBytes(sdk, `share/titan/${name}`);
    const actual = await readNotice(name);
    assert(actual?.equals(expected), `packaged browser notice differs from the selected SDK: ${name}`);
  }
}

export async function verifyInstalledBrowserPack(compiler, assets = compiler, { release, profile } = {}) {
  const lua = path.join(compiler, "bin", process.platform === "win32" ? "lua.exe" : "lua");
  const script = fileURLToPath(new URL("./verify-browser-semantics.lua", import.meta.url));
  const args = [script, compiler, assets];
  if (release !== undefined) args.push(release);
  const probe = spawnSync(lua, args, {
    env: { ...compilerDiscoveryEnvironment(), TITAN_ROOT: compiler },
    encoding: "utf8", shell: false, windowsHide: true
  });
  if (probe.error) throw probe.error;
  assert.equal(probe.status, 0, `invalid full browser semantic pack in ${assets}: ${probe.stderr}`);
  if (profile !== undefined) {
    assert.equal(probe.stdout.trim(), profile, "browser descriptor build profile differs from companion");
  }
}

async function ensureDirectories(sdk, directoryName) {
  let directory = sdk;
  for (const component of directoryName.split("/")) {
    directory = path.join(directory, component);
    try { await mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
    assert((await lstat(directory)).isDirectory(), `browser pack destination is not a real directory: ${directory}`);
  }
  return directory;
}

export async function installBrowserCompanion(sdk, archive, expected) {
  const release = releaseFromTag(expected.tag);
  const packName = `titan-${release}-1-browser-semantics.tar.gz`;
  const provenance = { release, profile: expected.profile };
  assert.equal(path.basename(archive), packName, "unexpected browser companion basename");
  assert((await lstat(sdk)).isDirectory(), `browser pack SDK is not a real directory: ${sdk}`);
  const members = verifyBrowserCompanion(await regularBytes(path.dirname(archive), packName), expected);
  await verifyBrowserNotices(sdk, (name) => members.get(`share/titan/${name}`));
  const parent = await ensureDirectories(sdk, path.posix.dirname(semanticDirectory));
  const destination = path.join(sdk, semanticDirectory);
  const current = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current !== null) {
    assert(current.isDirectory(), `browser pack destination is not a real directory: ${destination}`);
    for (const name of semanticFiles) {
      const installed = await regularBytes(destination, name).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        throw new Error(`cached SDK has a partial browser companion, missing ${name}; provision a clean SDK`);
      });
      assert(installed.equals(members.get(`${semanticDirectory}/${name}`)),
        `cached SDK browser semantic file differs from the exact companion: ${name}`);
    }
    await verifyInstalledBrowserPack(sdk, sdk, provenance);
    return;
  }
  // Stage on the same volume and publish the three verified files together.
  // An interrupted install cannot leave a usable-looking partial directory.
  const staging = await mkdtemp(path.join(parent, ".browser-pack-"));
  try {
    const scratch = await ensureDirectories(staging, semanticDirectory);
    for (const name of semanticFiles) {
      await writeFile(path.join(scratch, name), members.get(`${semanticDirectory}/${name}`),
        { flag: "wx", mode: 0o644 });
    }
    await verifyInstalledBrowserPack(sdk, staging, provenance);
    await rename(scratch, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--install" && args.length === 6) {
    const [sdk, archive, packSha256, rockSha256, commit, profile] = args;
    await installBrowserCompanion(sdk, archive, {
      tag: process.env.TITAN_RELEASE, packSha256, rockSha256, commit, profile
    });
  } else if (mode === "--check-prefix" && args.length <= 2) {
    await verifyInstalledBrowserPack(args[0] ?? resolveTitanSdk(), args[1]);
  } else if (mode === "--check-notices" && args.length === 2) {
    await verifyBrowserNotices(args[0], (name) => regularBytes(args[1], name));
  } else {
    throw new Error("usage: TITAN_RELEASE=vX.Y.Z browser-semantic-pack.mjs --install SDK PACK PACK_SHA256 ROCK_SHA256 COMMIT PROFILE | " +
      "--check-prefix [SDK [SEMANTIC_SDK]] | --check-notices SDK PACKAGED_TITAN_NOTICES");
  }
}
