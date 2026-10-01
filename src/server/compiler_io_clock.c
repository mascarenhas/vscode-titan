#if defined(_WIN32)

#include <windows.h>

#elif defined(__APPLE__)

#include <mach/mach_time.h>

#else

#define _POSIX_C_SOURCE 200809L
#include <time.h>

#endif

#include "compiler_io_clock.h"

double vscode_titan_monotonic_ms(void) {
#if defined(_WIN32)
    LARGE_INTEGER frequency;
    LARGE_INTEGER counter;
    if (!QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0 ||
        !QueryPerformanceCounter(&counter)) {
        return -1.0;
    }
    return ((double)counter.QuadPart / (double)frequency.QuadPart) * 1000.0;
#elif defined(__APPLE__)
    mach_timebase_info_data_t timebase;
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) {
        return -1.0;
    }
    return ((double)mach_absolute_time() * (double)timebase.numer /
            (double)timebase.denom) / 1000000.0;
#else
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return -1.0;
    }
    return (double)now.tv_sec * 1000.0 + (double)now.tv_nsec / 1000000.0;
#endif
}
