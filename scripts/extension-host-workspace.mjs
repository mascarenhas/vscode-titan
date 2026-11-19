import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const templates = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const folders = [
  { name: "alpha", path: "workspace" },
  { name: "beta", path: "workspace-beta" }
];

export async function prepareExtensionHostWorkspace() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()),
    "vscode-titan-extension-host-"));
  try {
    for (const folder of folders) {
      const root = path.join(directory, folder.path);
      const vscode = path.join(root, ".vscode");
      await mkdir(vscode, { recursive: true });
      await mkdir(path.join(root, ".titan-lsp-test"));
      // Only copy specific source inputs, never a possibly edited settings
      // file, a marker, a generated cache, or a link to a writable template.
      for (const name of ["sample.titan", "titan-config.lua"]) {
        await copyFile(path.join(templates, folder.path, name), path.join(root, name));
      }
      await writeFile(path.join(vscode, "settings.json"), JSON.stringify({
        "titan.languageServer.arguments": [
          "../fake-lsp-server.cjs", ".titan-lsp-test/events.jsonl", "--fixture-token", folder.name
        ]
      }, null, 2) + "\n");
    }
    await copyFile(path.join(templates, "fake-lsp-server.cjs"),
      path.join(directory, "fake-lsp-server.cjs"));
    const workspace = path.join(directory, "multiroot.code-workspace");
    await writeFile(workspace, JSON.stringify({ folders }, null, 2) + "\n");
    return { directory, workspace };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch((error) => {
      console.error(`Could not remove incomplete Extension Host workspace ${directory}:`, error);
    });
    throw cause;
  }
}
