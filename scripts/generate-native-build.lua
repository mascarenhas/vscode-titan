-- Build ownership comes from parsed declarations, never fixture-string matches.
local lfs = require "lfs"
local parser = require "titan-compiler.parser"
local util = require "titan-compiler.util"
local filepath = require "titan-compiler.path"

local source_root, build_root, sdk_root, format = ...
assert(source_root and build_root and sdk_root and
    (select("#", ...) == 3 or (select("#", ...) == 4 and format == "--windows-plan")),
    "usage: generate-native-build.lua SOURCE_ROOT BUILD_ROOT TITAN_PREFIX [--windows-plan]")

local function read(path)
    local file = assert(io.open(path, "rb"))
    local result = assert(file:read("a"))
    file:close()
    return result
end

local function mkdir(path)
    if lfs.attributes(path, "mode") == "directory" then return end
    local parent = filepath.dirname(path)
    if parent ~= path then mkdir(parent) end
    assert(lfs.mkdir(path))
end

local function write_changed(path, contents)
    if lfs.attributes(path, "mode") == "file" and read(path) == contents then return end
    mkdir(filepath.dirname(path))
    local temporary = path .. ".tmp"
    local file = assert(io.open(temporary, "wb"))
    assert(file:write(contents))
    assert(file:close())
    -- Windows rename does not replace an existing file. These are private
    -- generated build inputs, never authored source.
    if package.config:sub(1, 1) == "\\" then os.remove(path) end
    assert(os.rename(temporary, path))
end

local function entries(directory)
    local result = {}
    for name in lfs.dir(directory) do
        if name ~= "." and name ~= ".." then result[#result + 1] = name end
    end
    table.sort(result, util.bytewise_less)
    return result
end

local function scan(directory, relative, result)
    for _, name in ipairs(entries(directory)) do
        local path = filepath.join(directory, name)
        local member = relative == "" and name or relative .. "/" .. name
        local mode = lfs.symlinkattributes(path, "mode")
        if mode == "directory" then scan(path, member, result)
        elseif mode == "file" or mode == "link" then result[#result + 1] = member end
    end
end

local function make_path(path)
    assert(not path:find("[\r\n]"), "native build paths may not contain newlines")
    return (path:gsub("%$", "$$$$"):gsub("([ #:\\%%])", "\\%1"))
end

local function shell_quote(value)
    return "'" .. value:gsub("'", "'\"'\"'") .. "'"
end

local authored, titan_files, headers, contents = {}, {}, {}, {}
scan(source_root, "", authored)
for _, relative in ipairs(authored) do
    if relative:match("%.titan$") then
        titan_files[relative] = true
        contents[relative] = read(filepath.join(source_root, relative))
    elseif relative:match("%.h$") and not relative:match("%.ffi%.h$")
            and not relative:match("%.titan%.h$") then
        headers[#headers + 1] = relative
        contents[relative] = read(filepath.join(source_root, relative))
    end
end

-- Folder mains own their immediate contributors. A folder wins over the flat
-- alternative, matching the compiler's source selection.
local folders, modules = {}, {}
for relative in pairs(titan_files) do
    local directory, basename = relative:match("^(.*)/([^/]+)%.titan$")
    if directory and directory:match("([^/]+)$") == basename then
        folders[directory] = relative
    end
end
for relative in pairs(titan_files) do
    local directory = relative:match("^(.*)/[^/]+$") or ""
    local main = folders[directory] or relative
    local stem = main:gsub("%.titan$", "")
    if not folders[directory] and folders[stem] then main = nil end
    if main then
        local name = (folders[directory] and directory or stem):gsub("/", ".")
        local module = modules[name]
        if not module then
            module = {name = name, main = main, sources = {}, imports = {}, foreign = false}
            modules[name] = module
        end
        module.sources[#module.sources + 1] = relative
    end
end
local names = {}
for name in pairs(modules) do names[#names + 1] = name end
table.sort(names, util.bytewise_less)
for _, name in ipairs(names) do
    local module = modules[name]
    table.sort(module.sources, function(left, right)
        if left == right then return false end
        if left == module.main then return true end
        if right == module.main then return false end
        return util.bytewise_less(left, right)
    end)
    local imported = {}
    for _, relative in ipairs(module.sources) do
        local ast, failure = parser.parse(filepath.join(source_root, relative), contents[relative])
        -- Defer a syntax failure to this module's Make target. An unrelated
        -- malformed test module must not block a production-only build.
        if not ast then module.parse_error = parser.error_to_string(failure) end
        for _, declaration in ipairs(ast or {}) do
            if declaration._tag == "Ast.TopLevelImport" then
                local dependency = declaration.modname
                if modules[dependency] then imported[dependency] = true end
            elseif declaration._tag == "Ast.TopLevelForeignFunc" then
                module.foreign = true
            end
        end
    end
    for dependency in pairs(imported) do module.imports[#module.imports + 1] = dependency end
    table.sort(module.imports, util.bytewise_less)
end

local function closure(root)
    assert(modules[root], "native build root is missing: " .. root)
    local selected, visiting = {}, {}
    local function visit(name)
        assert(not visiting[name], "cyclic source imports at " .. name)
        if selected[name] then return end
        visiting[name] = true
        for _, dependency in ipairs(modules[name].imports) do visit(dependency) end
        visiting[name] = nil
        selected[name] = true
    end
    visit(root)
    local result = {}
    for _, name in ipairs(names) do if selected[name] then result[#result + 1] = name end end
    return result
end

local server_modules = closure("titan_language_server")
local test_modules = closure("server.tests")
local generated_outputs = {}
for _, name in ipairs(names) do
    local module = modules[name]
    local stem = module.main:gsub("%.titan$", "")
    for _, suffix in ipairs({".o", ".c", ".ffi.h"}) do generated_outputs[stem .. suffix] = true end
    if module.foreign then generated_outputs[stem .. ".titan.h"] = true end
end
mkdir(build_root)
for _, stage in ipairs({"server-src", "test-src"}) do
    local directory = filepath.join(build_root, stage)
    mkdir(directory)
    local previous = {}
    scan(directory, "", previous)
    for _, relative in ipairs(previous) do
        local authored_output = relative:match("%.titan$") or
            (relative:match("%.h$") and not relative:match("%.ffi%.h$")
                and not relative:match("%.titan%.h$"))
        local generated_output = relative:match("%.o$") or relative:match("%.c$")
            or relative:match("%.ffi%.h$") or relative:match("%.titan%.h$")
        if authored_output and not contents[relative]
                or generated_output and not generated_outputs[relative] then
            assert(os.remove(filepath.join(directory, relative)))
        end
    end
    for _, relative in ipairs(authored) do
        if contents[relative] then write_changed(filepath.join(directory, relative), contents[relative]) end
    end
end

local input_root = filepath.join(build_root, "native-inputs")
write_changed(filepath.join(input_root, "headers"), table.concat(headers, "\n") .. "\n")
for _, name in ipairs(names) do
    local module = modules[name]
    write_changed(filepath.join(input_root, name),
        table.concat(module.sources, "\n") .. "\nimports\n" ..
        table.concat(module.imports, "\n") .. "\nforeign=" .. tostring(module.foreign) ..
        "\nparse_error=" .. (module.parse_error or "") .. "\n")
end

local sdk_files = {}
for _, directory in ipairs({"bin", "lib", "include", "src", "share/lua", "share/titan/0.6/src"}) do
    if lfs.attributes(filepath.join(sdk_root, directory), "mode") == "directory" then
        local members = {}
        scan(filepath.join(sdk_root, directory), "", members)
        for _, member in ipairs(members) do sdk_files[#sdk_files + 1] = filepath.join(sdk_root, directory, member) end
    end
end
-- System OpenSSL headers are not copied into Titan's SDK. They still own the
-- generated C boundary and must invalidate both native object graphs.
local openssl_include = os.getenv("VSCODE_TITAN_OPENSSL_INCLUDEDIR")
if openssl_include and openssl_include ~= "" then
    local cpp = require "c-parser.cpp"
    local cppflags = assert(cpp.split_shell_words(os.getenv("TITAN_EXTRA_CPPFLAGS") or ""))
    local context = assert(cpp.new_context({compiler = os.getenv("CC"), cppflags = cppflags}))
    local directories, seen = {openssl_include}, {}
    -- Multiarch configuration headers can live outside pkg-config's includedir.
    for _, kind in ipairs({"quote", "system"}) do
        for _, directory in ipairs(context.incdirs[kind] or {}) do
            directories[#directories + 1] = directory
        end
    end
    for _, include in ipairs(directories) do
        local directory = filepath.join(include, "openssl")
        if not seen[directory] and lfs.attributes(directory, "mode") == "directory" then
            seen[directory] = true
            local members = {}
            scan(directory, "", members)
            for _, member in ipairs(members) do sdk_files[#sdk_files + 1] = filepath.join(directory, member) end
        end
    end
end
write_changed(filepath.join(input_root, "sdk"), table.concat(sdk_files, "\n") .. "\n")
local configuration = {source_root, build_root, sdk_root}
for _, variable in ipairs({"CC", "AR", "RANLIB", "PATH", "TITANC", "TITAN_LUA", "TITAN_BUILD_PROFILE",
        "TITAN_EXTRA_CPPFLAGS", "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS",
        "TITAN_NO_LINE_DIRECTIVES", "VSCODE_TITAN_EXPORT_FLAGS",
        "VSCODE_TITAN_OPENSSL_MODE", "VSCODE_TITAN_OPENSSL_CPPFLAGS",
        "VSCODE_TITAN_OPENSSL_LDFLAGS", "VSCODE_TITAN_OPENSSL_INCLUDEDIR",
        "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH",
        "LIBRARY_PATH", "COMPILER_PATH", "GCC_EXEC_PREFIX", "SDKROOT",
        "MACOSX_DEPLOYMENT_TARGET", "TITAN_RUNTIME_PREBUILT", "TITAN_PROBE_CACHE_DISABLE"}) do
    configuration[#configuration + 1] = variable .. "=" .. string.format("%q", os.getenv(variable) or "")
end
write_changed(filepath.join(build_root, "native.config"), table.concat(configuration, "\n") .. "\n")

-- The Windows driver consumes the same parsed module ownership and staged
-- source graph. Unix Make rendering below remains the default.
if format == "--windows-plan" then
    local function json_string(value)
        return '"' .. value:gsub('[%z\1-\31\\"]', function(character)
            return string.format("\\u%04x", character:byte())
        end) .. '"'
    end
    local function array(values)
        local result = {}
        for index, value in ipairs(values) do result[index] = json_string(value) end
        return "[" .. table.concat(result, ",") .. "]"
    end
    local result = {
        '{"version":1,"sourceRoot":' .. json_string(source_root),
        ',"buildRoot":' .. json_string(build_root),
        ',"sdkRoot":' .. json_string(sdk_root),
        ',"sdkFiles":' .. array(sdk_files),
        ',"headers":' .. array(headers),
        ',"server":' .. array(server_modules),
        ',"tests":' .. array(test_modules),
        ',"modules":{'
    }
    for index, name in ipairs(names) do
        local module = modules[name]
        result[#result + 1] = (index == 1 and "" or ",") .. json_string(name) ..
            ':{"main":' .. json_string(module.main) ..
            ',"sources":' .. array(module.sources) ..
            ',"imports":' .. array(module.imports) ..
            ',"foreign":' .. tostring(module.foreign) ..
            ',"parseError":' .. (module.parse_error and json_string(module.parse_error) or "null") .. '}'
    end
    result[#result + 1] = "}}\n"
    write_changed(filepath.join(build_root, "native-plan.json"), table.concat(result))
    return
end

local output = {"# Generated from parsed source declarations; do not edit.\n"}
local function emit(line) output[#output + 1] = line .. "\n" end
local function paths(values)
    local escaped = {}
    for index, value in ipairs(values) do escaped[index] = make_path(value) end
    return table.concat(escaped, " ")
end
emit("NATIVE_SDK_INPUTS := " .. paths(sdk_files))
local function module_outputs(stage, name)
    local module = modules[name]
    local relative_stem = module.main:gsub("%.titan$", "")
    local stem = filepath.join(build_root, stage, relative_stem)
    local outputs = {stem .. ".o", stem .. ".c", stem .. ".ffi.h"}
    if module.foreign then outputs[#outputs + 1] = stem .. ".titan.h" end
    return outputs
end
local function graph(stage, variable, selected, test_mode)
    local objects = {}
    for _, name in ipairs(selected) do objects[#objects + 1] = module_outputs(stage, name)[1] end
    emit(variable .. " := " .. paths(objects))
    for _, name in ipairs(selected) do
        local module = modules[name]
        local outputs = module_outputs(stage, name)
        local prerequisites = {filepath.join(input_root, name),
            filepath.join(input_root, "headers"), filepath.join(input_root, "sdk")}
        for _, source in ipairs(module.sources) do prerequisites[#prerequisites + 1] = filepath.join(build_root, stage, source) end
        for _, header in ipairs(headers) do prerequisites[#prerequisites + 1] = filepath.join(build_root, stage, header) end
        for _, dependency in ipairs(module.imports) do
            for _, value in ipairs(module_outputs(stage, dependency)) do prerequisites[#prerequisites + 1] = value end
        end
        emit(make_path(outputs[1]) .. ": FORCE " .. paths(prerequisites) ..
            " $(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)" ..
            (test_mode and " $(TEST_SUPPORT_OUTPUTS)" or ""))
        if module.parse_error then
            local diagnostic = module.parse_error:gsub("[\r\n]", " "):gsub("%$", "$$$$")
            emit("\t@printf '%s\\n' " .. shell_quote(diagnostic) .. " >&2; exit 1")
        else
        emit("\t@set -e; stale=0; newer=$(call shell_quote,$(filter-out FORCE,$?)); test -z \"$$newer\" || stale=1; \\")
        local quoted = {}
        for index, value in ipairs(outputs) do quoted[index] = shell_quote(value) end
        emit("\tfor output in " .. table.concat(quoted, " ") .. "; do test -f \"$$output\" || stale=1; done; \\")
        emit("\tif test \"$$stale\" = 1; then rm -f $(call shell_quote,$@); \\")
        if not module.foreign then emit("\t  rm -f " .. shell_quote(outputs[1]:gsub("%.o$", ".titan.h")) .. "; \\") end
        emit("\t  cd $(call shell_quote," .. (test_mode and "$(TEST_BUILD_DIR)" or "$(SERVER_BUILD_DIR)") .. "); \\")
        emit("\t  $(NATIVE_COMPILER_ENV) $(call shell_quote,$(TITANC)) " ..
            (test_mode and "--test" or "--static") .. " --source-first --incremental -j1 -c --tree " ..
            shell_quote(filepath.join(build_root, stage)) .. " " .. shell_quote(name) .. "; \\")
        emit("\t  for output in " .. table.concat(quoted, " ") .. "; do test -f \"$$output\" || { echo \"missing generated output $$output\" >&2; exit 1; }; done; fi")
        end
        for index = 2, #outputs do
            emit(make_path(outputs[index]) .. ": " .. make_path(outputs[1]))
            emit("\t@test -f $(call shell_quote,$@)")
        end
    end
end
mkdir(filepath.join(build_root, "server"))
mkdir(filepath.join(build_root, "tests"))
graph("server-src", "SERVER_MODULE_OBJECTS", server_modules, false)
graph("test-src", "TEST_MODULE_OBJECTS", test_modules, true)
write_changed(filepath.join(build_root, "native-modules.mk"), table.concat(output))
