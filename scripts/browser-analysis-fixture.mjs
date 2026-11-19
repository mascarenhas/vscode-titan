import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureRoot = fileURLToPath(new URL("../test/fixtures/browser-analysis/", import.meta.url));
export const browserDirectory = "lib/titan-browser/0.6";
export const semanticFiles = ["absent-modules", "analysis-target", "titan.a"];
export const externalArchive = "browser_external.a";

const repository = fileURLToPath(new URL("../", import.meta.url));

function inside(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function physicalRoot(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolve(path);
  }
}

async function ownedDirectory(root, components) {
  let directory = root;
  for (const part of components) {
    directory = join(directory, part);
    try {
      await mkdir(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(`browser fixture destination is not an owned directory: ${directory}`);
    }
  }
  return directory;
}

// Both destinations are children of a test-owned root. Reject every directory
// link before descending or creating files, even on a native-only SDK.
export async function stageBrowserFixture(root) {
  const disposable = await realpath(root);
  for (const path of [repository, process.env.TITAN_PREFIX, process.env.TITAN_ROOT]) {
    if (!path) continue;
    const protectedRoot = await physicalRoot(path);
    if (inside(protectedRoot, disposable) || inside(disposable, protectedRoot)) {
      throw new Error(`browser fixture root is not disposable: ${disposable}`);
    }
  }
  const semantics = await ownedDirectory(disposable, ["sdk", ...browserDirectory.split("/")]);
  const providers = await ownedDirectory(disposable, ["providers"]);
  for (const name of semanticFiles) {
    await copyFile(join(fixtureRoot, "sdk", browserDirectory, name),
      join(semantics, name), constants.COPYFILE_EXCL);
  }
  await copyFile(join(fixtureRoot, "providers", externalArchive),
    join(providers, externalArchive), constants.COPYFILE_EXCL);
}
