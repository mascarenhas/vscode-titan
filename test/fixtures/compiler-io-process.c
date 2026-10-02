#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <wchar.h>
typedef wchar_t FixtureArgument;
#else
#include <signal.h>
#include <time.h>
#include <unistd.h>
typedef char FixtureArgument;
#endif

/* Commands are ASCII on both targets; the Windows pathname argument stays
 * UTF-16 from wmain through _wfopen. CLANG64 links this fixture with -municode. */
static int is_command(const FixtureArgument *argument, const char *command) {
  while (*argument != 0 && *command != '\0') {
    if (*argument++ != (unsigned char)*command++)
      return 0;
  }
  return *argument == 0 && *command == '\0';
}

static void delay(unsigned milliseconds) {
#ifdef _WIN32
  Sleep(milliseconds);
#else
  struct timespec remaining;
  remaining.tv_sec = milliseconds / 1000;
  remaining.tv_nsec = (milliseconds % 1000) * 1000000L;
  while (nanosleep(&remaining, &remaining) != 0 && errno == EINTR) {}
#endif
}

static int inspect_pid(const FixtureArgument *text, int terminate) {
  FixtureArgument *end;
  unsigned long pid;
  errno = 0;
#ifdef _WIN32
  pid = wcstoul(text, &end, 10);
#else
  pid = strtoul(text, &end, 10);
#endif
  if (errno != 0 || *text == '\0' || *end != '\0' || pid == 0)
    return 2;
#ifdef _WIN32
  HANDLE process = OpenProcess(terminate ? PROCESS_TERMINATE : SYNCHRONIZE,
                               FALSE, (DWORD)pid);
  DWORD status;
  if (process == NULL)
    return GetLastError() == ERROR_INVALID_PARAMETER ? 1 : 2;
  if (terminate) {
    int result = TerminateProcess(process, 1) ? 0 : 2;
    CloseHandle(process);
    return result;
  }
  status = WaitForSingleObject(process, 0);
  CloseHandle(process);
  return status == WAIT_OBJECT_0 ? 1 : status == WAIT_TIMEOUT ? 0 : 2;
#else
  if ((unsigned long)(pid_t)pid != pid)
    return 2;
  if (kill((pid_t)pid, terminate ? SIGKILL : 0) == 0)
    return 0;
  return errno == ESRCH ? 1 : 2;
#endif
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
#ifdef _WIN32
  if (_setmode(_fileno(stdout), _O_BINARY) == -1 ||
      _setmode(_fileno(stderr), _O_BINARY) == -1)
    return 2;
#endif
  if (argc < 2)
    return 2;
#ifdef _WIN32
  if (argc == 4 && is_command(argv[1], "hard-link"))
    return CreateHardLinkW(argv[3], argv[2], NULL) ? 0 : (int)GetLastError();
  if (argc == 4 && is_command(argv[1], "symbolic-link"))
    return CreateSymbolicLinkW(argv[3], argv[2],
                              SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)
               ? 0 : (int)GetLastError();
  if (argc == 4 && is_command(argv[1], "directory-symbolic-link"))
    return CreateSymbolicLinkW(argv[3], argv[2],
                              SYMBOLIC_LINK_FLAG_DIRECTORY |
                              SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)
               ? 0 : (int)GetLastError();
#endif
  if (is_command(argv[1], "locale")) {
    const char *lang = getenv("LANG");
    const char *all = getenv("LC_ALL");
    if (lang == NULL || all == NULL)
      return 2;
    if (printf("%s|%s|", lang, all) < 0 ||
        fwrite("A\0B", 1, 3, stdout) != 3 || fflush(stdout) != 0 ||
        fputs("|diagnostic", stderr) == EOF || fflush(stderr) != 0)
      return 2;
    return 0;
  }
  if (is_command(argv[1], "exit") && argc == 3) {
    if (fputs("rejected", stdout) == EOF || fflush(stdout) != 0)
      return 2;
#ifdef _WIN32
    return _wtoi(argv[2]);
#else
    return atoi(argv[2]);
#endif
  }
  if (is_command(argv[1], "stdout"))
    return fputs("stdout-only", stdout) == EOF || fflush(stdout) != 0 ? 2 : 0;
  if (is_command(argv[1], "delay")) {
    delay(50);
    return 0;
  }
  if (is_command(argv[1], "large")) {
    int index;
    for (index = 0; index < 8192; index++) {
      if (fwrite("0123456789abcdef", 1, 16, stdout) != 16)
        return 2;
    }
    return fflush(stdout) != 0 ? 2 : 0;
  }
  if (is_command(argv[1], "wait") && argc == 3) {
#ifdef _WIN32
    FILE *marker = _wfopen(argv[2], L"wb");
#else
    FILE *marker = fopen(argv[2], "wb");
#endif
    unsigned long pid;
#ifdef _WIN32
    pid = (unsigned long)GetCurrentProcessId();
#else
    pid = (unsigned long)getpid();
#endif
    if (marker == NULL)
      return 2;
    {
      int failed = fprintf(marker, "%lu\n", pid) < 0;
      if (fclose(marker) != 0) failed = 1;
      if (failed) return 2;
    }
    delay(60000);
    return 0;
  }
  if (is_command(argv[1], "probe") && argc == 3)
    return inspect_pid(argv[2], 0);
  if (is_command(argv[1], "kill") && argc == 3)
    return inspect_pid(argv[2], 1);
  return 2;
}
