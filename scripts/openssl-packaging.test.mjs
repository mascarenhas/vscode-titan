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
  if (process.platform !== "win32") directories.push("share/lua/5.5/luarocks");
  for (const directory of directories) await mkdir(path.join(result.sdk, directory), { recursive: true });
  for (const member of ["argparse.lua", "inspect.lua", "relabel.lua", "c-parser/cdriver.lua", "titan-compiler/checker.lua",
    "titan-compiler/checker/completion.lua", "titan-compiler/completion.lua", "titan-compiler/maybe3.lua", "titan-compiler/documentation.lua",
    "titan-compiler/parser.lua", "titan-compiler/types.lua"]) {
    await result.put(`sdk/share/lua/5.5/${member}`);
  }
  await result.put("sdk/share/lua/5.5/titan-compiler/driver.lua", "driver.LANGUAGE_SERVER_API_VERSION = 1\n");
  await result.put("sdk/share/lua/5.5/titan-compiler/version.lua", 'LUA_VERSION = "5.5"\nTITAN_ABI_VERSION = "2"\nTITAN_VERSION = "0.6.0"\n');
  const extension = process.platform === "win32" ? "dll" : "so";
  for (const member of ["lfs", "lpeglabel"]) await result.put(`sdk/lib/lua/5.5/${member}.${extension}`);
  for (const header of ["lauxlib.h", "llhttp.h", "luaconf.h", "lua.h", "lua.hpp", "lualib.h", "minicoro.h", "sqlite3.h", "titan.h", "uv.h"]) {
    await result.put(`sdk/include/${header}`);
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

test("system SDK staging still rejects unreviewed header roots and symlinked OpenSSL", async (context) => {
  const state = await compilerSDK(context);
  await state.put("sdk/include/unreviewed.h");
  let result = stage(state);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SDK include tree inventory changed/);
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
  for (const retained of [false, true]) {
    test(`${mode} SDK bootstrap refreshes OpenSSL inputs with a ${retained ? "retained" : "fresh"} native graph`,
      { skip: process.platform === "win32" }, async (context) => {
        const state = await fixture(context);
        const build = path.join(state.root, "build");
        const graph = path.join(build, "native-modules.mk");
        const stableGraph = "# Stable bootstrap fixture graph\nNATIVE_SDK_INPUTS :=\n";
        const generator = await state.put("generate-graph.mjs", `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const build = process.argv[3];
mkdirSync(build, { recursive: true });
const graph = path.join(build, "native-modules.mk");
const contents = ${JSON.stringify(stableGraph)};
let previous;
try { previous = readFileSync(graph, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (previous !== contents) writeFileSync(graph, contents);
`);
        const bootstrap = await state.put("bootstrap-sdk.mjs", `import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const sdk = ${JSON.stringify(state.sdk)};
mkdirSync(path.join(sdk, "bin"), { recursive: true });
writeFileSync(path.join(sdk, "bin", "titanc"), "#!/bin/sh\\nexit 0\\n");
chmodSync(path.join(sdk, "bin", "titanc"), 0o755);
${mode === "bundled" ? 'mkdirSync(path.join(sdk, "include", "openssl"), { recursive: true });' : ""}
`);
        const lua = await state.put("lua", `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, true);
        const rocks = await state.put("luarocks", `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(bootstrap)} "$@"\n`, true);
        const titanRepo = path.join(state.root, "titan");
        await state.put("titan/titan-0.6.0-1.rockspec");
        await state.put("titan/Makefile", `.PHONY: lua luarocks libuv
lua:
\tmkdir -p "$(PREFIX)/bin"
\tcp ${shellQuote(lua)} "$(PREFIX)/bin/lua"
luarocks:
\tmkdir -p "$(PREFIX)/bin"
\tcp ${shellQuote(rocks)} "$(PREFIX)/bin/luarocks"
libuv:
\t@true
`);
        const queries = path.join(state.root, "pkg-config-queries");
        const pkgConfig = mode === "system"
          ? await state.put("pkg-config", `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(queries)}
case "$1" in
  --atleast-version=3.0.0) exit 0 ;;
  --cflags) printf '%s\\n' '-I/bootstrap/openssl' ;;
  --libs) printf '%s\\n' '-lssl -lcrypto' ;;
  --variable=includedir) printf '%s\\n' '/bootstrap/include' ;;
  *) exit 1 ;;
esac
`, true)
          : path.join(state.root, "pkg-config-must-not-be-used");
        if (retained) {
          await mkdir(build, { recursive: true });
          await writeFile(graph, stableGraph);
        }
        const env = { ...process.env, OPENSSL_MODE: mode };
        for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL"]) delete env[name];
        const probe = "bootstrap-review: ; @printf '%s\\n' 'BOOTSTRAP:$(NATIVE_OPENSSL_MODE)|$(NATIVE_OPENSSL_LDFLAGS)|$(NATIVE_OPENSSL_CPPFLAGS)|$(MAKE_RESTARTS)'";
        const result = spawnSync("make", ["--no-print-directory", "-j1", "-f", repositoryMakefile,
          `TITAN_PREFIX=${state.sdk}`, `TITAN_REPO=${titanRepo}`, `BUILD_ROOT=${build}`,
          `NATIVE_BUILD_GENERATOR=${generator}`, `OPENSSL_PKG_CONFIG=${pkgConfig}`,
          `--eval=${probe}`, "bootstrap-review"], {
          cwd: state.root, env, encoding: "utf8", timeout: 30_000
        });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
        const expected = mode === "system"
          ? "BOOTSTRAP:system|-lssl -lcrypto|-I/bootstrap/openssl|1"
          : "BOOTSTRAP:bundled|||1";
        assert.ok(result.stdout.split("\n").includes(expected), result.stdout);
        assert.equal(await readFile(graph, "utf8"), stableGraph);
        if (mode === "system") {
          assert.deepEqual((await readFile(queries, "utf8")).trim().split("\n"), [
            "--atleast-version=3.0.0 openssl", "--cflags openssl", "--libs openssl", "--variable=includedir openssl"
          ]);
        } else {
          await assert.rejects(lstat(queries), { code: "ENOENT" });
        }
      });
  }
}

async function luaRocksMakeFixture(context, goal) {
  const state = await fixture(context);
  const titanRepo = path.join(state.root, "titan");
  const invoked = path.join(state.root, "luarocks-invoked");
  const profile = path.join(state.root, "luarocks-profile");
  const nestedMakefile = await state.put("nested.mk", `.PHONY: all
all:
\t@printf '%s\\n' 'JOBSERVER:$(MAKEFLAGS)'
`);
  const rocks = await state.put("luarocks", `#!/bin/bash
set -e
printf '%s\\n' invoked >> ${shellQuote(invoked)}
printf '%s\\n' "\${TITAN_BUILD_PROFILE:-unset}" > ${shellQuote(profile)}
make --no-print-directory -f ${shellQuote(nestedMakefile)}
mkdir -p ${shellQuote(path.join(state.sdk, "bin"))}
printf '#!/bin/sh\\nexit 0\\n' > ${shellQuote(path.join(state.sdk, "bin", "titanc"))}
chmod 755 ${shellQuote(path.join(state.sdk, "bin", "titanc"))}
`, true);
  // Keep the wrapper available for dry runs, independently of Make's bootstrap.
  await state.put("sdk/bin/luarocks", await readFile(rocks, "utf8"), true);
  if (goal === "toolchain-refresh") await state.put("sdk/bin/titanc", "#!/bin/sh\nexit 0\n", true);
  await state.put("titan/titan-0.6.0-1.rockspec");
  // The SDK prerequisites are ready; only compiler installation is missing.
  for (const name of ["lua", "luarocks", "libuv"]) await state.put(`titan/${name}`);
  await state.put("titan/Makefile", "lua luarocks libuv:\n");
  const env = { ...process.env };
  for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "BUILD_PROFILE", "TITAN_BUILD_PROFILE"]) delete env[name];
  const makeHelp = spawnSync("make", ["--help"], { env, encoding: "utf8" }).stdout ?? "";
  const pipeStyle = makeHelp.includes("--jobserver-style") ? ["--jobserver-style=pipe"] : [];
  const run = (flags = []) => spawnSync("make", ["--no-print-directory", "-j2", ...pipeStyle,
    ...flags, "-f", repositoryMakefile, `TITAN_PREFIX=${state.sdk}`, `TITAN_REPO=${titanRepo}`, goal],
  { cwd: state.root, env, encoding: "utf8", timeout: 30_000 });
  return { ...state, invoked, profile, run };
}

for (const goal of ["toolchain", "toolchain-refresh"]) {
  test(`${goal} LuaRocks wrapper preserves the pipe jobserver`,
    { skip: process.platform === "win32" }, async (context) => {
      const state = await luaRocksMakeFixture(context, goal);
      const result = state.run();
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.doesNotMatch(result.stderr, /jobserver unavailable/, result.stderr);
      assert.match(result.stdout, /JOBSERVER:.*--jobserver-auth=\d+,\d+/);
      assert.equal(await readFile(state.invoked, "utf8"), "invoked\n");
      assert.equal(await readFile(state.profile, "utf8"), "production\n");
    });
  test(`${goal} carries the validation profile through LuaRocks`,
    { skip: process.platform === "win32" }, async (context) => {
      const state = await luaRocksMakeFixture(context, goal);
      const result = state.run(["BUILD_PROFILE=validation", "TITAN_BUILD_PROFILE=production"]);
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(await readFile(state.profile, "utf8"), "validation\n");
    });
  for (const flag of ["-n", "-t", "-q"]) {
    test(`${goal} does not invoke LuaRocks under ${flag}`,
      { skip: process.platform === "win32" }, async (context) => {
        const state = await luaRocksMakeFixture(context, goal);
        const result = state.run([flag]);
        assert.equal(result.status, flag === "-q" ? 1 : 0, result.error?.message ?? result.stderr);
        await assert.rejects(lstat(state.invoked), { code: "ENOENT" });
        assert.doesNotMatch(result.stdout, /^JOBSERVER:/m);
        if (goal === "toolchain" && flag !== "-t") {
          await assert.rejects(lstat(path.join(state.sdk, "bin", "titanc")), { code: "ENOENT" });
        }
      });
  }
}
