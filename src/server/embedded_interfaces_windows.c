/* Included by the Windows-generated target-profile translation unit only. */
#if !defined(_WIN32)
#error Windows embedded interfaces require a native Windows build
#endif
#include <windows.h>
#include <psapi.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
#include "lua.h"
#include "lauxlib.h"
#include "titan.h"
#include "embedded_interfaces_native.h"

#define LS_PROVIDER_CACHE "vscode-titan.windows.embedded-provider"
#define LS_PROVIDER_GUARD "vscode-titan.windows.embedded-provider-handle"
#define LS_PATH_CAPACITY 32768

enum {
    LS_INTERFACE_COUNT = sizeof(titan_ls_windows_interfaces) /
                         sizeof(titan_ls_windows_interfaces[0])
};

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
    /* Preserve the loader spelling for opening; the retained handle below
     * supplies the final OS-reported canonical spelling. */
    lua_pushlstring(L, utf8, (size_t)size);
    lua_remove(L, -2);
    return wide;
}

/* This exceptional boundary observes the already-mapped, locked provider.
 * Ordinary compiler I/O and Titan fs operations cannot supply that same handle.
 * Final pathname, identity, size and timestamps must all describe its snapshot. */
static void ls_push_final_path(lua_State *L, HANDLE file) {
    WCHAR *wide = lua_newuserdatauv(L, LS_PATH_CAPACITY * sizeof(WCHAR), 0);
    DWORD length = GetFinalPathNameByHandleW(file, wide, LS_PATH_CAPACITY,
                                            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    int size, converted;
    char *utf8;
    if (length == 0 || length >= LS_PATH_CAPACITY)
        luaL_error(L, "cannot resolve retained Titan provider path (Win32 %d)", (int)GetLastError());
    size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, NULL, 0, NULL, NULL);
    if (size <= 0) luaL_error(L, "cannot size retained Titan provider path (Win32 %d)", (int)GetLastError());
    utf8 = lua_newuserdatauv(L, (size_t)size, 0);
    converted = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, utf8, size, NULL, NULL);
    if (converted != size) luaL_error(L, "cannot convert retained Titan provider path (Win32 %d)", (int)GetLastError());
    lua_pushlstring(L, utf8, (size_t)size);
    lua_remove(L, -2); /* UTF8 scratch; the resulting string owns its bytes. */
    lua_remove(L, -2); /* UTF16 scratch */
}

static void ls_hex64(char *result, ULONGLONG value) {
    static const char hex[] = "0123456789abcdef";
    for (size_t index = 0; index < 16; ++index)
        result[index] = hex[(value >> (4 * (15 - index))) & 15];
    result[16] = '\0';
}

static int ls_guid_root(const WCHAR *path, DWORD length) {
    if (length < 49 || wcsncmp(path, L"\\\\?\\Volume{", 11) != 0 ||
        path[47] != L'}' || path[48] != L'\\') return 0;
    for (size_t index = 0; index < 36; ++index) {
        WCHAR character = path[11 + index];
        if (index == 8 || index == 13 || index == 18 || index == 23) {
            if (character != L'-') return 0;
        } else if (!((character >= L'0' && character <= L'9') ||
                     (character >= L'a' && character <= L'f') ||
                     (character >= L'A' && character <= L'F'))) return 0;
    }
    return 1;
}

static void ls_push_native_identity(lua_State *L, HANDLE file) {
    FILE_ID_INFO id;
    char device[96], inode[64];
    static const char hex[] = "0123456789abcdef";
    if (GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id))) {
        strcpy(device, "win32-volume:");
        ls_hex64(device + strlen("win32-volume:"), id.VolumeSerialNumber);
        strcpy(inode, "win32-file:");
        for (size_t index = 0; index < sizeof(id.FileId.Identifier); ++index) {
            unsigned char byte = id.FileId.Identifier[index];
            inode[strlen("win32-file:") + 2 * index] = hex[byte >> 4];
            inode[strlen("win32-file:") + 2 * index + 1] = hex[byte & 15];
        }
        inode[strlen("win32-file:") + 2 * sizeof(id.FileId.Identifier)] = '\0';
    } else {
        DWORD error = GetLastError(), length;
        WCHAR filesystem[256];
        WCHAR *root;
        BY_HANDLE_FILE_INFORMATION legacy;
        if (error != ERROR_INVALID_FUNCTION && error != ERROR_NOT_SUPPORTED &&
            error != ERROR_INVALID_PARAMETER)
            luaL_error(L, "cannot identify retained Titan provider (Win32 %d)", (int)error);
        /* Preserve the previous narrowly approved VirtIO-FS fallback. Its zero
         * volume serial is not an identity; use the handle's real volume GUID
         * and full legacy file index only on this positively identified FS. */
        if (!GetVolumeInformationByHandleW(file, NULL, 0, NULL, NULL, NULL, filesystem, 256))
            luaL_error(L, "cannot identify Titan provider filesystem (Win32 %d)", (int)GetLastError());
        if (wcscmp(filesystem, L"VirtIO-FS") != 0)
            luaL_error(L, "Titan provider FileIdInfo is unavailable (Win32 %d)", (int)error);
        if (!GetFileInformationByHandle(file, &legacy))
            luaL_error(L, "cannot identify VirtIO-FS Titan provider (Win32 %d)", (int)GetLastError());
        root = lua_newuserdatauv(L, LS_PATH_CAPACITY * sizeof(WCHAR), 0);
        length = GetFinalPathNameByHandleW(file, root, LS_PATH_CAPACITY,
                                          FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
        if (length == 0 || length >= LS_PATH_CAPACITY || !ls_guid_root(root, length))
            luaL_error(L, "cannot identify Titan provider volume GUID (Win32 %d)", (int)GetLastError());
        strcpy(device, "win32-volume-guid:");
        for (size_t index = 0; index < 49; ++index)
            device[strlen("win32-volume-guid:") + index] = (char)root[index];
        device[strlen("win32-volume-guid:") + 49] = '\0';
        strcpy(inode, "win32-legacy-file:");
        ls_hex64(inode + strlen("win32-legacy-file:"),
                 ((ULONGLONG)legacy.nFileIndexHigh << 32) | legacy.nFileIndexLow);
        lua_pop(L, 1);
    }
    lua_pushstring(L, device); lua_pushlstring(L, "\0", 1); lua_pushstring(L, inode);
    lua_concat(L, 3);
}

static void ls_push_identity(lua_State *L, HANDLE file, int path_index) {
    FILE_BASIC_INFO basic;
    FILE_STANDARD_INFO standard;
    FILE_ATTRIBUTE_TAG_INFO tag;
    LONGLONG seconds, nanoseconds;
    if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
        !GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic)) ||
        !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)))
        luaL_error(L, "cannot observe retained Titan provider (Win32 %d)", (int)GetLastError());
    if (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        luaL_error(L, "retained Titan provider is not a resolved regular file");
    if (standard.EndOfFile.QuadPart < 0 || basic.LastWriteTime.QuadPart < 0)
        luaL_error(L, "retained Titan provider has negative size or FILETIME");
    seconds = basic.LastWriteTime.QuadPart / 10000000LL - 11644473600LL;
    nanoseconds = (basic.LastWriteTime.QuadPart % 10000000LL) * 100LL;
    if (standard.EndOfFile.QuadPart > LUA_MAXINTEGER || seconds > LUA_MAXINTEGER ||
        seconds < LUA_MININTEGER || nanoseconds > LUA_MAXINTEGER)
        luaL_error(L, "retained Titan provider metadata exceeds Lua integer range");
    lua_createtable(L, 0, 6);
    lua_pushvalue(L, path_index); lua_setfield(L, -2, "path");
    lua_pushliteral(L, "file"); lua_setfield(L, -2, "kind");
    lua_pushinteger(L, (lua_Integer)standard.EndOfFile.QuadPart); lua_setfield(L, -2, "size");
    lua_pushinteger(L, (lua_Integer)seconds); lua_setfield(L, -2, "modified_seconds");
    lua_pushinteger(L, (lua_Integer)nanoseconds); lua_setfield(L, -2, "modified_nanoseconds");
    ls_push_native_identity(L, file); lua_setfield(L, -2, "native_identity");
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
    ls_push_final_path(L, guard->file); lua_replace(L, path_index);
    lua_pushvalue(L, path_index); lua_setfield(L, cache_index, "path");
    ls_push_identity(L, guard->file, path_index); lua_setfield(L, cache_index, "identity");
    open_support = titan_cast_func(lua_CFunction, ls_symbol(L, module, "luaopen_titan"));
    lua_createtable(L, 0, LS_INTERFACE_COUNT);
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
    lua_createtable(L, 0, LS_INTERFACE_COUNT); entries = lua_gettop(L);
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
