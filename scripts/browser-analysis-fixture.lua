-- The editor fixture uses the compiler's real browser metadata readers.
local mode, sdk, fixture, reference = ...
assert(mode == "encode" or mode == "verify" or mode == "wrong-target", "invalid fixture operation")
local share = sdk .. "/share/lua/5.5/"
local native = package.config:sub(1, 1) == "\\" and "dll" or "so"
package.path = share .. "?.lua;" .. share .. "?/init.lua"
package.cpath = sdk .. "/lib/lua/5.5/?." .. native

local compiler_io = require "titan-compiler.io"
local incremental = require "titan-compiler.incremental"
local driver = require "titan-compiler.driver"
local path = require "titan-compiler.path"
local profile = require "titan-compiler.browsertarget"
local sha256 = require "titan-compiler.sha256"
local metadata = require "titan-compiler.staticmetadata"
local support = require "titan"
local strategy = compiler_io.new_sync()
local fixture_directory = driver.installed_paths(fixture .. "/sdk", "browser").titan_bin
local archive_file = path.join(fixture_directory, "titan.a")
local absent_file = path.join(fixture_directory, "absent-modules")
local descriptor_file = path.join(fixture_directory, "analysis-target")

if mode == "wrong-target" then
    local codec = require "titan-compiler.graphcodec"
    local data = assert(profile.decode_analysis(nil, assert(strategy:read_file(descriptor_file))))
    data.target = "native"
    local file <close> = assert(io.open(descriptor_file, "wb"))
    assert(file:write(assert(codec.encode(data))))
    assert(file:close())
    return
end

local function digest(file)
    return sha256.hex_via(support._sha256_binary, assert(strategy:read_file(file)))
end

if mode == "encode" then
    local full = driver.installed_paths(sdk, "browser").titan_bin
    local published = assert(strategy:read_file(path.join(full, "analysis-target")))
    local data = assert(profile.decode_analysis(nil, published))
    assert(published == assert(profile.encode_analysis_data(nil, data)),
        "the source companion must use the canonical semantic target encoder")
    assert(data.absent_sha256 == digest(absent_file), "the absent-module list changed")
    data.provider_sha256 = digest(archive_file)
    local file <close> = assert(io.open(descriptor_file, "wb"))
    assert(file:write(assert(profile.encode_analysis_data(nil, data))))
    assert(file:close())
end

function strategy:run()
    error("browser semantic fixture verification must not launch a process")
end
local handle = assert(driver.browser_analysis_target(fixture .. "/sdk", { io = strategy }))
assert(handle.provider_file == assert(strategy:realpath(archive_file)))
local descriptor = assert(profile.decode_analysis(nil, assert(strategy:read_file(descriptor_file))))
local function verify_archive(file, names)
    local scanned = assert(metadata.scan_archive(file, {
        io = strategy, target = descriptor.fingerprint, expected_abi = driver.TITAN_ABI_VERSION,
        validate_types = function(name, serialized, origin)
            return driver.decode_module_interface(serialized, name, origin)
        end,
    }))
    assert(driver.validate_browser_provider(scanned))
    assert(table.concat(scanned.key_order, " ") == names, "unexpected fixture archive inventory")
    return scanned
end
local archive = verify_archive(archive_file, "titan.browser titan.gc")
local members = {}
for _, member in ipairs(archive.members) do
    members[#members + 1] = member.display_name
end
assert(table.concat(members, " ") == "browser.o browser.part1.o browser.part2.o browser.part3.o gc.o",
    "browser fixture omitted an original split object")
if mode == "encode" then
    local original = assert(metadata.scan_archive(reference, {
        io = strategy, target = descriptor.fingerprint, expected_abi = driver.TITAN_ABI_VERSION,
    }))
    local originals = {}
    for _, member in ipairs(original.members) do originals[member.display_name] = member.object end
    local function linking_symbols(provider)
        local defined, imported = {}, {}
        for _, member in ipairs(provider.members) do
            for _, symbol in ipairs(member.object.symbols) do
                if symbol.name and symbol.binding ~= "local" then
                    local key = symbol.kind .. "\0" .. symbol.name .. "\0" .. symbol.binding
                    if symbol.defined then defined[key] = true else imported[key] = true end
                end
            end
        end
        for key in pairs(defined) do imported[key] = nil end
        return { defined = defined, imported = imported }
    end
    for _, member in ipairs(archive.members) do
        local rebuilt = member.object
        local source = assert(originals[member.display_name])
        assert((not rebuilt.metadata and not source.metadata) or
            (rebuilt.metadata and source.metadata and rebuilt.metadata.payload == source.metadata.payload),
            member.display_name .. ": public metadata disagrees with source archive")
        assert(incremental.digest({}, "wasm", rebuilt.fingerprint) ==
            incremental.digest({}, "wasm", source.fingerprint),
            member.display_name .. ": Wasm fingerprint disagrees with source archive")
    end
    local rebuilt, published = linking_symbols(archive), linking_symbols(original)
    for _, category in ipairs({"defined", "imported"}) do
        for symbol in pairs(rebuilt[category]) do
            assert(published[category][symbol],
                "rebuilt archive " .. category .. " an unexpected symbol: " .. symbol:gsub("\0", ":"))
        end
        for symbol in pairs(published[category]) do
            assert(rebuilt[category][symbol],
                "rebuilt archive is missing a symbol: " .. symbol:gsub("\0", ":"))
        end
    end
end
verify_archive(path.join(fixture, "providers", "browser_external.a"), "browser_external")

local context = driver.new_resolver_context {
    target = "browser", analysis_only = true, browser_analysis_target = handle, io = strategy,
}
local providers = fixture .. "/providers"
local browser = assert(driver.find_dependency_interface(providers, "titan.browser", context))
assert(browser.static_archive == handle.provider_file and browser.type.members.binding)
local external = assert(driver.find_dependency_interface(providers, "browser_external", context))
assert(external.static_archive == assert(strategy:realpath(path.join(providers, "browser_external.a")))
    and external.type.members.explicit_archive)
local missing, failure = driver.find_dependency_interface(providers, "titan.fs", context)
assert(missing == nil and failure == nil)
assert(driver.missing_module_message(context, "titan.fs"):find("requires a filesystem", 1, true))
assert(driver.close_resolver_context(context))
print("validated browser semantic fixture")
