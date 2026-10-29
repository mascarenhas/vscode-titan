import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export const PACKAGED_SERVER_DIRECTORY = "bin";
export const SERVER_BASENAME = "titan-language-server";
export const PACKAGED_LUA_PREFIX_DIRECTORY = path.join("dist", "titan");
export const LANGUAGE_SERVER_LUA_PATH_ENVIRONMENT_VARIABLE =
  "TITAN_LS_LUA_PATH";
export const LANGUAGE_SERVER_LUA_CPATH_ENVIRONMENT_VARIABLE =
  "TITAN_LS_LUA_CPATH";
export const LANGUAGE_SERVER_TITAN_ROOT_ENVIRONMENT_VARIABLE = "TITAN_ROOT";
export const SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE =
  "TITAN_LANGUAGE_SERVER_LOG_LEVEL";

export type ServerLogLevel = "off" | "error" | "info" | "debug" | "trace";

export const DEFAULT_SERVER_LOG_LEVEL: ServerLogLevel = "debug";

const SERVER_LOG_LEVELS = new Set<ServerLogLevel>([
  "off",
  "error",
  "info",
  "debug",
  "trace"
]);

export interface ServerConfiguration {
  configuredPath: string;
  arguments: string[];
  logLevel: ServerLogLevel;
}

export interface CompilerDiscoveryConfiguration {
  luaPath: string;
  luaCPath: string;
  /** Installation root whose headers and Lua sources accompany the modules. */
  titanRoot: string;
}

export interface CompletionConfiguration {
  insertCallSnippets: boolean;
}

export function readCompletionConfiguration(
  insertCallSnippets: unknown = true
): CompletionConfiguration {
  if (typeof insertCallSnippets !== "boolean") {
    throw new ServerConfigurationError(
      "titan.completion.insertCallSnippets must be a boolean"
    );
  }
  return { insertCallSnippets };
}

export interface ServerLaunchOptions {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
}

export class ServerConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServerConfigurationError";
  }
}

export function readServerConfiguration(
  configuredPath: unknown,
  configuredArguments: unknown,
  configuredLogLevel: unknown = DEFAULT_SERVER_LOG_LEVEL
): ServerConfiguration {
  if (typeof configuredPath !== "string") {
    throw new ServerConfigurationError(
      "titan.languageServer.path must be a string"
    );
  }

  if (!Array.isArray(configuredArguments) ||
      configuredArguments.some((argument) => typeof argument !== "string")) {
    throw new ServerConfigurationError(
      "titan.languageServer.arguments must be an array of strings"
    );
  }

  if (typeof configuredLogLevel !== "string" ||
      !SERVER_LOG_LEVELS.has(configuredLogLevel as ServerLogLevel)) {
    throw new ServerConfigurationError(
      "titan.languageServer.logLevel must be one of " +
      "off, error, info, debug, or trace"
    );
  }

  return {
    configuredPath: configuredPath.trim(),
    arguments: [...configuredArguments] as string[],
    logLevel: configuredLogLevel as ServerLogLevel
  };
}

export function readCompilerDiscoveryConfiguration(
  configuredLuaPath: unknown,
  configuredLuaCPath: unknown,
  extensionRoot: string,
  platform: NodeJS.Platform = process.platform
): CompilerDiscoveryConfiguration {
  if (typeof configuredLuaPath !== "string") {
    throw new ServerConfigurationError(
      "titan.compiler.luaPath must be a string"
    );
  }
  if (typeof configuredLuaCPath !== "string") {
    throw new ServerConfigurationError(
      "titan.compiler.luaCPath must be a string"
    );
  }

  const prefix = path.join(extensionRoot, PACKAGED_LUA_PREFIX_DIRECTORY);
  const sourceRoot = path.join(prefix, "share", "lua", "5.5");
  const nativeRoot = path.join(prefix, "lib", "lua", "5.5");
  return {
    luaPath: configuredLuaPath.length > 0
      ? configuredLuaPath
      : [
          path.join(sourceRoot, "?.lua"),
          path.join(sourceRoot, "?", "init.lua")
        ].join(";"),
    luaCPath: configuredLuaCPath.length > 0
      ? configuredLuaCPath
      : path.join(nativeRoot, platform === "win32" ? "?.dll" : "?.so"),
    // The packaged payload is a complete compiler installation root: it holds
    // the SDK headers and Lua sources that C imports and live analysis read.
    // The compiler derives nothing from a Lua search path, so name it here.
    titanRoot: prefix
  };
}

export function packagedServerName(
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? `${SERVER_BASENAME}.exe` : SERVER_BASENAME;
}

export function resolveServerExecutable(
  configuredPath: string,
  workspaceRoot: string,
  extensionRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (configuredPath.length > 0) {
    return path.isAbsolute(configuredPath)
      ? path.normalize(configuredPath)
      : path.resolve(workspaceRoot, configuredPath);
  }

  return path.join(
    extensionRoot,
    PACKAGED_SERVER_DIRECTORY,
    packagedServerName(platform)
  );
}

export async function ensureServerExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  let file;
  try {
    file = await stat(command);
  } catch (cause) {
    throw new ServerConfigurationError(
      `Titan language server was not found at ${command}: ${describeError(cause)}`
    );
  }

  if (!file.isFile()) {
    throw new ServerConfigurationError(
      `Titan language server path is not a file: ${command}`
    );
  }

  try {
    await access(command, platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch (cause) {
    throw new ServerConfigurationError(
      `Titan language server is not executable at ${command}: ${describeError(cause)}`
    );
  }
}

export async function resolvePhysicalWorkspaceRoot(
  workspaceRoot: string
): Promise<string> {
  try {
    return await realpath(workspaceRoot);
  } catch (cause) {
    throw new ServerConfigurationError(
      `Titan workspace root could not be resolved at ${workspaceRoot}: ${
        describeError(cause)
      }`
    );
  }
}

export function createServerLaunchOptions(
  command: string,
  args: readonly string[],
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  compilerDiscovery: CompilerDiscoveryConfiguration = {
    luaPath: "./?.lua",
    luaCPath: process.platform === "win32" ? "./?.dll" : "./?.so",
    titanRoot: ""
  },
  logLevel: ServerLogLevel = DEFAULT_SERVER_LOG_LEVEL
): ServerLaunchOptions {
  const childEnvironment = { ...environment };
  childEnvironment[SERVER_LOG_LEVEL_ENVIRONMENT_VARIABLE] = logLevel;
  childEnvironment[LANGUAGE_SERVER_LUA_PATH_ENVIRONMENT_VARIABLE] =
    compilerDiscovery.luaPath;
  childEnvironment[LANGUAGE_SERVER_LUA_CPATH_ENVIRONMENT_VARIABLE] =
    compilerDiscovery.luaCPath;
  if (compilerDiscovery.titanRoot.length > 0) {
    childEnvironment[LANGUAGE_SERVER_TITAN_ROOT_ENVIRONMENT_VARIABLE] =
      compilerDiscovery.titanRoot;
  } else {
    delete childEnvironment[LANGUAGE_SERVER_TITAN_ROOT_ENVIRONMENT_VARIABLE];
  }
  return {
    command,
    args: [...args],
    options: {
      cwd: workspaceRoot,
      env: childEnvironment
    }
  };
}

export function formatServerStartup(
  command: string,
  logLevel: ServerLogLevel
): string {
  return `Starting Titan language server: ${command} ` +
    `(configured server log emission: ${logLevel})`;
}

export function formatStartupError(
  workspaceName: string,
  cause: unknown
): string {
  return `[${workspaceName}] Titan language server failed to start: ${describeError(cause)}`;
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
