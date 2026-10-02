/* Included by the Windows-generated target-profile translation unit only. */
#if !defined(_WIN32)
#error Windows embedded interfaces require a native Windows build
#endif
#include <windows.h>
#include <psapi.h>
#include <stdint.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "titan.h"
#include "embedded_interfaces_native.h"

#define LS_PROVIDER_CACHE "vscode-titan.windows.embedded-provider"
#define LS_PROVIDER_GUARD "vscode-titan.windows.embedded-provider-handle"
#define LS_PATH_CAPACITY 32768

typedef struct ls_provider_handle { HANDLE file; HMODULE module; } ls_provider_handle;

static int ls_close_provider(lua_State *L) {
    ls_provider_handle *owner = luaL_checkudata(L, 1, LS_PROVIDER_GUARD);
    if (owner->file != INVALID_HANDLE_VALUE) {
        HANDLE file = owner->file;
        owner->file = INVALID_HANDLE_VALUE;
        CloseHandle(file);
    }
    return 0;
}

static ls_provider_handle *ls_new_owner(lua_State *L) {
    ls_provider_handle *owner = lua_newuserdatauv(L, sizeof(*owner), 0);
    owner->file = INVALID_HANDLE_VALUE;
    owner->module = NULL;
    if (luaL_newmetatable(L, LS_PROVIDER_GUARD)) {
        lua_pushcfunction(L, ls_close_provider); lua_setfield(L, -2, "__gc");
        lua_pushcfunction(L, ls_close_provider); lua_setfield(L, -2, "__close");
    }
    lua_setmetatable(L, -2);
    return owner;
}

static FARPROC ls_symbol(lua_State *L, HMODULE module, const char *name) {
    FARPROC result = GetProcAddress(module, name);
    if (result == NULL) luaL_error(L, "embedded Titan provider is missing symbol %s (Win32 %d)", name, (int)GetLastError());
    return result;
}

static void ls_check_abi(lua_State *L, HMODULE module, const char *symbol) {
    typedef const char *(*query)(void);
    const char *actual = titan_cast_func(query, ls_symbol(L, module, symbol))();
    if (actual == NULL || strcmp(actual, "2") != 0)
        luaL_error(L, "embedded Titan ABI mismatch at %s: expected 2", symbol);
}

/* Push a bounded, strictly converted UTF8 pathname for the actual image which
 * owns a canonical Titan module's ABI symbol. No basename/global DLL lookup. */
static WCHAR *ls_push_provider_path(lua_State *L, HMODULE module) {
    WCHAR *wide = lua_newuserdatauv(L, LS_PATH_CAPACITY * sizeof(WCHAR), 0);
    DWORD length = GetModuleFileNameW(module, wide, LS_PATH_CAPACITY);
    int size, converted;
    char *utf8;
    if (length == 0 || length >= LS_PATH_CAPACITY)
        luaL_error(L, "cannot locate mapped Titan provider (Win32 %d)", (int)GetLastError());
    size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, NULL, 0, NULL, NULL);
    if (size <= 0) luaL_error(L, "cannot size mapped Titan provider path (Win32 %d)", (int)GetLastError());
    utf8 = lua_newuserdatauv(L, (size_t)size, 0);
    converted = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, utf8, size, NULL, NULL);
    if (converted != size) luaL_error(L, "cannot convert mapped Titan provider path (Win32 %d)", (int)GetLastError());
    /* Preserve native extended-prefix/backslash semantics. _win_realpath below
     * supplies the final OS-reported canonical spelling used by the compiler. */
    lua_pushlstring(L, utf8, (size_t)size);
    lua_remove(L, -2);
    return wide;
}

/* Cache has the immutable identity and a traced handle owner. Opening without
 * FILE_SHARE_WRITE/DELETE prevents writes, rename and replacement for exactly
 * the cached lifetime; identity() therefore needs no filesystem I/O on Tasks.
 * A to-close guard owns failures; success transfers the handle to the cache's
 * GC owner. Closing the Lua state releases the handle. The DLL mapping itself
 * remains owned by Titan's process-lifetime native loader. */
static void ls_push_cache(lua_State *L) {
    int base = lua_gettop(L), guard_index, owner_index, path_index, cache_index;
    ls_provider_handle *guard, *owner;
    TitanModuleProvider provider;
    void *address;
    HMODULE module = NULL;
    WCHAR *wide;
    lua_CFunction open_support;
    luaL_checkstack(L, 16, "Windows embedded Titan provider");
    lua_getfield(L, LUA_REGISTRYINDEX, LS_PROVIDER_CACHE);
    if (!lua_isnil(L, -1)) return;
    lua_pop(L, 1);
    provider = titan_module_provider(L, "titan.lua", NULL);
    address = titan_module_symbol(L, provider, "titan_lua_abi_value");
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          (LPCWSTR)address, &module))
        luaL_error(L, "cannot identify canonical Titan provider (Win32 %d)", (int)GetLastError());
    /* Every plain-C ABI query precedes any call into that image's Lua API. */
    for (size_t index = 0; index < sizeof(titan_ls_windows_interfaces) / sizeof(titan_ls_windows_interfaces[0]); ++index)
        ls_check_abi(L, module, titan_ls_windows_interfaces[index].abi);
    guard = ls_new_owner(L); guard_index = lua_gettop(L); lua_toclose(L, guard_index);
    owner = ls_new_owner(L); owner_index = lua_gettop(L);
    wide = ls_push_provider_path(L, module); path_index = lua_gettop(L);
    guard->file = CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ,
                             NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (guard->file == INVALID_HANDLE_VALUE)
        luaL_error(L, "cannot retain immutable Titan provider (Win32 %d)", (int)GetLastError());
    /* GetModuleFileName can retain a loader pathname after a rename. Verify
     * the locked file still backs the actual mapped ABI address before using
     * its identity; a replaced launch spelling requires a restart. */
    {
        WCHAR *mapped = lua_newuserdatauv(L, LS_PATH_CAPACITY * sizeof(WCHAR), 0);
        WCHAR *opened = lua_newuserdatauv(L, LS_PATH_CAPACITY * sizeof(WCHAR), 0);
        DWORD mapped_size = K32GetMappedFileNameW(GetCurrentProcess(), address, mapped, LS_PATH_CAPACITY);
        DWORD opened_size = GetFinalPathNameByHandleW(guard->file, opened, LS_PATH_CAPACITY,
                                                      FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
        if (mapped_size == 0 || mapped_size >= LS_PATH_CAPACITY ||
            opened_size == 0 || opened_size >= LS_PATH_CAPACITY ||
            CompareStringOrdinal(mapped, (int)mapped_size, opened, (int)opened_size, TRUE) != CSTR_EQUAL)
            luaL_error(L, "Titan provider path no longer names its mapped image; restart the language server");
        lua_pop(L, 2);
    }
    owner->module = module;
    lua_createtable(L, 0, 3); cache_index = lua_gettop(L);
    lua_pushvalue(L, owner_index); lua_setfield(L, cache_index, "owner");
    lua_pushvalue(L, path_index); lua_setfield(L, cache_index, "path");
    open_support = titan_cast_func(lua_CFunction, ls_symbol(L, module, "luaopen_titan"));
    lua_pushcfunction(L, open_support); lua_call(L, 0, 1);
    lua_getfield(L, -1, "_win_realpath");
    if (!lua_isfunction(L, -1)) luaL_error(L, "Titan provider lacks native Windows path support");
    lua_pushvalue(L, path_index); lua_call(L, 1, 1); luaL_checktype(L, -1, LUA_TSTRING);
    lua_replace(L, path_index);
    lua_pushvalue(L, path_index); lua_setfield(L, cache_index, "path");
    lua_getfield(L, -1, "_win_stat");
    if (!lua_isfunction(L, -1)) luaL_error(L, "Titan provider lacks native Windows metadata support");
    lua_pushvalue(L, path_index); lua_pushboolean(L, 1); lua_call(L, 2, 2);
    if (!lua_istable(L, -2)) luaL_error(L, "cannot observe retained Titan provider: %s", lua_tostring(L, -1));
    lua_pop(L, 1);
    lua_getfield(L, -1, "device"); luaL_checktype(L, -1, LUA_TSTRING);
    lua_pushlstring(L, "\0", 1);
    lua_getfield(L, -3, "inode"); luaL_checktype(L, -1, LUA_TSTRING);
    lua_concat(L, 3); lua_setfield(L, -2, "native_identity");
    lua_pushnil(L); lua_setfield(L, -2, "device");
    lua_pushnil(L); lua_setfield(L, -2, "inode");
    lua_pushvalue(L, path_index); lua_setfield(L, -2, "path");
    lua_setfield(L, cache_index, "identity");
    lua_pop(L, 1); /* support table */
    lua_createtable(L, 0, 21);
    for (size_t index = 0; index < sizeof(titan_ls_windows_interfaces) / sizeof(titan_ls_windows_interfaces[0]); ++index) {
        const struct titan_ls_windows_interface *entry = &titan_ls_windows_interfaces[index];
        lua_pushcfunction(L, titan_cast_func(lua_CFunction, ls_symbol(L, module, entry->types)));
        lua_call(L, 0, 1); luaL_checktype(L, -1, LUA_TSTRING);
        lua_setfield(L, -2, entry->name);
    }
    lua_setfield(L, cache_index, "types");
    /* Install the same metadata-free support preload used by Unix. */
    luaL_getsubtable(L, LUA_REGISTRYINDEX, LUA_PRELOAD_TABLE);
    lua_pushcfunction(L, open_support); lua_setfield(L, -2, "titan"); lua_pop(L, 1);
    lua_pushvalue(L, cache_index); lua_setfield(L, LUA_REGISTRYINDEX, LS_PROVIDER_CACHE);
    owner->file = guard->file; guard->file = INVALID_HANDLE_VALUE;
    lua_closeslot(L, guard_index);
    lua_pushvalue(L, cache_index); lua_replace(L, base + 1); lua_settop(L, base + 1);
}

int titan_ls_push_embedded_provider_identity(lua_State *L) {
    static const char *fields[] = { "path", "size", "kind", "native_identity", "modified_seconds", "modified_nanoseconds" };
    int cache;
    ls_push_cache(L); cache = lua_gettop(L);
    lua_getfield(L, cache, "identity");
    lua_createtable(L, 0, 6);
    for (size_t index = 0; index < sizeof(fields) / sizeof(fields[0]); ++index) {
        lua_getfield(L, -2, fields[index]); lua_setfield(L, -2, fields[index]);
    }
    lua_replace(L, cache); lua_settop(L, cache);
    return 1;
}

int titan_ls_push_embedded_interface_provider(lua_State *L) {
    int cache, result, entries, types;
    ls_push_cache(L); cache = lua_gettop(L);
    lua_getfield(L, cache, "types"); types = lua_gettop(L);
    lua_createtable(L, 0, 3); result = lua_gettop(L);
    lua_getfield(L, cache, "path"); lua_setfield(L, result, "provider_file");
    titan_ls_push_target_profile(L); lua_setfield(L, result, "target_profile");
    lua_createtable(L, 0, 21); entries = lua_gettop(L);
    for (size_t index = 0; index < sizeof(titan_ls_windows_interfaces) / sizeof(titan_ls_windows_interfaces[0]); ++index) {
        const struct titan_ls_windows_interface *entry = &titan_ls_windows_interfaces[index];
        /* Do not call luaopen_titan_*: querying metadata must not initialize an
         * otherwise unused stdlib module such as HTTP. */
        lua_createtable(L, 0, 2);
        lua_pushliteral(L, "2"); lua_setfield(L, -2, "abi");
        lua_getfield(L, types, entry->name); lua_setfield(L, -2, "types");
        lua_setfield(L, entries, entry->name);
    }
    lua_setfield(L, result, "entries");
    lua_replace(L, cache); lua_settop(L, cache);
    return 1;
}
