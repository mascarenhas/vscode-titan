#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <math.h>

#include "luaconf.h"
#include "lauxlib.h"
#include "lstate.h"
#include "lgc.h"
#include "ltable.h"
#include "ltm.h"
#include "lfunc.h"
#include "lstring.h"
#include "lvm.h"
#include "lobject.h"
#include "ldo.h"

#include "titan.h"
static TITAN_UNUSED inline int titan_errfunc_is_errorhandler(lua_State *L) {
    if (L->errfunc == 0) return 0;
    StkId errfunc = restorestack(L, L->errfunc);
    TValue *v = s2v(errfunc);
    return ttislcf(v) && fvalue(v) == errorhandler;
}

/*
 * Read an already-published string-keyed registry entry without using or
 * changing the Lua stack. luaS_new can allocate, so callers holding StkId
 * values must restore them after this helper returns.
 */
static TITAN_UNUSED inline lu_byte titan_registry_get_string(
        lua_State *L, const char *key, TValue *result) {
    setnilvalue(result);
    TString *registry_key = luaS_new(L, key);
    lua_assert(ttistable(&G(L)->l_registry));
    return luaH_getstr(
        hvalue(&G(L)->l_registry), registry_key, result);
}


/*
 * Set one of Titan's bounded process-lifetime string-keyed registry entries
 * through Lua's internal table machinery. The caller must keep a collectable
 * value traced across this call and pass a stable C key string. Copy the value
 * before string interning can relocate its source StkId. For a missing key,
 * resize only when the hash has no genuinely free node, then reacquire the
 * key. In either case the subsequent insertion roots the key before
 * HARDMEMTESTS can force an emergency collection.
 * This helper never reads or changes L->top.
 */
static TITAN_UNUSED inline void titan_registry_set_string(
        lua_State *L, const char *key, const TValue *value) {
    TValue value_copy = *value;
    TValue key_value;
    Table *registry = hvalue(&G(L)->l_registry);
    TString *registry_key = luaS_new(L, key);
    int hres = luaH_psetstr(registry, registry_key, &value_copy);
    if (hres == HNOTFOUND && !ttisnil(&value_copy)) {
        unsigned node_count = allocsizenode(registry);
        int has_free_node = 0;
        for (unsigned i = 0; i < node_count; i++) {
            if (keyisnil(gnode(registry, i))) {
                has_free_node = 1;
                break;
            }
        }
        if (!has_free_node) {
            luaH_resize(L, registry, registry->asize, node_count + 1u);
            registry_key = luaS_new(L, key);
            hres = luaH_psetstr(registry, registry_key, &value_copy);
            lua_assert(hres == HOK || hres == HNOTFOUND);
        }
    }
    if (hres != HOK) {
        setsvalue(L, &key_value, registry_key);
        luaH_finishset(L, registry, &key_value, &value_copy, hres);
    }
    invalidateTMcache(registry);
    luaC_barrierback(L, obj2gco(registry), &value_copy);
}

/*
 * Generated code frequently reserves stack slots before writing through
 * L->top.p directly. Use Lua's internal raising growth path and extend the
 * current frame limit exactly as lua_checkstack would, without crossing the
 * public stack API.
*/
static TITAN_UNUSED inline void titan_ensure_stack(lua_State *L, int slots) {
    luaD_checkstack(L, slots);
    if (L->ci->top.p < L->top.p + slots)
        L->ci->top.p = L->top.p + slots;
}

#include <openssl/err.h>
#include <openssl/x509v3.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <stddef.h>
#include <string.h>

#if defined(__GNUC__) || defined(__clang__)
#define TITAN_SOURCE_LOCAL __attribute__((visibility("hidden")))
#else
#define TITAN_SOURCE_LOCAL
#endif

#ifdef __clang__
#pragma clang diagnostic ignored "-Wunused-function"
#pragma clang diagnostic ignored "-Wparentheses-equality"
#endif

extern size_t titan_probe_l;
extern size_t titan_probe_r;
void titan_probe_o(void);
void titan_probe_o(void) {
    (void)(((unsigned long)(titan_probe_l)) != ((unsigned long)(titan_probe_r)));
}
