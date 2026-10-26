import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repositoryMakefile = path.join(scripts, "..", "Makefile");

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "vscode-titan-openssl-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk");
  async function put(relative, contents = "fixture\n", executable = false) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
    if (executable) await chmod(filename, 0o755);
    return filename;
  }
  return { root, sdk, put };
}

async function compilerSDK(context) {
  const result = await fixture(context);
  const directories = ["share/lua/5.5/c-parser", "share/lua/5.5/titan", "share/lua/5.5/titan-compiler", "include/titan", "include/uv"];
  for (const directory of directories) await mkdir(path.join(result.sdk, directory), { recursive: true });
  for (const member of ["argparse.lua", "inspect.lua", "relabel.lua", "c-parser/cdriver.lua", "titan-compiler/checker.lua",
    "titan-compiler/checker/completion.lua", "titan-compiler/completion.lua", "titan-compiler/maybe3.lua", "titan-compiler/documentation.lua",
    "titan-compiler/parser.lua", "titan-compiler/path.lua", "titan-compiler/types.lua",
    "titan-compiler/build.lua", "titan-compiler/build_worker.lua", "titan-compiler/process.lua"]) {
    await result.put(`sdk/share/lua/5.5/${member}`);
  }
  await result.put("sdk/share/lua/5.5/titan-compiler/driver.lua", "driver.LANGUAGE_SERVER_API_VERSION = 1\n");
  await result.put("sdk/share/lua/5.5/titan-compiler/version.lua", 'LUA_VERSION = "5.5"\nTITAN_ABI_VERSION = "2"\nTITAN_VERSION = "0.6.0"\n');
  const extension = process.platform === "win32" ? "dll" : "so";
  for (const member of ["lfs", "lpeglabel", "luv"]) await result.put(`sdk/lib/lua/5.5/${member}.${extension}`);
  for (const header of ["lauxlib.h", "llhttp.h", "luaconf.h", "lua.h", "lua.hpp", "lualib.h", "minicoro.h", "sqlite3.h", "titan.h", "transfer.h", "uv.h"]) {
    await result.put(`sdk/include/${header}`);
  }
  if (process.platform === "win32") {
    for (const header of ["backtrace.h", "backtrace-supported.h"]) {
      await result.put(`sdk/include/${header}`, `/* ${header} */\n`);
    }
  }
  await result.put("sdk/src/lua-5.5.1/lobject.h");
  return result;
}

function stage({ root, sdk }) {
  return spawnSync(process.execPath, [path.join(scripts, "stage-lua-modules.mjs")], {
    cwd: root, env: { ...process.env, TITAN_PREFIX: sdk }, encoding: "utf8"
  });
}

test("system SDK staging preserves its exact header inventory without copying host OpenSSL", async (context) => {
  const state = await compilerSDK(context);
  const result = stage(state);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(lstat(path.join(state.root, "dist/titan/include/openssl")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(state.root, "dist/titan/include/titan.h"), "utf8"), "fixture\n");
  if (process.platform === "win32") {
    for (const header of ["backtrace.h", "backtrace-supported.h"]) {
      assert.equal(await readFile(path.join(state.root, "dist/titan/include", header), "utf8"),
        `/* ${header} */\n`);
    }
  }
});

test("Windows SDK staging accepts an older absent pair and rejects a partial libbacktrace install",
  { skip: process.platform !== "win32" }, async (context) => {
    const state = await compilerSDK(context);
    await rm(path.join(state.sdk, "include/backtrace.h"));
    let result = stage(state);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SDK include tree inventory changed/);
    await rm(path.join(state.sdk, "include/backtrace-supported.h"));
    result = stage(state);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(lstat(path.join(state.root, "dist/titan/include/backtrace.h")), { code: "ENOENT" });
  });

test("bundled SDK staging requires portable OpenSSL headers across library versions", async (context) => {
  const state = await compilerSDK(context);
  for (const header of ["ssl.h", "crypto.h", "opensslv.h"]) await state.put(`sdk/include/openssl/${header}`, `/* ${header} */\n`);
  const result = stage(state);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(state.root, "dist/titan/include/openssl/crypto.h"), "utf8"), "/* crypto.h */\n");
  await assert.rejects(lstat(path.join(state.root, "dist/titan/include/openssl/e_ostime.h")), { code: "ENOENT" });
});

test("incomplete bundled OpenSSL headers fail staging", async (context) => {
  const state = await compilerSDK(context);
  await state.put("sdk/include/openssl/ssl.h");
  const result = stage(state);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundled OpenSSL header crypto[.]h/);
});

test("system SDK staging omits unrelated headers and rejects symlinked OpenSSL", async (context) => {
  const state = await compilerSDK(context);
  await state.put("sdk/include/unreviewed.h");
  let result = stage(state);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(lstat(path.join(state.root, "dist/titan/include/unreviewed.h")), { code: "ENOENT" });
  await rm(path.join(state.sdk, "include/unreviewed.h"));
  await mkdir(path.join(state.root, "host-openssl"));
  await symlink(path.join(state.root, "host-openssl"), path.join(state.sdk, "include/openssl"), "dir");
  result = stage(state);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SDK include tree inventory changed/);
});

async function nativeInspection(context, host, bundled, irregular) {
  const state = await fixture(context);
  await mkdir(path.join(state.sdk, "include", ...(bundled ? ["openssl"] : [])), { recursive: true });
  if (irregular === "file") await state.put("sdk/include/openssl");
  if (irregular === "link") {
    await mkdir(path.join(state.root, "host-openssl"));
    await symlink(path.join(state.root, "host-openssl"), path.join(state.sdk, "include/openssl"), "dir");
  }
  const server = await state.put("server", "fixture\n", true);
  const oracles = {
    uname: 'printf "%s\\n" "$MOCK_OS"',
    file: 'printf "fixture executable\\n"',
    ldd: 'printf "%s\\n" "$MOCK_DEPENDENCIES"',
    otool: 'printf "%s\\n" "$MOCK_DEPENDENCIES"',
    objdump: 'printf "0000 DF .text 0000 (GLIBC_2.17) memcpy\\n"',
    nm: 'if [[ "$MOCK_OS" == Darwin ]]; then printf "0000 T _lua_gettop\\n"; else printf "0000 T lua_gettop\\n"; fi'
  };
  for (const [tool, body] of Object.entries(oracles)) await state.put(`tools/${tool}`, `#!/bin/bash\n${body}\n`, true);
  return (dependencies) => spawnSync("bash", [path.join(scripts, "inspect-server.sh"), server], {
    cwd: state.root, encoding: "utf8", env: {
      ...process.env, TITAN_PREFIX: state.sdk, TITAN_MAX_GLIBC_VERSION: "2.39", MOCK_OS: host,
      MOCK_DEPENDENCIES: dependencies, PATH: `${path.join(state.root, "tools")}${path.delimiter}${process.env.PATH}`
    }
  });
}

for (const host of ["Linux", "Darwin"]) {
  const dependencies = (ssl, crypto, extra = "") => host === "Linux"
    ? `\t${ssl} => /usr/lib/${ssl} (0x0000)\n\t${crypto} => /usr/lib/${crypto} (0x0000)\n${extra}`
    : `server:\n\t/opt/openssl/lib/${ssl} (compatibility version 3.0.0, current version 3.0.0)\n\t/opt/openssl/lib/${crypto} (compatibility version 3.0.0, current version 3.0.0)\n${extra}`;
  const libraries = host === "Linux" ? ["libssl.so.3", "libcrypto.so.3"] : ["libssl.3.dylib", "libcrypto.3.dylib"];
  test(`${host} system SDK inspection accepts exact OpenSSL 3 dependencies`, async (context) => {
    const inspect = await nativeInspection(context, host, false);
    const result = inspect(dependencies(...libraries));
    assert.equal(result.status, 0, result.stderr);
  });
  test(`${host} bundled SDK inspection rejects dynamic OpenSSL`, async (context) => {
    const inspect = await nativeInspection(context, host, true);
    const result = inspect(dependencies(...libraries));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected dynamic language\/runtime dependency/);
  });
  test(`${host} system SDK inspection rejects wrong OpenSSL versions and unrelated runtimes`, async (context) => {
    const inspect = await nativeInspection(context, host, false);
    for (const name of host === "Linux" ? ["libssl.so.1.1", "libcrypto.so.30", "liblua.so.5.5", "libuv.so.1"]
      : ["libssl.1.1.dylib", "libcrypto.30.dylib", "liblua.5.5.dylib", "libuv.1.dylib"]) {
      const result = inspect(dependencies(name, libraries[1]));
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /unexpected dynamic language\/runtime dependency/);
    }
  });
}

test("system SDK inspection rejects unresolved OpenSSL dependencies", async (context) => {
  const inspect = await nativeInspection(context, "Linux", false);
  const result = inspect("\tlibcrypto.so.3 => not found\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unresolved dynamic dependency/);
});

for (const layout of ["file", "link"]) {
  test(`server inspection rejects ${layout} as an SDK OpenSSL mode marker`, async (context) => {
    const inspect = await nativeInspection(context, "Linux", false, layout);
    const result = inspect("\tlibcrypto.so.3 => /usr/lib/libcrypto.so.3 (0x0000)\n");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OpenSSL headers must be a regular directory/);
  });
}

for (const mode of ["system", "bundled"]) {
  test(`${mode} installed SDK uses explicit OpenSSL switches and child-only SDK selection`,
    { skip: process.platform === "win32" }, async (context) => {
      const state = await fixture(context);
      const build = path.join(state.root, "build");
      await state.put("sdk/bin/titanc", "#!/bin/sh\nexit 0\n", true);
      if (mode === "bundled") await mkdir(path.join(state.sdk, "include/openssl"), { recursive: true });
      const queries = path.join(state.root, "openssl-queries");
      const pkgConfig = await state.put("pkg-config", `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(queries)}
case "$1" in
  --atleast-version=3.0.0) exit 0 ;;
  --cflags) printf '%s\\n' '-I/installed/openssl' ;;
  --libs) printf '%s\\n' '-lssl -lcrypto' ;;
  *) exit 1 ;;
esac
`, true);
      const env = { ...process.env };
      for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "BUILD_PROFILE", "TITAN_BUILD_PROFILE"]) delete env[name];
      env.TITAN_ROCKS_ROOT = "/unrelated/SDK";
      const runtimeProbe = 'console.log("RUNTIME:" + JSON.stringify({sdk:process.env.TITAN_ROCKS_ROOT,probe:process.env.TITAN_PREFIX}))';
      const compilerProbe = 'console.log("COMPILER:" + JSON.stringify({sdk:process.env.TITAN_ROCKS_ROOT,probe:process.env.TITAN_PREFIX,profile:process.env.TITAN_BUILD_PROFILE}))';
      const probe = "sdk-review: | $(TITANC)\n" +
        "\t@printf '%s\\n' 'SDK:$(OPENSSL_MODE)|$(OPENSSL_LDFLAGS)|$(OPENSSL_CPPFLAGS)'\n" +
        "\t@printf '%s\\n' \"FLAGS:$(TITAN_COMPILE_FLAGS) $(TITAN_LINK_FLAGS)\"\n" +
        `\t@$(COMPILER_ENV) ${shellQuote(process.execPath)} -e ${shellQuote(compilerProbe)}\n` +
        `\t@$(SERVER_TEST_ENV) ${shellQuote(process.execPath)} -e ${shellQuote(runtimeProbe)}`;
      const result = spawnSync("make", ["--no-print-directory", "-j1", "-f", repositoryMakefile,
        `TITAN_PREFIX=${state.sdk}`, "TITAN_REPO=/nonexistent/compiler-checkout", `BUILD_ROOT=${build}`,
        "BUILD_PROFILE=validation", "TITAN_BUILD_PROFILE=production",
        `OPENSSL_PKG_CONFIG=${pkgConfig}`, `--eval=${probe}`, "sdk-review"],
      { cwd: state.root, env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.ok(result.stdout.split("\n").includes(mode === "system"
        ? "SDK:system|-lssl -lcrypto|-I/installed/openssl" : "SDK:bundled||"), result.stdout);
      assert.ok(result.stdout.split("\n").includes(`RUNTIME:${JSON.stringify({ sdk: state.sdk })}`), result.stdout);
      assert.ok(result.stdout.split("\n").includes(`COMPILER:${JSON.stringify({
        sdk: state.sdk, probe: path.join(build, "compiler-cache"), profile: "validation"
      })}`), result.stdout);
      if (mode === "system") {
        assert.match(result.stdout, /--cflag='-I\/installed\/openssl'/);
        assert.match(result.stdout, /--ldflag='-lssl' --ldflag='-lcrypto'/);
        assert.match(await readFile(queries, "utf8"), /--libs openssl/);
      } else await assert.rejects(lstat(queries), { code: "ENOENT" });
    });
}

test("missing installed compiler fails without bootstrapping or changing the SDK", {
  skip: process.platform === "win32"
}, async (context) => {
  const state = await fixture(context);
  const result = spawnSync("make", ["--no-print-directory", "-f", repositoryMakefile,
    `TITAN_PREFIX=${state.sdk}`, `BUILD_ROOT=${path.join(state.root, "build")}`,
    "server-objects"], {
    cwd: state.root, env: process.env, encoding: "utf8", timeout: 10000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Titan compiler is missing/);
  await assert.rejects(lstat(path.join(state.sdk, "bin/titanc")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(state.root, ".titan")), { code: "ENOENT" });
});
