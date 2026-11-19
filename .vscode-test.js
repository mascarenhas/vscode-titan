const { rmSync } = require("node:fs");
const { join } = require("node:path");
const { defineConfig } = require("@vscode/test-cli");

module.exports = (async () => {
  const { prepareExtensionHostWorkspace } =
    await import("./scripts/extension-host-workspace.mjs");
  const { directory, workspace } = await prepareExtensionHostWorkspace();

  // test-cli awaits Electron and then calls process.exit(), so an async
  // cleanup (including beforeExit) would not run on the normal exit path.
  process.once("exit", () => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cause) {
      console.error(`Could not remove Extension Host workspace ${directory}:`, cause);
    }
  });

  const profile = join(directory, "user-data");
  const extensions = join(directory, "extensions");
  // test-electron launches through cmd.exe on Windows. Its workspaceFolder
  // argument is appended unquoted, so supply explicitly quoted owned paths.
  const windows = process.platform === "win32";
  return defineConfig({
    files: "dist-test/src/test/suite/**/*.test.js",
    version: "1.106.0",
    workspaceFolder: windows ? undefined : workspace,
    launchArgs: windows
      ? [`--user-data-dir="${profile}"`, `--extensions-dir="${extensions}"`, `"${workspace}"`]
      : [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`],
    useInstallation: process.env.TITAN_LSP_TEST_CODE
      ? { fromPath: process.env.TITAN_LSP_TEST_CODE }
      : undefined,
    env: {
      TITAN_LSP_TEST_FIXTURE_LEASE: "1",
      npm_node_execpath: process.env.npm_node_execpath ?? process.execPath,
      TITAN_PREFIX: undefined,
      TITAN_ROOT: undefined
    },
    mocha: {
      timeout: 10000
    }
  });
})();
