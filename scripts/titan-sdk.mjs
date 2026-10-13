import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function environmentValue(environment, name, platform) {
  return platform === "win32"
    ? Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
    : environment[name];
}

export function compilerDiscoveryEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^(LUA_(PATH|CPATH|INIT)(_[0-9_]+)?|TITAN_(PREFIX|ROCKS_ROOT|PATH(_[0-9_]+)?|SOURCE_PATH))$/i.test(name)));
}

// Windows LuaRocks installs a batch wrapper with installation-specific paths.
// Use its adjacent Lua and deployed script so native argv and relocation work.
export function titanCompilerCommand(prefix, args = [], platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32" ? {
    command: paths.join(prefix, "bin", "lua.exe"),
    args: ["-E", paths.join(prefix, "lib", "luarocks", "rocks-5.5", "titan", "0.6.0-1", "bin", "titanc"), ...args]
  } : { command: paths.join(prefix, "bin", "titanc"), args };
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
  run = spawnSync, findCompiler = findWindowsCompiler, realpath = realpathSync } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = prefix ?? environmentValue(environment, "TITAN_PREFIX", platform);
  if (override) return paths.resolve(override);
  const env = compilerDiscoveryEnvironment(environment);
  let invocation = { command: "titanc", args: ["--print-prefix"] };
  if (platform === "win32") {
    const compiler = findCompiler(env);
    if (/\.(bat|cmd)$/i.test(compiler)) {
      const installed = realpath(compiler);
      invocation = titanCompilerCommand(paths.dirname(paths.dirname(installed)), ["--print-prefix"], platform);
    } else invocation.command = compiler;
  }
  const result = run(invocation.command, invocation.args, {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10000
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr?.trim() ?? `exit status ${result.status}`;
    throw new Error(`cannot discover the Titan SDK with titanc --print-prefix: ${reason}. ` +
      "Install a compiler supporting --print-prefix or set TITAN_PREFIX");
  }
  const discovered = (result.stdout ?? "").replace(/\r?\n$/, "");
  if (!discovered || /[\0\r\n]/.test(discovered) || !paths.isAbsolute(discovered)) {
    throw new Error("titanc --print-prefix did not return one absolute installation prefix");
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
