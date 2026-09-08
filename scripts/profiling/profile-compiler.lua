-- One cold compiler analysis root, using the workspace's complete source catalog.
-- Run from the workspace with explicit Lua paths, real TITAN_ROCKS_ROOT and a
-- fresh TITAN_PREFIX. This measures the compiler, not native-server readiness.
local lfs = require "lfs"
local root = assert(arg[1], "workspace root required")
local root_module = assert(arg[2], "analysis root required")
assert(root:sub(1, 1) == "/", "workspace root must be absolute")
assert(lfs.currentdir() == root, "run from the workspace root")
local config = {}
assert(loadfile(root .. "/titan-config.lua", "t", config))()
local function absolute(relative)
    if relative:sub(1, 1) == "/" then return relative end
    relative = relative:gsub("^%./", "")
    return relative == "." and root or root .. "/" .. relative
end
local source_roots = {}
for _, value in ipairs(assert(config.source_module_roots)) do
    source_roots[#source_roots + 1] = absolute(value)
end
table.sort(source_roots, function(a, b)
    if #a ~= #b then return #a > #b end
    return a < b
end)
local files = {}
local function discover(directory)
    local entries = {}
    for entry in lfs.dir(directory) do
        if entry ~= "." and entry ~= ".." then entries[#entries + 1] = entry end
    end
    table.sort(entries)
    for _, entry in ipairs(entries) do
        local filename = directory .. "/" .. entry
        local kind = lfs.symlinkattributes(filename, "mode")
        if kind == "directory" then discover(filename)
        elseif kind == "file" and entry:sub(-6) == ".titan" then
            files[filename] = true
        end
    end
end
for _, included in ipairs(assert(config.include)) do discover(absolute(included)) end
local projects = {}
for filename in pairs(files) do
    local owning_root
    for _, candidate in ipairs(source_roots) do
        if filename:sub(1, #candidate + 1) == candidate .. "/" then
            owning_root = candidate
            break
        end
    end
    assert(owning_root, "unmapped source: " .. filename)
    local relative = filename:sub(#owning_root + 2)
    local parent = filename:match("^(.*)/[^/]+$")
    local parent_name = parent:match("([^/]+)$")
    local folder_main = parent .. "/" .. parent_name .. ".titan"
    local is_folder = files[folder_main] == true
    local module_path = is_folder and parent:sub(#owning_root + 2)
        or relative:sub(1, -7)
    local name = module_path:gsub("/", ".")
    local project = projects[name]
    if not project then
        project = { kind = is_folder and "folder" or "flat",
            main = is_folder and folder_main or filename,
            files = {}, contents = {}, program_output = name,
            native_output = is_folder and folder_main or filename }
        projects[name] = project
    end
    project.files[#project.files + 1] = filename
    local input = assert(io.open(filename, "rb"))
    project.contents[filename] = assert(input:read("a"))
    assert(input:close())
end
local names, known, source_count = {}, {}, 0
for name, project in pairs(projects) do
    table.sort(project.files, function(a, b)
        if a == project.main then return true end
        if b == project.main then return false end
        return a < b
    end)
    names[#names + 1] = name
    known[name] = true
    source_count = source_count + #project.files
end
table.sort(names)
assert(projects[root_module], "analysis root is outside the project catalog")
io.stdout:write(("catalog: %d modules, %d files; analysis root %s\n"):
    format(#names, source_count, root_module))
if arg[3] == "--catalog-only" then return end

local driver = require "titan-compiler.driver"
local types = require "titan-compiler.types"
local profile = require "titan-compiler.probeprofile"
local output_directory = arg[3] or os.getenv("TITAN_FFI_PROFILE_DIR")
assert(output_directory and output_directory:sub(1, 1) == "/",
    "an absolute output directory is required")
if not lfs.attributes(output_directory) then assert(lfs.mkdir(output_directory)) end
local profile_cleanup <close> = setmetatable({}, { __close = function(_, err)
    local ok, failure = profile.close({ outcome = err == nil and "complete" or "failed",
        error = err ~= nil and tostring(err) or nil })
    assert(ok, failure)
end })
driver.TITAN_SOURCE_PATH = table.concat(source_roots, ";")
local extra_flags = assert(driver.split_shell_words(config.extra_ffi_cppflags or ""))
local flags = {}
for _, flag in ipairs(driver.EXTRA_CPPFLAGS or {}) do flags[#flags + 1] = flag end
for _, flag in ipairs(extra_flags) do flags[#flags + 1] = flag end
driver.EXTRA_CPPFLAGS = flags
driver.imported, types.registry = {}, {}
local includes = {}
for _, value in ipairs(config.extra_ffi_include_dirs or {}) do
    includes[#includes + 1] = absolute(value)
end
local options = { source_roots = { [root_module] = true },
    source_overrides = projects, known_source_modules = known,
    extra_ffi_include_dirs = includes,
    c_header_analysis = driver.new_c_header_analysis() }
local function record_hook(event, fields)
    profile.event(event, fields)
end
options.source_process_trace = function(name, filename, outcome, self_cpu, total_cpu,
                                       parse_cpu, check_cpu)
    record_hook("legacy_source_profile", { module_name = name, filename = filename,
        outcome = outcome, self_cpu_ms = self_cpu, total_cpu_ms = total_cpu,
        parse_cpu_ms = parse_cpu, check_cpu_ms = check_cpu })
end
local run = profile.begin("standalone_compiler", {
    root_module = root_module, project_modules = #names, project_files = source_count })
options.profile_parent_span_id = run and run.id
local context = driver.new_resolver_context(options)
local context_cleanup <close> = setmetatable({}, { __close = function()
    driver.close_resolver_context(context)
end })
options.context = context
local loader = driver.defaultloader({}, options)
local loader_cleanup <close> = setmetatable({}, { __close = function()
    driver.close_loader(loader)
end })
local ok, modtype, errors = loader(root_module)
local finalized, final_errors = driver.finalize_resolver_context(context)
profile.finish(run, { success = ok == true and finalized ~= nil and finalized ~= false,
    checked_modules = #context.checked_source_modules })
assert(ok, tostring(modtype))
assert(finalized ~= nil and finalized ~= false, tostring(final_errors))
local total_errors = 0
for _, list in ipairs({errors or {}, final_errors or {}}) do
    for _, failure in ipairs(list) do
        total_errors = total_errors + 1
        io.stderr:write(tostring(failure), "\n")
    end
end
local checked = {}
for _, name in ipairs(context.checked_source_modules) do checked[#checked + 1] = name end
table.sort(checked)
for _, name in ipairs(checked) do
    local entry = assert(driver.imported[name])
    local public = types.serialize(entry.type)
    local source = assert(entry.source_manifest)
    -- Persist exact interface products outside the compiler cache.
    local directory = output_directory .. "/manifests"
    lfs.mkdir(directory)
    local base = directory .. "/" .. name
    for suffix, contents in pairs({ public = public, source = source }) do
        local output = assert(io.open(base .. "." .. suffix, "wb"))
        assert(output:write(contents)); assert(output:close())
    end
    profile.event("checked_interface", { module_name = name,
        public_bytes = #public, source_bytes = #source })
end
assert(total_errors == 0, "compiler diagnostics were produced")
io.stdout:write(("checked: %d modules, zero diagnostics\n"):format(#checked))
