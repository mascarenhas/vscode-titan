/* Linux clock sampler for the isolated FFI profiling experiment. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>
#include <lua.h>
#include <lauxlib.h>

static double milliseconds(struct timespec value) {
    return (double)value.tv_sec * 1000.0 + (double)value.tv_nsec / 1000000.0;
}

static double usage_milliseconds(struct timeval value) {
    return (double)value.tv_sec * 1000.0 + (double)value.tv_usec / 1000.0;
}

static int sample(lua_State *L) {
    struct timespec wall, process, thread;
    struct rusage children;
    if (clock_gettime(CLOCK_MONOTONIC, &wall) != 0 ||
        clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &process) != 0 ||
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &thread) != 0 ||
        getrusage(RUSAGE_CHILDREN, &children) != 0) {
        return luaL_error(L, "profile clock sample failed: %s", strerror(errno));
    }
    lua_pushnumber(L, milliseconds(wall));
    lua_pushnumber(L, milliseconds(process));
    lua_pushnumber(L, milliseconds(thread));
    lua_pushnumber(L, usage_milliseconds(children.ru_utime));
    lua_pushnumber(L, usage_milliseconds(children.ru_stime));
    return 5;
}

int luaopen_probe_profile_clock(lua_State *L) {
    luaL_Reg functions[] = {{"sample", sample}, {NULL, NULL}};
    luaL_newlib(L, functions);
    return 1;
}
