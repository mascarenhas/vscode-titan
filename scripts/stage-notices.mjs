import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

const repositoryRoot = process.cwd();
const titanRepository = path.resolve(
  repositoryRoot,
  process.env.TITAN_REPO ?? "../titan"
);
const titanPrefix = path.resolve(
  repositoryRoot,
  process.env.TITAN_PREFIX ?? ".titan"
);
const outputRoot = path.join(repositoryRoot, "dist", "notices");

const runtimePackages = [
  "semver",
  "vscode-jsonrpc",
  "vscode-languageclient",
  "vscode-languageserver-protocol",
  "vscode-languageserver-textdocument",
  "vscode-languageserver-types"
];

const licenseNames = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "License.txt",
  "NOTICE",
  "NOTICE.md",
  "NOTICE.txt",
  "thirdpartynotices.txt"
];

async function copyRequired(source, destination, description) {
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (cause) {
    throw new Error(`cannot stage ${description} from ${source}: ${cause.message}`);
  }
}

async function stageTitanNotices() {
  const destination = path.join(outputRoot, "titan");
  await copyRequired(
    path.join(titanRepository, "LICENSE"),
    path.join(destination, "LICENSE"),
    "Titan license"
  );
  await copyRequired(
    path.join(titanPrefix, "share", "titan", "THIRD_PARTY_NOTICES.md"),
    path.join(destination, "THIRD_PARTY_NOTICES.md"),
    "Titan third-party notices"
  );

  const sourceLicenses = path.join(titanPrefix, "share", "titan", "LICENSES");
  const entries = (await readdir(sourceLicenses, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    throw new Error(`Titan license directory is empty: ${sourceLicenses}`);
  }
  for (const entry of entries) {
    await copyRequired(
      path.join(sourceLicenses, entry.name),
      path.join(destination, "LICENSES", entry.name),
      `Titan dependency license ${entry.name}`
    );
  }
}

async function stageJavaScriptNotices() {
  const bundledPackages = JSON.parse(
    await readFile(path.join(repositoryRoot, "dist", "bundled-packages.json"), "utf8")
  );
  if (JSON.stringify(bundledPackages) !== JSON.stringify(runtimePackages)) {
    throw new Error(
      "bundled JavaScript packages changed without a matching notice inventory: " +
      JSON.stringify(bundledPackages)
    );
  }
  const versions = [];
  for (const packageName of runtimePackages) {
    const packageRoot = path.join(repositoryRoot, "node_modules", packageName);
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8")
    );
    const destination = path.join(outputRoot, "javascript", packageName);
    await mkdir(destination, { recursive: true });
    let copied = 0;
    for (const filename of licenseNames) {
      try {
        await copyFile(
          path.join(packageRoot, filename),
          path.join(destination, filename)
        );
        copied += 1;
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
    }
    if (copied === 0) {
      throw new Error(`no license or notice found for bundled package ${packageName}`);
    }
    versions.push(`${packageName} ${manifest.version}`);
  }
  return versions;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "javascript"), { recursive: true });
await stageTitanNotices();
const versions = await stageJavaScriptNotices();
await writeFile(
  path.join(outputRoot, "README.md"),
  [
    "# Bundled component notices",
    "",
    "This VSIX contains the native Titan runtime and standard library plus a",
    "bundled JavaScript language client. Their license and notice files are",
    "preserved below. The extension's own license is at the VSIX root.",
    "",
    "## Bundled JavaScript packages",
    "",
    ...versions.map((entry) => `- ${entry}`),
    ""
  ].join("\n"),
  "utf8"
);

console.log(`staged bundled-component notices in ${path.relative(repositoryRoot, outputRoot)}`);
