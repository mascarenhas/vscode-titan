-- Validate the complete published semantic SDK, without invoking a toolchain.
local compiler, sdk = ...
local share = compiler .. "/share/lua/5.5/"
local suffix = package.config:sub(1, 1) == "\\" and "dll" or "so"
package.path = share .. "?.lua;" .. share .. "?/init.lua"
package.cpath = compiler .. "/lib/lua/5.5/?." .. suffix

local driver = require "titan-compiler.driver"
local compiler_io = require "titan-compiler.io"
local target = require "titan-compiler.browsertarget"
local support = require "titan"
local strategy = compiler_io.new_sync()
function strategy:run()
    error("browser semantic package verification must not launch a process")
end
local adapter = { sha256_binary = support._sha256_binary, sha256_stream = support._sha256_stream }
local options = { io = strategy, cache_adapter = adapter }
local accepted = assert(driver.browser_analysis_target(sdk, options))
-- The handle admits deliberate partial editor SDKs. Packaging requires the
-- complete inventory and checks it against the handle's already decoded bytes.
local resolver = driver.new_resolver_context({
    io = strategy, cache_adapter = adapter, target = "browser", analysis_only = true,
    browser_analysis_target = accepted, transient_caches = true,
})
local _, _, _, provider = driver.find_static_interface("", "titan.browser", resolver)
assert(provider and provider.archive == accepted.provider_file, "titan.a: missing its browser interface")
local expected = {
    "titan.async", "titan.browser", "titan.coroutine", "titan.gc", "titan.http",
    "titan.io", "titan.iteration", "titan.json", "titan.lua", "titan.math",
    "titan.os", "titan.path", "titan.peg", "titan.protobuf", "titan.reflect",
    "titan.string", "titan.test", "titan.timer", "titan.transfer", "titan.url", "titan.websocket",
}
assert(table.concat(provider.key_order, " ") == table.concat(expected, " "),
    "browser semantic pack is not the complete standard provider")
assert(driver.close_resolver_context(resolver))
local absent = {
    "titan.fs\trequires a filesystem",
    "titan.net\trequires native sockets",
    "titan.sqlite3\trequires the native SQLite library",
    "titan.ssl\trequires OpenSSL and native sockets",
    "titan.thread\trequires OS threads",
    "titan.uv\trequires libuv",
    "",
}
assert(strategy:read_file(accepted.directory .. "/absent-modules", 64 * 1024) == table.concat(absent, "\n"),
    "absent-modules: not the canonical browser absent-module inventory")
local descriptor = assert(target.decode_analysis(options,
    assert(strategy:read_file(accepted.directory .. "/analysis-target", 64 * 1024))))
print(descriptor.build_profile)
