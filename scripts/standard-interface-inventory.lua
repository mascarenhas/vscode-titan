local inventory = { abi = "2" }

inventory.modules = {
    "titan.async", "titan.coroutine", "titan.fs", "titan.gc", "titan.http",
    "titan.io", "titan.iteration", "titan.json", "titan.lua", "titan.math",
    "titan.net", "titan.os", "titan.path", "titan.peg", "titan.protobuf",
    "titan.reflect", "titan.sqlite3", "titan.ssl", "titan.string", "titan.test",
    "titan.thread", "titan.timer", "titan.transfer", "titan.url", "titan.uv",
    "titan.websocket",
}
inventory.modern = {
    ["titan.protobuf"] = true,
    ["titan.thread"] = true,
    ["titan.transfer"] = true,
}
inventory.limits = {
    max_bytes = 8 * 1024 * 1024,
    max_nodes = 32,
    max_entries = 160,
    max_string_bytes = 4 * 1024 * 1024,
}

local function join_quoted(values)
    local quoted = {}
    for index, value in ipairs(values) do
        quoted[index] = string.format("%q", value)
    end
    return table.concat(quoted, ", ")
end

function inventory.validate(entries, extracted)
    if type(entries) ~= "table" then
        return nil, "archive scanner returned no metadata entry table"
    end
    -- A compatible 0.6 SDK has either the 23 original standard modules or
    -- all three additional modules. A partial group is not an SDK profile.
    local modern = false
    for name in pairs(inventory.modern) do
        if entries[name] ~= nil then modern = true end
    end
    local selected, expected, missing, unexpected = {}, {}, {}, {}
    for _, name in ipairs(inventory.modules) do
        if modern or not inventory.modern[name] then
            selected[#selected + 1] = name
            expected[name] = true
            if entries[name] == nil then missing[#missing + 1] = name end
        end
    end
    for name in pairs(entries) do
        if type(name) ~= "string" then return nil, "invalid module entry key" end
        if not expected[name] then unexpected[#unexpected + 1] = name end
    end
    table.sort(unexpected)
    if #missing ~= 0 or #unexpected ~= 0 then
        local parts = {}
        if #missing ~= 0 then parts[#parts + 1] = "missing " .. join_quoted(missing) end
        if #unexpected ~= 0 then parts[#parts + 1] = "unexpected " .. join_quoted(unexpected) end
        return nil, "expected the exact " .. #selected ..
            "-module Titan interface inventory (" .. table.concat(parts, "; ") .. ")"
    end
    for _, name in ipairs(selected) do
        local entry = entries[name]
        if type(entry) ~= "table" or (not extracted and entry.module ~= name) then
            return nil, "metadata entry " .. string.format("%q", name) ..
                " has an inconsistent logical module name"
        elseif entry.abi ~= inventory.abi then
            return nil, "metadata entry " .. string.format("%q", name) ..
                " has ABI " .. string.format("%q", tostring(entry.abi)) ..
                "; expected " .. string.format("%q", inventory.abi)
        elseif type(entry.types) ~= "string" or entry.types == "" then
            return nil, "metadata entry " .. string.format("%q", name) ..
                " has empty or non-string type metadata"
        end
        if extracted then
            for key in pairs(entry) do
                if key ~= "abi" and key ~= "types" then
                    return nil, name .. " has an unexpected interface field " .. tostring(key)
                end
            end
        end
    end
    return selected
end

local function query_one(query, symbol)
    local results = table.pack(query())
    if results.n ~= 1 or type(results[1]) ~= "string" or results[1] == "" then
        return nil, symbol .. " must return exactly one nonempty string"
    end
    return results[1]
end

function inventory.query(provider_file)
    local support = require "titan"
    local driver = require "titan-compiler.driver"
    local windows = package.config:sub(1, 1) == "\\"
    local entries = {}
    for _, name in ipairs(inventory.modules) do
        local symbol = driver.mangle_module_name(name) .. "_abi"
        local abi, message, stage
        if windows then
            abi, message, stage = support._abivalue(provider_file, symbol .. "_value")
        else
            local query
            query, message, stage = support._loadlib(provider_file, symbol)
            if query then abi, message = query_one(query, symbol) end
        end
        if abi == nil and stage == "init" and inventory.modern[name] then
            -- Validate the entire optional group after observing its exports.
        elseif abi ~= inventory.abi then
            return nil, name .. " ABI mismatch: " .. tostring(abi or message)
        else
            entries[name] = { module = name, abi = abi }
        end
    end
    for _, name in ipairs(inventory.modules) do
        if entries[name] then
            local symbol = driver.mangle_module_name(name) .. "_types"
            local query, message = support._loadlib(provider_file, symbol)
            if not query then return nil, tostring(message) end
            local types, failure = query_one(query, symbol)
            if not types then return nil, failure end
            entries[name].types = types
        end
    end
    local names, message = inventory.validate(entries)
    if not names then return nil, message end
    return { provider_file = provider_file, entries = entries }
end

function inventory.extract(prefix, provider_file, output)
    local windows = package.config:sub(1, 1) == "\\"
    local share = prefix .. "/share/lua/5.5/"
    local lib = prefix .. "/lib/lua/5.5/"
    package.path = share .. "?.lua;" .. share .. "?/init.lua"
    package.cpath = lib .. (windows and "?.dll" or "?.so")
    -- Run from the selected SDK's bin directory before loading the provider.
    assert(require("lfs").chdir(prefix .. "/bin"))
    local provider = assert(inventory.query(provider_file))
    for _, entry in pairs(provider.entries) do entry.module = nil end
    local codec = require "titan-compiler.graphcodec"
    local digest = require("titan")._sha256_binary
    assert(type(digest) == "function", "selected SDK Lua is missing native SHA-256")
    inventory.limits.sha256_binary = digest
    local payload = assert(codec.encode(provider, inventory.limits))
    local file <close> = assert(io.open(output, "wb"))
    assert(file:write(payload))
    assert(file:close())
end

return inventory
