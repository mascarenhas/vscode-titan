#ifndef VSCODE_TITAN_COMPILER_IO_PLATFORM_H
#define VSCODE_TITAN_COMPILER_IO_PLATFORM_H

/* Titan has no conditional platform imports; expose only the target constant. */
#ifdef _WIN32
enum { VSCODE_TITAN_WINDOWS = 1 };
#else
enum { VSCODE_TITAN_WINDOWS = 0 };
#endif

#endif
