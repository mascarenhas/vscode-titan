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
  DEFAULT_SERVER_LOG_LEVEL,
  LANGUAGE_SERVER_LUA_CPATH_ENVIRONMENT_VARIABLE,
  LANGUAGE_SERVER_LUA_PATH_ENVIRONMENT_VARIABLE,
  LANGUAGE_SERVER_TITAN_ROOT_ENVIRONMENT_VARIABLE,
  SERVER_BASENAME,
  SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE,
  ServerConfigurationError,
  createInitializationOptions,
  createServerLaunchOptions,
  ensureServerExecutable,
  formatServerStartup,
  formatStartupError,
  packagedServerName,
  readCompilerDiscoveryConfiguration,
  readCompletionConfiguration,
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
  test("defaults to call snippets and accepts the function-reference opt-out", () => {
    assert.deepEqual(readCompletionConfiguration(), { insertCallSnippets: true });
    assert.deepEqual(readCompletionConfiguration(false), { insertCallSnippets: false });
    assert.throws(
      () => readCompletionConfiguration("false"),
      (error: unknown) => error instanceof ServerConfigurationError &&
        /insertCallSnippets must be a boolean/.test(error.message)
    );
  });
  test("declares the folder the session owns as its only trusted root", () => {
    const roots = ["/work/slice"];
    const options = createInitializationOptions(
      readCompletionConfiguration(false),
      roots
    );
    assert.deepEqual(options, {
      insertCallSnippets: false,
      trustedRoots: ["/work/slice"]
    });
    assert.notEqual(options.trustedRoots, roots);
    assert.equal(roots.length, 1, "initialization options mutated the caller");
  });

  test("rejects empty or non-string trusted roots", () => {
    const completion = readCompletionConfiguration();
    assert.throws(
      () => createInitializationOptions(completion, [""]),
      (error: unknown) => error instanceof ServerConfigurationError &&
        /trustedRoots must be an array of absolute directory paths/.test(
          error.message
        )
    );
    assert.throws(
      () => createInitializationOptions(completion, [42 as unknown as string]),
      (error: unknown) => error instanceof ServerConfigurationError
    );
  });

  test("normalizes a configured path and copies arguments", () => {
    const argumentsSetting = ["--trace", "messages"];
    const configuration = readServerConfiguration(
      "  tools/titan-language-server  ",
      argumentsSetting
    );

    assert.deepEqual(configuration, {
      configuredPath: "tools/titan-language-server",
      arguments: ["--trace", "messages"],
      logLevel: DEFAULT_SERVER_LOG_LEVEL
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
    for (const level of ["off", "error", "info", "debug", "trace"] as const) {
      assert.equal(readServerConfiguration("", [], level).logLevel, level);
    }
    assert.throws(
      () => readServerConfiguration("", [], "verbose"),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /logLevel must be one of/.test(error.message)
    );
  });

  test("reads compiler paths verbatim and names the packaged installation root", () => {
    assert.deepEqual(
      readCompilerDiscoveryConfiguration(
        "./compiler/?.lua",
        "./compiler/?.so",
        "/extension"
      ),
      {
        luaPath: "./compiler/?.lua",
        luaCPath: "./compiler/?.so",
        titanRoot: path.join("/extension", "dist", "titan")
      }
    );
  });

  test("resolves empty compiler paths to the packaged Lua trees", () => {
    const extensionRoot = path.join(path.sep, "extension with spaces");
    assert.deepEqual(
      readCompilerDiscoveryConfiguration("", "", extensionRoot),
      {
        luaPath: [
          path.join(
            extensionRoot, "dist", "titan", "share", "lua", "5.5", "?.lua"
          ),
          path.join(
            extensionRoot, "dist", "titan", "share", "lua", "5.5", "?",
            "init.lua"
          )
        ].join(";"),
        luaCPath: path.join(
          extensionRoot, "dist", "titan", "lib", "lua", "5.5",
          process.platform === "win32" ? "?.dll" : "?.so"
        ),
        titanRoot: path.join(extensionRoot, "dist", "titan")
      }
    );
  });

  test("applies compiler path overrides independently", () => {
    const extensionRoot = path.join(path.sep, "extension");
    const sourceOverride = readCompilerDiscoveryConfiguration(
      "/configured/?.lua", "", extensionRoot
    );
    assert.equal(sourceOverride.luaPath, "/configured/?.lua");
    assert.equal(
      sourceOverride.luaCPath,
      path.join(
        extensionRoot, "dist", "titan", "lib", "lua", "5.5",
        process.platform === "win32" ? "?.dll" : "?.so"
      )
    );

    const nativeOverride = readCompilerDiscoveryConfiguration(
      "", "/configured/?.so", extensionRoot
    );
    assert.equal(
      nativeOverride.luaPath,
      [
        path.join(
          extensionRoot, "dist", "titan", "share", "lua", "5.5", "?.lua"
        ),
        path.join(
          extensionRoot, "dist", "titan", "share", "lua", "5.5", "?",
          "init.lua"
        )
      ].join(";")
    );
    assert.equal(nativeOverride.luaCPath, "/configured/?.so");
  });

  test("selects native Lua module suffix for each target platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const extensionRoot = path.resolve("extension with spaces");
      assert.equal(
        readCompilerDiscoveryConfiguration("", "", extensionRoot, platform).luaCPath,
        path.join(extensionRoot, "dist", "titan", "lib", "lua", "5.5",
          platform === "win32" ? "?.dll" : "?.so")
      );
      assert.equal(
        readCompilerDiscoveryConfiguration("", "custom/?.native", extensionRoot, platform).luaCPath,
        "custom/?.native"
      );
    }
  });

  test("rejects non-string compiler discovery paths", () => {
    assert.throws(
      () => readCompilerDiscoveryConfiguration([], "", "/extension"),
      (error: unknown) =>
        error instanceof ServerConfigurationError &&
        /titan\.compiler\.luaPath must be a string/.test(error.message)
    );
    assert.throws(
      () => readCompilerDiscoveryConfiguration("", null, "/extension"),
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
      path.resolve(path.sep, "workspace", "tools", "server")
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
  test("resolves a lexical workspace symlink once before launch", async (context) => {
    const directory = await makeTemporaryDirectory();
    const physical = path.join(directory, "physical-workspace");
    const lexical = path.join(directory, "lexical-workspace");
    await mkdir(physical);
    try {
      await symlink(physical, lexical, "dir");
    } catch (cause) {
      if (process.platform === "win32" &&
          (cause as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows account cannot create directory symlinks");
        return;
      }
      throw cause;
    }

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

  test("rejects a non-executable file on POSIX", {
    skip: process.platform === "win32" ? "Windows has no POSIX execute bit" : false
  }, async () => {
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
    const sourceEnvironment = {
      TITAN_ROOT: "inherited-titan-root",
      TITAN_TEST_ENV: "configured"
    };
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
          TITAN_LS_LUA_CPATH: process.platform === "win32" ? "./?.dll" : "./?.so",
          TITAN_LS_LUA_PATH: "./?.lua",
          TITAN_LANGUAGE_SERVER_LOG_LEVEL: "debug",
          TITAN_TEST_ENV: "configured"
        }
      }
    });
    assert.notEqual(launch.args, args);
    assert.notEqual(launch.options.env, sourceEnvironment);
  });

  test("launches with resolved compiler discovery paths", () => {
    const sourceEnvironment = {
      LUA_PATH: "inherited-lua-path",
      LUA_CPATH: "inherited-lua-cpath",
      TITAN_LS_LUA_PATH: "inherited-server-lua-path",
      TITAN_LS_LUA_CPATH: "inherited-server-lua-cpath",
      TITAN_ROOT: "inherited-titan-root",
      TITAN_PREFIX: "inherited-cache-prefix",
      TITAN_TEST_ENV: "preserved"
    };

    const bundledDiscovery = readCompilerDiscoveryConfiguration(
      "", "", "/extension"
    );

    const inherited = createServerLaunchOptions(
      "/bin/titan-language-server",
      [],
      "/workspace/project",
      sourceEnvironment,
      bundledDiscovery
    );
    assert.deepEqual(inherited.options.env, {
      ...sourceEnvironment,
      [LANGUAGE_SERVER_LUA_PATH_ENVIRONMENT_VARIABLE]:
        bundledDiscovery.luaPath,
      [LANGUAGE_SERVER_LUA_CPATH_ENVIRONMENT_VARIABLE]:
        bundledDiscovery.luaCPath,
      [LANGUAGE_SERVER_TITAN_ROOT_ENVIRONMENT_VARIABLE]:
        bundledDiscovery.titanRoot,
      TITAN_LANGUAGE_SERVER_LOG_LEVEL: "debug"
    });

    const configured = createServerLaunchOptions(
      "/bin/titan-language-server",
      [],
      "/workspace/project",
      sourceEnvironment,
      {
        luaPath: "/opt/titan/compiler/?.lua",
        luaCPath: "/opt/titan/compiler/?.so",
        titanRoot: "/opt/titan"
      },
      "debug"
    );
    assert.deepEqual(configured.options.env, {
      LUA_PATH: "inherited-lua-path",
      LUA_CPATH: "inherited-lua-cpath",
      TITAN_LS_LUA_PATH: "/opt/titan/compiler/?.lua",
      TITAN_LS_LUA_CPATH: "/opt/titan/compiler/?.so",
      TITAN_ROOT: "/opt/titan",
      TITAN_PREFIX: "inherited-cache-prefix",
      TITAN_LANGUAGE_SERVER_LOG_LEVEL: "debug",
      TITAN_TEST_ENV: "preserved"
    });
    assert.deepEqual(sourceEnvironment, {
      LUA_PATH: "inherited-lua-path",
      LUA_CPATH: "inherited-lua-cpath",
      TITAN_LS_LUA_PATH: "inherited-server-lua-path",
      TITAN_LS_LUA_CPATH: "inherited-server-lua-cpath",
      TITAN_ROOT: "inherited-titan-root",
      TITAN_PREFIX: "inherited-cache-prefix",
      TITAN_TEST_ENV: "preserved"
    });
  });

  test("passes the configured server log level through the launch environment", () => {
    const launch = createServerLaunchOptions(
      "/bin/titan-language-server",
      [],
      "/workspace/project",
      { [SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE]: "inherited" },
      { luaPath: "./?.lua", luaCPath: "./?.so", titanRoot: "" },
      "trace"
    );

    assert.equal(
      launch.options.env[SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE],
      "trace"
    );
  });

  test("attributes the configured emission level before server startup", () => {
    assert.equal(
      formatServerStartup("/bin/titan-language-server", "trace"),
      "Starting Titan language server: /bin/titan-language-server " +
        "(configured server log emission: trace)"
    );
  });

  test("formats actionable startup errors", () => {
    assert.equal(
      formatStartupError("example", new Error("permission denied")),
      "[example] Titan language server failed to start: permission denied"
    );
  });
});
