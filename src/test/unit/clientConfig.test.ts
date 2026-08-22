import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  SERVER_BASENAME,
  SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE,
  ServerConfigurationError,
  createServerLaunchOptions,
  ensureServerExecutable,
  formatStartupError,
  packagedServerName,
  readCompilerDiscoveryConfiguration,
  readServerConfiguration,
  resolvePhysicalWorkspaceRoot,
  resolveServerExecutable
} from "../../extension/clientConfig";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "vscode-titan-client-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("server configuration", () => {
  test("normalizes a configured path and copies arguments", () => {
    const argumentsSetting = ["--trace", "messages"];
    const configuration = readServerConfiguration(
      "  tools/titan-language-server  ",
      argumentsSetting
    );

    assert.deepEqual(configuration, {
      configuredPath: "tools/titan-language-server",
      arguments: ["--trace", "messages"],
      logLevel: "info"
    });
    assert.notEqual(configuration.arguments, argumentsSetting);
  });

  test("rejects non-string paths", () => {
    assert.throws(
      () => readServerConfiguration(42, []),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /must be a string/.test(error.message)
    );
  });

  test("rejects arguments containing non-strings", () => {
    assert.throws(
      () => readServerConfiguration("", ["--trace", 1]),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /array of strings/.test(error.message)
    );
  });

  test("validates the server log level", () => {
    assert.equal(
      readServerConfiguration("", [], "debug").logLevel,
      "debug"
    );
    assert.throws(
      () => readServerConfiguration("", [], "verbose"),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /logLevel must be one of/.test(error.message)
    );
  });

  test("reads compiler Lua discovery paths without rewriting them", () => {
    assert.deepEqual(
      readCompilerDiscoveryConfiguration(
        "./compiler/?.lua;;",
        "./compiler/?.so;;"
      ),
      {
        luaPath: "./compiler/?.lua;;",
        luaCPath: "./compiler/?.so;;"
      }
    );
  });

  test("rejects non-string compiler discovery paths", () => {
    assert.throws(
      () => readCompilerDiscoveryConfiguration([], ""),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /titan\.compiler\.luaPath must be a string/.test(error.message)
    );
    assert.throws(
      () => readCompilerDiscoveryConfiguration("", null),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /titan\.compiler\.luaCPath must be a string/.test(error.message)
    );
  });
});

describe("server executable resolution", () => {
  test("resolves a relative configured path from its workspace", () => {
    assert.equal(
      resolveServerExecutable(
        "tools/server",
        path.join(path.sep, "workspace"),
        path.join(path.sep, "extension")
      ),
      path.join(path.sep, "workspace", "tools", "server")
    );
  });

  test("preserves an absolute configured path", () => {
    const command = path.join(path.sep, "opt", "titan", "server");
    assert.equal(
      resolveServerExecutable(
        command,
        path.join(path.sep, "workspace"),
        path.join(path.sep, "extension")
      ),
      path.normalize(command)
    );
  });

  test("uses the packaged platform-specific executable by default", () => {
    const extensionRoot = path.join(path.sep, "extension");
    assert.equal(packagedServerName("linux"), SERVER_BASENAME);
    assert.equal(packagedServerName("win32"), `${SERVER_BASENAME}.exe`);
    assert.equal(
      resolveServerExecutable("", "/workspace", extensionRoot, "win32"),
      path.join(extensionRoot, "bin", `${SERVER_BASENAME}.exe`)
    );
  });
});

describe("server launch validation", () => {
  test("resolves a lexical workspace symlink once before launch", async () => {
    const directory = await makeTemporaryDirectory();
    const physical = path.join(directory, "physical-workspace");
    const lexical = path.join(directory, "lexical-workspace");
    await mkdir(physical);
    await symlink(physical, lexical, "dir");

    assert.equal(
      await resolvePhysicalWorkspaceRoot(lexical),
      await realpath(physical)
    );
  });

  test("accepts an executable regular file", async () => {
    const directory = await makeTemporaryDirectory();
    const command = path.join(directory, SERVER_BASENAME);
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);

    await assert.doesNotReject(ensureServerExecutable(command, "linux"));
  });

  test("rejects a missing executable", async () => {
    const directory = await makeTemporaryDirectory();
    const command = path.join(directory, "missing-server");

    await assert.rejects(
      ensureServerExecutable(command, "linux"),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /was not found/.test(error.message) &&
        error.message.includes(command)
    );
  });

  test("rejects a directory", async () => {
    const directory = await makeTemporaryDirectory();
    const command = path.join(directory, "server-directory");
    await mkdir(command);

    await assert.rejects(
      ensureServerExecutable(command, "linux"),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /is not a file/.test(error.message)
    );
  });

  test("rejects a non-executable file on POSIX", async () => {
    const directory = await makeTemporaryDirectory();
    const command = path.join(directory, SERVER_BASENAME);
    await writeFile(command, "not executable\n");
    await chmod(command, 0o644);

    await assert.rejects(
      ensureServerExecutable(command, "linux"),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /is not executable/.test(error.message)
    );
  });

  test("constructs isolated process options with the workspace as cwd", () => {
    const sourceEnvironment = { TITAN_TEST_ENV: "configured" };
    const args = ["--stdio"];
    const launch = createServerLaunchOptions(
      "/bin/titan-language-server",
      args,
      "/workspace/project",
      sourceEnvironment
    );

    assert.deepEqual(launch, {
      command: "/bin/titan-language-server",
      args: ["--stdio"],
      options: {
        cwd: "/workspace/project",
        env: {
          TITAN_LANGUAGE_SERVER_LOG_LEVEL: "info",
          TITAN_TEST_ENV: "configured"
        }
      }
    });
    assert.notEqual(launch.args, args);
    assert.notEqual(launch.options.env, sourceEnvironment);
  });

  test("overrides compiler discovery paths only when configured", () => {
    const sourceEnvironment = {
      LUA_PATH: "inherited-lua-path",
      LUA_CPATH: "inherited-lua-cpath",
      TITAN_TEST_ENV: "preserved"
    };

    const inherited = createServerLaunchOptions(
      "/bin/titan-language-server",
      [],
      "/workspace/project",
      sourceEnvironment,
      { luaPath: "", luaCPath: "" }
    );
    assert.deepEqual(inherited.options.env, {
      ...sourceEnvironment,
      TITAN_LANGUAGE_SERVER_LOG_LEVEL: "info"
    });

    const configured = createServerLaunchOptions(
      "/bin/titan-language-server",
      [],
      "/workspace/project",
      sourceEnvironment,
      {
        luaPath: "/opt/titan/compiler/?.lua;;",
        luaCPath: "/opt/titan/compiler/?.so;;"
      }
    );
    assert.deepEqual(configured.options.env, {
      LUA_PATH: "/opt/titan/compiler/?.lua;;",
      LUA_CPATH: "/opt/titan/compiler/?.so;;",
      TITAN_LANGUAGE_SERVER_LOG_LEVEL: "info",
      TITAN_TEST_ENV: "preserved"
    });
    assert.deepEqual(sourceEnvironment, {
      LUA_PATH: "inherited-lua-path",
      LUA_CPATH: "inherited-lua-cpath",
      TITAN_TEST_ENV: "preserved"
    });
  });

  test("passes the configured server log level through the launch environment", () => {
    const launch = createServerLaunchOptions(
      "/bin/titan-language-server",
      [],
      "/workspace/project",
      { [SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE]: "inherited" },
      { luaPath: "", luaCPath: "" },
      "trace"
    );

    assert.equal(
      launch.options.env[SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE],
      "trace"
    );
  });

  test("formats actionable startup errors", () => {
    assert.equal(
      formatStartupError("example", new Error("permission denied")),
      "[example] Titan language server failed to start: permission denied"
    );
  });
});
