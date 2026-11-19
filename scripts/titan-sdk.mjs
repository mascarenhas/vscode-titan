import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function environmentValue(environment, name, platform) {
  return platform === "win32"
    ? Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
    : environment[name];
}

export function childEnvironment(inherited, overrides, removed = [], platform = process.platform) {
  if (platform !== "win32") {
    const environment = { ...inherited };
    for (const name of removed) delete environment[name];
    return { ...environment, ...overrides };
  }
  const selected = new Map();
  for (const [name, value] of Object.entries(inherited)) {
    selected.set(name.toUpperCase(), [name, value]);
  }
  for (const name of removed) selected.delete(name.toUpperCase());
  for (const [name, value] of Object.entries(overrides)) {
    selected.set(name.toUpperCase(), [name, value]);
  }
  return Object.fromEntries(selected.values());
}

export function compilerDiscoveryEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^(LUA_(PATH|CPATH|INIT)(_[0-9_]+)?|TITAN_(PREFIX|ROOT|PATH(_[0-9_]+)?|SOURCE_PATH))$/i.test(name)));
}

// The installation's own compiler entry, run directly with native arguments.
// Windows ships bin/titanc.exe; Unix deploys the extensionless titanc script.
// Either entry resolves its installation root and compiler script itself.
export function titanCompilerCommand(prefix, args = [], platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return {
    command: paths.join(prefix, "bin", platform === "win32" ? "titanc.exe" : "titanc"),
    args
  };
}

export function findWindowsCompiler(environment, executable = (filename) => {
  try { accessSync(filename, constants.F_OK); return true; } catch { return false; }
}) {
  const extensions = (environmentValue(environment, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const directory of (environmentValue(environment, "PATH", "win32") ?? "").split(";")) {
    if (!directory) continue;
    for (const extension of [...extensions, ""]) {
      const filename = path.win32.join(directory.replace(/^"(.*)"$/, "$1"), `titanc${extension}`);
      if (executable(filename)) return filename;
    }
  }
  throw new Error("titanc was not found on PATH; install Titan or set TITAN_PREFIX");
}

export function resolveTitanSdk({ prefix, environment = process.env, platform = process.platform,
  run = spawnSync, findCompiler = findWindowsCompiler } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = prefix ?? environmentValue(environment, "TITAN_PREFIX", platform);
  if (override) return paths.resolve(override);
  const env = compilerDiscoveryEnvironment(environment);
  const invocation = { command: platform === "win32" ? findCompiler(env) : "titanc", args: [] };
  const queryOptions = {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10000
  };
  let queryFlag = "--print-root";
  let result = run(invocation.command, [...invocation.args, queryFlag], queryOptions);
  // Titan 0.6's release predates the installation-root option rename. Retry
  // only that CLI rejection, preserving real discovery and startup failures.
  if (!result.error && result.status !== 0 &&
      /(?:^|\r?\n)Error: unknown option '--print-root'(?:\r?\n|$)/.test(result.stderr ?? "")) {
    queryFlag = "--print-prefix";
    result = run(invocation.command, [...invocation.args, queryFlag], queryOptions);
  }
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr?.trim() ?? `exit status ${result.status}`;
    throw new Error(`cannot discover the Titan SDK with titanc ${queryFlag}: ${reason}. ` +
      "Install a compiler supporting --print-root or set TITAN_PREFIX");
  }
  const discovered = (result.stdout ?? "").replace(/\r?\n$/, "");
  if (!discovered || /[\0\r\n]/.test(discovered) || !paths.isAbsolute(discovered)) {
    throw new Error(`titanc ${queryFlag} did not return one absolute installation prefix`);
  }
  // Extended Windows paths preserve literal components, including `..`.
  return platform === "win32" && discovered.startsWith("\\\\?\\") ? discovered : paths.normalize(discovered);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--print-prefix") {
      throw new Error("usage: titan-sdk.mjs --print-prefix");
    }
    console.log(resolveTitanSdk());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
