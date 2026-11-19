import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureRoot = fileURLToPath(new URL("../test/fixtures/browser-analysis/", import.meta.url));
export const browserDirectory = "lib/titan-browser/0.6";
export const semanticFiles = ["absent-modules", "analysis-target", "titan.a"];
export const externalArchive = "browser_external.a";

// Only test-owned prefixes may receive these assets, never a packaging SDK.
export async function stageBrowserFixture(prefix, providers) {
  const semantics = join(prefix, browserDirectory);
  await mkdir(semantics, { recursive: true });
  for (const name of semanticFiles) {
    await copyFile(join(fixtureRoot, "sdk", browserDirectory, name),
      join(semantics, name), constants.COPYFILE_EXCL);
  }
  await mkdir(providers, { recursive: true });
  await copyFile(join(fixtureRoot, "providers", externalArchive),
    join(providers, externalArchive), constants.COPYFILE_EXCL);
}
