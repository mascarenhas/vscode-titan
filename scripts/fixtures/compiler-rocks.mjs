import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compilerRocks, rockDirectory } from "../compiler-rocks.mjs";

export async function installedRocks(context, platform = "win32") {
  const sdk = await mkdtemp(path.join(tmpdir(), "titan-installed-rocks-"));
  context.after(() => rm(sdk, { recursive: true, force: true }));
  const manifests = new Map();
  async function put(filename, data) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, data);
  }
  for (const component of compilerRocks(platform)) {
    const directory = rockDirectory(sdk, component);
    const manifest = new Map();
    const putMember = async (filename, member, data) => {
      await put(filename, data);
      manifest.set(member, createHash("md5").update(data).digest("hex"));
    };
    const specName = `${component.directory ?? component.rockName}-${component.version}.rockspec`;
    await putMember(path.join(directory, specName), specName,
      `package = "${component.rockName}"\nversion = "${component.version}"\n`);
    for (const [installed, member] of component.payloads) {
      const data = component.embeddedLicense
        ? `inspect._LICENSE = [[\n${component.markers.join("\n")}\n]]\n`
        : `${component.name} installed ${installed}\n`;
      await putMember(path.join(sdk, installed), member, data);
    }
    if (component.license) await putMember(path.join(directory, component.license), component.license,
      component.markers.join("\n") + "\n");
    const manifestFile = path.join(directory, "rock_manifest");
    await put(manifestFile, "rock_manifest = {}\n");
    manifests.set(manifestFile, manifest);
  }
  await put(path.join(sdk, "share/titan/LICENSES/libuv-LICENSE"),
    "Copyright (c) 2015-present libuv project contributors.\nPermission is hereby granted\n");
  for (const [name, marker] of [
    ["libuv-LICENSE-extra", "Copyright Joyent, Inc. and other Node contributors."],
    ["libuv-tree-LICENSE", "Copyright 2002 Niels Provos"],
    ["libuv-inet-LICENSE", "Copyright (c) 2004 by Internet Systems Consortium, Inc."]
  ]) await put(path.join(sdk, "share/titan/LICENSES", name), marker + "\n");
  return { sdk, manifests, put, manifestReader: async (filename) => manifests.get(filename) };
}
