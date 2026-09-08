# GCC report parser fixtures

`gcc16-wall-success.stderr` and `gcc16-wall-rejection.stderr` are unchanged copies of the SSL pilot's saved diagnostic replay stderr: respectively the ordered-header baseline and the rejected `UV_ENOENT` carrier candidate, repeat 1. Their timing header exposes wall time and GGC memory, without per-pass user/system CPU columns. The original capture files are untouched.

`gcc-legacy-user-system-wall.stderr` is a synthetic compatibility fixture for the legacy user/system/wall format. Its deliberately different CPU, wall, percentage and memory values detect column confusion; the diagnostic prefix checks that unrelated stderr is ignored.

Run `python3 scripts/profiling/test-replay-parser.py`. These fixtures never execute a compiler.

`replay-process-tree.py` is a non-compiler lifecycle fixture used by
`test-replay-lifecycle.py`. It starts a sleeping Python descendant and publishes
both PIDs; the tests must stop the whole process group after timeout or signal.
Run lifecycle tests outside timed captures.
