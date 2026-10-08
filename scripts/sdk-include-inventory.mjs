const includeRoot = [
  "lauxlib.h:file", "llhttp.h:file", "luaconf.h:file", "lua.h:file",
  "lua.hpp:file", "lualib.h:file", "minicoro.h:file", "sqlite3.h:file",
  "titan:directory", "titan.h:file", "uv:directory", "uv.h:file"
];
const windowsBacktraceHeaders = ["backtrace.h", "backtrace-supported.h"];

export function validateSdkIncludeInventory(entries, platform = process.platform) {
  const actual = [...entries].sort();
  const expected = [...includeRoot];
  if (actual.includes("openssl:directory")) expected.push("openssl:directory");
  // Makefile.win's runtime installer copies both libbacktrace headers. Older
  // seeded SDKs omit them; accept either layout, never a partial/irregular pair.
  if (platform === "win32" && actual.some((entry) =>
    windowsBacktraceHeaders.includes(entry.split(":")[0]))) {
    expected.push(...windowsBacktraceHeaders.map((name) => `${name}:file`));
  }
  expected.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Titan SDK include tree inventory changed: expected ${
      JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}
