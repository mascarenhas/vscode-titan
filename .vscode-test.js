const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig({
  files: "dist-test/src/test/suite/**/*.test.js",
  version: "1.106.0",
  workspaceFolder: "test/fixtures/multiroot.code-workspace",
  env: {
    TITAN_PREFIX: undefined,
    TITAN_ROCKS_ROOT: undefined
  },
  mocha: {
    timeout: 10000
  }
});
