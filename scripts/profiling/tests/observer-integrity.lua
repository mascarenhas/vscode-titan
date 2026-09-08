-- Fake-runner observer equivalence fixture; paths are supplied by the wrapper.
local cprobe = require 'titan-compiler.cprobe'
local types = require 'titan-compiler.types'
local sha = require 'titan-compiler.sha256'
local profile = require 'titan-compiler.probeprofile'
local mode = assert(arg[1], 'mode required')
assert(mode == 'off' or mode == 'on', 'mode must be off or on')
assert(profile.enabled == (mode == 'on'), 'profiling mode/environment mismatch')
local cache = assert(arg[2], 'fresh absolute cache directory required')
assert(cache:sub(1, 1) == '/', 'cache directory must be absolute')
local calls = {}
local services = {}
local function service(behavior, options)
    options = options or {}
    options.include_dirs = {}
    options.runner = function(argv, metadata)
        calls[#calls + 1] = { key = metadata.key, source = metadata.source,
            stage = metadata.stage }
        if behavior then return behavior(metadata, #calls) end
        return { started = true, ok = true, status = 0, diagnostic = '' }
    end
    options.temp_provider = function()
        return { root = '/fake/probe-integrity',
            write = function() return true end,
            remove = function() return true end,
            cleanup = function() return true end }
    end
    local s = assert(cprobe.new_service(options))
    services[#services + 1] = s
    return s
end
local integer = types.CInteger('int', true, 3, 32)
local long = types.CInteger('long', true, 4, 64)
local function context(s, name)
    return assert(s:module_context({ module = name, includes = {'stdint.h'} }))
end
local function check(label, result)
    print(label, result.status, result.key, result.cached,
        result.cache_tier, result.reason or '', #calls)
end
local s = service(nil, { cache_directory = cache })
local a = context(s, 'module-a')
check('initial', a:validate_declaration_compatibility(integer, integer, nil, nil,
    { purpose = 'foreign_redeclaration', candidate_id = 'fixture-a' }))
check('service-hit', a:validate_declaration_compatibility(integer, integer, nil, nil,
    { purpose = 'enum_carrier', candidate_id = 'fixture-b' }))
check('other-context', context(s, 'module-b'):validate_declaration_compatibility(integer, integer))
local p = service(function() error('persistent hit must not launch') end,
    { cache_directory = cache })
check('persistent-hit', context(p, 'persistent'):validate_declaration_compatibility(integer, integer))
local analysis = service(function() error('analysis hit must not launch') end)
analysis.analysis_result_cache = s.result_cache
check('analysis-hit', context(analysis, 'analysis'):validate_declaration_compatibility(integer, integer))
local reject = service(function(meta)
    return { started = true, ok = meta.stage == 'baseline',
        status = meta.stage == 'baseline' and 0 or 1, diagnostic = 'fixture rejection' }
end)
local r = context(reject, 'reject')
check('rejection', r:validate_declaration_compatibility(integer, long))
check('cached-rejection', r:validate_declaration_compatibility(integer, long))
local fail = service(function()
    return { started = true, ok = false, status = 1, diagnostic = 'bad header' }
end)
check('baseline-failure', context(fail, 'baseline-fail'):validate_declaration_compatibility(integer, long))
check('render-failure', a:validate_declaration_compatibility({_tag='InvalidFixture'}, integer))
local prepare = service()
prepare.temp_provider = function() return nil, 'fixture preparation failure' end
check('preparation-failure', context(prepare, 'prepare'):validate_baseline())
local spawn = service(function() return { started = false, ok = false,
    classification = 'infrastructure_failure', reason = 'spawn', diagnostic = 'fixture spawn failure' } end)
check('spawn-failure', context(spawn, 'spawn'):validate_baseline())
local publish
publish = service(function(meta)
    publish.result_cache[meta.key] = { outcome = 'success', exit_status = 0, diagnostic = '' }
    return { started = true, ok = false, status = 1, diagnostic = 'actual rejection' }
end)
check('publication-existing', context(publish, 'publication'):validate_baseline())
local interrupted = service(function() return { started = true, ok = false,
    interrupted = true, status = 130, diagnostic = 'fixture interruption' } end)
check('interrupted', context(interrupted, 'interrupted'):validate_baseline())
local cancellation = { fixture_cancellation = true }
local cancelled = service(function() error(cancellation) end)
cancelled.runner_is_strategy = true
local ok, error_value = pcall(function() context(cancelled, 'cancelled'):validate_baseline() end)
assert(not ok and error_value == cancellation)
print('cancellation-identity-preserved', ok, error_value == cancellation, #calls)
assert(s:close())
check('closed', a:validate_declaration_compatibility(integer, long))
for index, call in ipairs(calls) do print('physical-source', index, call.stage, call.key, sha.hex(call.source)) end
if profile.enabled then
    local first = profile.wrapper('reused-name', '#include "first.h"\n')
    local second = profile.wrapper('reused-name', '#include "second.h"\n')
    assert(first ~= second)
    assert(first == profile.wrapper('reused-name', '#include "first.h"\n'))
    local demand = require 'titan-compiler.probeprofile_demand'
    local unused = types.CInteger('UNUSED_FAKE_NAME', true, 3, 32)
    local primitive = types.Integer()
    local macro_member = types.ModuleMember('macros.h', 'USED_MACRO', primitive, false)
    local macros = types.CModule('macros.h', { USED_MACRO = macro_member }, { alias = primitive })
    demand.capture({
        {_tag='Ast.TopLevelForeignImport', _type=types.CModule('unused', {
            UNUSED=types.ModuleMember('unused','UNUSED',unused,false) }, {} )},
        {_tag='Ast.VarName', name='used', _type=integer},
        {_tag='Ast.VarDot', name='USED_MACRO', _type=primitive, _decl=macro_member,
            exp={_tag='Ast.ExpVar', _type=macros}},
        {_tag='Ast.TypeQualName', name='alias', module='m', _module_decl={_type=macros}},
        {_tag='Ast.VarName', name='plain_titan_integer', _type=primitive},
    }, 'demand-fixture')
end
for _, existing in ipairs(services) do assert(existing:close()) end
assert(profile.close({ fixture = true }))
