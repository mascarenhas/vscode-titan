const includeRoot = [
  "lauxlib.h:file", "llhttp.h:file", "luaconf.h:file", "lua.h:file",
  "lua.hpp:file", "lualib.h:file", "minicoro.h:file", "sqlite3.h:file",
  "titan:directory", "titan.h:file", "uv:directory", "uv.h:file"
];
const windowsBacktraceHeaders = ["backtrace.h", "backtrace-supported.h"];

export function validateSdkIncludeInventory(entries, platform = process.platform) {
  const actual = [...entries].sort();
  const expected = [...includeRoot];
  if (actual.some((entry) => entry.startsWith("openssl:"))) expected.push("openssl:directory");
  // Makefile.win's runtime installer copies both libbacktrace headers. Older
  // seeded SDKs omit them; accept either layout, never a partial/irregular pair.
  if (platform === "win32" && actual.some((entry) =>
    windowsBacktraceHeaders.includes(entry.split(":")[0]))) {
    expected.push(...windowsBacktraceHeaders.map((name) => `${name}:file`));
  }
  expected.sort();
  // A general SDK may contain headers for other installed packages. Validate
  // and return the reviewed roots, without shipping those unrelated inputs.
  const selectedNames = new Set(expected.map((entry) => entry.split(":")[0]));
  const selected = actual.filter((entry) => selectedNames.has(entry.split(":")[0]));
  if (JSON.stringify(selected) !== JSON.stringify(expected)) {
    throw new Error(`Titan SDK include tree inventory changed: expected ${
      JSON.stringify(expected)}, found ${JSON.stringify(selected)}`);
  }
  return expected;
}
