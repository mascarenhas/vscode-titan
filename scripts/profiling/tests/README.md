# Offline validation

Run after timing workloads finish, from the repository root:

```sh
node --test scripts/profiling/tests/*.test.mjs
node scripts/profiling/verify-observer-patches.mjs \
  --titan-repo /path/to/titan \
  --server-repo /path/to/vscode-titan
```

The span tests generate their own tiny traces in a temporary directory. The
analytical fixture has a 30 ms parent and children covering `[2,12]`, `[7,22]`,
and `[25,25]` ms: the child union is 20 ms, overlap is 5 ms, and parent residual
is 10 ms. A separate case gives CPU clocks different proportions and expects
their independently computed 21 ms residual. Tests also cover parent links
between compiler and server streams and reject damaged or unfinished traces.

The patch verifier reads pinned Git objects from the supplied repositories,
checks patch and base hashes, and applies both observer patches to fresh
directories under `/tmp`. It verifies every result hash and mode, the exact
file inventory, and preservation of affected working files in the supplied
repositories. Both repositories must contain the base commits recorded in
`patches/manifest.json`; their current checkout need not be at those commits.
Temporary directories are removed on success or failure. These checks do not
build or run Titan, GCC, or a language server, and do not change project caches.

`native-process-cleanup.test.mjs` uses fake process trees to check restoration
after a running or already-exited server leader, TERM-to-KILL escalation, an
absent group, a bounded failure for persistent liveness, and preserving both
cache directories when signaling fails. An interrupted open-stdout fixture
also checks that denied group signals cannot leave a two-hour protocol read
or its timer pending. It launches no legitimate compiler.
Run it directly to see every test case:

```sh
node scripts/profiling/tests/native-process-cleanup.test.mjs
```

For syntax validation without executing either check:

```sh
node --check scripts/profiling/tests/span-analysis.test.mjs
node --check scripts/profiling/verify-observer-patches.mjs
```

## Demand relations and observer behavior

Run the nine synthetic demand tests after timed workloads finish:

```sh
python3 -E -m unittest discover -s "$TOOLS/tests" -p 'test_*.py' -v
```

`test_demand.py` generates small streams and verifies many-to-many relations,
single execution charging, global baseline dependencies, all-origin key
classification, shared scalar identities, primitive foreign macro/type names,
completed versus absent module observers, distinct launch/no-launch/unknown/
preparation states, exact source corruption, and incomplete observers preserving
known direct evidence. Temporary captures are removed automatically.

The observer integration fixture uses the prepared compiler overlay, installed
uninstrumented SDK, and separate prebuilt clock module described in the
[profiling README](../README.md):

```sh
python3 -E "$TOOLS/tests/run-observer-integrity.py" \
  --compiler "$COMPILER" --sdk "$SDK" --clock-dir "$CLOCK_DIR" \
  --output "$REPORT/observer-integrity"
```

Choose a new output directory or omit `--output` for temporary evidence. The
wrapper uses `SDK/bin/lua`; `--lua` selects another matching Lua 5.5 executable.
It runs `observer-integrity.lua` with profiling disabled/enabled and fresh
isolated caches, then checks exact stdout equivalence and the pinned prior
output. It also verifies source hashes, request/execution integrity, preserved
cancellation identity, distinct reused-name wrapper bytes, primitive foreign
name observations, and exclusion of an unused imported module's member table
from demand traversal. It performs no build or C compiler invocation; probe
outcomes come from fake runner callbacks.

The [suffix3 archive](fixtures/observer-integrity-v3/README.md) retains the
original compact evidence independently of the new runner. Historical absolute
paths in those records are provenance only; the relocatable fixture and wrapper
require no files from the original temporary directories.
