# Cold FFI probe investigation

This experiment follows [What to profile next](sqlite-backend-schema.md#what-to-profile-next).
It measures the existing compiler and records the proposed replacement for
per-header namespaces: one module-header environment exposed through reserved
`ffi`. The controlled native run spends **1,150.374 seconds in 8,729 ordinary
redeclaration probes**, 64.8% of its 1,775.141-second indexing interval. Individual C
probes and their raw-source-only cache keys remain unchanged. A fresh private
probe-cache prefix makes each measured process cold while preserving ordinary
reuse inside that process.

## Workload and controls

The corpus is the unchanged Titan workspace at
`788b353bed8e2580bbf12bf8ebf4ad9e7f1ab47d`: 63 configured project modules in 135
saved source files, including the standard-library tests. Its seven configured
C-header directories and `-D_GNU_SOURCE -DOPENSSL_API_COMPAT=30000` flags are
retained. The native server starts from vscode-titan
`e0bff3b6f46725880b5c8a9b7633eff82643c8a4`, with experimental observation patches.
The isolated installed SDK supplies the same native dependencies throughout.
The host C compiler is GCC 16.2.1 (Red Hat 16.2.1-2).

The measurements distinguish a standalone `titan.ssl` analysis root from a
native server loading the complete workspace. The standalone run does not
measure server readiness or SQLite publication. The native run ends its startup
measurement at the `ready` notification, then records saved-file hover,
definition, references and folding answers before a clean shutdown. It performs
no edit or warm restart.

“Cold” describes the compiler's persistent probe cache and, for the native run,
the workspace database. The operating-system page cache is not flushed. Each
run has a new evidence directory and probe prefix; the installed cache is not
cleared. The native harness temporarily preserves any existing workspace cache
and restores it afterward. Source and configuration hashes are checked. Builds
and other C compilation are kept outside measured runs.

## What the observer records

The ordinary redeclaration queue is driven by repeated C names across foreign
imports. Each import exposes the names found in its header's transitive include
closure. The checker compares the final exported member for each name with the
member found through earlier imports. Shared headers therefore expose the same
original declaration repeatedly, including declarations that Titan never uses.
See [the name registry and queue](https://github.com/mascarenhas/titan/blob/788b353bed8e2580bbf12bf8ebf4ad9e7f1ab47d/titan-compiler/checker/declarations.lua#L765)
and [finalization](https://github.com/mascarenhas/titan/blob/788b353bed8e2580bbf12bf8ebf4ad9e7f1ab47d/titan-compiler/checker/c_types.lua#L814).

Each logical probe request joins to its existing SHA-256 source key, exact raw
C bytes, header context, requesting module, purpose and result. Physical runner
attempts have separate IDs, launch outcomes, argv and timing endpoints. This
preserves the many-to-many relationship between names, candidates and actual C
compilations. Multiple declarations sharing one key count as one physical probe
when the existing cache serves the later requests.

The observer separately records header-name inventory, redeclaration candidates
and resolved C names in checked Titan code. Reachable type identities are useful
secondary evidence; a shared integer type does not establish use of every macro
or name with that type. Unobserved candidates do not by themselves prove that a declaration can be
omitted. Aggregate-layout closure is outside this observer. The proposed
combined-header design changes the need for cross-import comparisons directly,
under the maintainer's accepted C-diagnostic policy.

Span endpoints record monotonic wall time, parent process CPU, current-thread
CPU, and cumulative reaped-child user/system CPU. The span analyzer subtracts
the union of direct-child intervals and reports non-ancestral overlap. CPU
consumed during an asynchronous interval is not isolated task CPU. Native
SQLite API spans include argument transfer, queueing and worker return; this
experiment does not split native binding from stepping. The documented remaining
direct SQL sites and uncaptured work stay in residual time.

Trace writes and source captures also report their own measured overhead. That
counter excludes metadata construction and some observer bookkeeping, so it is
only one component of perturbation. Instrumented wall times are not an
unmodified production benchmark or a measured optimization speedup.

## Observer validation

A real `titan.math` control uses the original compiler with the observer
disabled. Its public/source-visible manifests and all 86 persistent cache
records are byte-identical to the observed run, including the exact key set.
A deterministic fake-runner check also covers acceptance, rejection, memory and
persistent reuse, baseline failure, rendering/preparation/launch failures and
cancellation propagation. This checks the observer's behavior; one corpus and
synthetic boundaries do not prove compiler equivalence.

The ordinary native protocol smoke passes with profiling disabled. A separate
native `titan.math` smoke validates the enabled compiler/server span join before
the full workspace measurement. Complete traces require terminal markers,
matched span/request/execution lifecycles and source hashes; an `INCOMPLETE`
marker invalidates a capture.

## Controlled native workspace results

The native server uses `/usr/bin/cc` directly, with `CCACHE_DISABLE=1` and a
controlled SDK/system search path. All 63 modules finish indexing with zero
diagnostics in **1,775.141 seconds** (29m35s); launch-to-ready is 1,775.164
seconds. Recorded process CPU to readiness is 875.940 seconds and reaped-child
CPU is 892.520 seconds. These clocks are separate from elapsed wall time.
At readiness, the instrumented process has a sampled peak RSS of **18.67 GiB**; this is
not an uninstrumented memory measurement.

The capture contains 1,387,134 compiler events, 230,227 compiler spans and
110,481 server spans. Every span closes; all 9,496 captured C sources match
their SHA-256 keys, totaling 39,957,167 bytes. The joined span, probe and demand
integrity checks pass without anomalies.

| Probe purpose | Logical requests | Distinct keys / physical launches | Runner seconds |
| --- | ---: | ---: | ---: |
| Ordinary redeclaration | 92,834 | 8,729 | 1,150.374 |
| Enum carrier selection | 1,420 | 501 | 56.171 |
| C operator | 497 | 209 | 26.381 |
| Ordered-header baseline | 9,502 | 32 | 3.927 |
| Unsafe object-pointer conversion | 63 | 25 | 2.771 |
| **Total** | **104,316** | **9,496** | **1,239.624** |

The remaining 89.250 seconds of probe time consists of enum carrier selection
(4.53% of all probe time), C operators (2.13%), header baselines (0.32%) and
object-pointer conversions (0.22%). Combining headers does not automatically
eliminate the type and operation questions.

The 454 rejected carrier probes are expected selection results; all other
physical probes accept. Existing caches serve 94,173 requests from the shared
service and 647 from the analysis context. Thus the large physical count
persists despite substantial reuse inside the cold process.

Ordinary redeclaration probes consume **92.8% of probe-runner time**. Their
largest groups are 5,072 exact-function keys with identical rendered sides
(709.155 seconds) and 3,118 exact-typedef keys with identical sides (373.248
seconds). Together these account for 94.1% of ordinary-probe time. The complete
[shape table](ffi-probe-profile-data/native-full/native-probe-findings.md#ordinary-probe-shapes)
keeps distinct keys separate from the much larger logical request counts.

SSL alone requests 3,237 distinct keys and consumes 515.297 seconds in probe
runners. Its 3,219 ordinary keys account for 512.395 seconds. No SSL key is
shared with another module, but 465 keys elsewhere are shared across modules;
adding all per-module key totals would overcount physical work.

### Where the rest of startup goes

The observer provides the following selected phase residuals. Each subtracts
its directly linked child spans in the corresponding clock; a CPU residual is
interval consumption, not isolated task CPU. Times are seconds.

| Phase | Residual wall | Server process CPU | Reaped-child CPU |
| --- | ---: | ---: | ---: |
| Physical probe runners | 1,239.624 | 344.320 | 890.617 |
| Probe request construction, cache lookup and publication | 214.536 | 214.172 | 0 |
| Graph serialization across project/header/FFI graphs | 60.471 | 60.192 | 0 |
| Source checking after linked child work | 56.508 | 54.479 | 1.830 |
| Redeclaration finalization after linked probe work | 34.777 | 34.600 | 0 |
| SQLite statement-helper work outside linked APIs | 30.771 | 30.603 | 0 |
| Titan header preprocessing | 28.075 | 27.643 | 0 |
| Semantic publication outside linked child work | 27.174 | 27.030 | 0 |
| Downstream FFI conversion | 10.113 | 10.068 | 0 |
| Compiler-to-Titan module normalization | 3.211 | 3.200 | 0 |

The [complete phase accounting](ffi-probe-profile-data/native-full/native-span-accounting.md)
includes SQLite prepare, execute, query/fetch, cursor iteration, argument
construction, close and commit boundaries, plus smaller and unassigned work.
The summed startup residuals overcount the refresh interval by 2.530 seconds
of wall time and 2.516 seconds of process CPU because of independent branches
and missing parent edges. The table is not an exact global partition.

The inclusive publication window is 101.393 seconds. It contains 40.259 seconds
of project export, including 36.129 seconds of project graph serialization,
and a 59.636-second publication transaction. These inclusive times nest within
other measurements and must not be added to the residual table. SQLite API
spans include marshaling, worker queueing and completion; native bind/step time
is not independently measured.

The 344.320 seconds of parent CPU inside probe-runner intervals is particularly
important: the runner boundary includes the native server's spawn, pipe drain,
wait and result handling, as well as other task work during suspension. This is server-process CPU; GCC CPU is recorded separately in the reaped-child
clocks. Likewise, the request residual includes
rendering, hashing, cache work, metadata construction and observation; it is
not a pure hashing measurement.

The [launcher audit](ffi-probe-profile-data/native-full/runner-launch-followup.md)
confirms that this native executable uses libuv's Linux `fork` path, while
standalone Lua uses libc `popen`. Splitting launch from drain/wait and sampling
process memory at each launch is the next measurement needed to test whether
the large native address space makes launching materially more expensive. The
current profile does not establish that cause.

Measured compiler and server observation components total **189.600 seconds
of wall intervals and 188.628 seconds of process CPU**, already included in the
figures above. They exclude some clock sampling, metadata, allocation/GC and
asynchronous writing. Subtracting that total would not reconstruct an
unmodified startup benchmark.

### Demand and preserved workspace state

The completed demand observers record 780 directly resolved C header/name slots.
Considering every origin of each key, 7,212 keys have no demand observed in
recorded syntax or selected type edges and consume 972.350 seconds of runner
time. Another 1,315 keys only overlap selected type identities. Shared scalar
types account for most candidate-level overlaps and do not prove name use.
Only 52 keys have exclusively directly demanded ordinary origins; another 150
mix direct demand with other origins. The remaining 767 keys represent global
baselines and other C questions.

These classes are not a deletion list or a speedup estimate. They do show that
whole-header cross-import reconciliation asks many questions unrelated to the
C names resolved by Titan code. See the [demand summary](ffi-probe-profile-data/native-full/demand-summary.md)
for exact grouping rules and the five observed tag slots outside ordinary-name
inventory coverage.

All 135 configured source hashes and the configuration hash match their initial
values, and the original absence of `.titan-ls` is restored. Saved-file hover,
definition, references and folding complete in 8–13 ms after readiness. The
retained 866,623,488-byte SQLite database passes a read-only `quick_check` and
contains 63 project snapshots, 135 semantic files, 66,787 hovers/occurrences and
4,817 folds. This validates the completed cold publication and selected feature
answers; it is not a warm-restart comparison.

## Standalone SSL pilot results

With a fresh Titan probe cache, the `titan.ssl` root checked nine modules with zero diagnostics in
845.10 seconds of process wall time. The observed compiler interval covers
844.095 seconds. The completed capture contains 814,823 events, 137,212 matched
spans and 5,627 physical probe-driver launches. These totals include SSL's checked
dependencies, so they must not be read as SSL-only attribution.

The pilot inherited a system `cc` entry that resolves through ccache. Its cache
was not explicitly disabled and its per-invocation hit state was not captured.
The request/source/demand joins remain useful, but these durations do not
establish cache-independent C compilation cost. The authoritative native run
uses explicit `/usr/bin/cc`, a controlled search path and `CCACHE_DISABLE=1`.
Diagnostic replays also disable ccache, recording that environment change.
[Ccache documents this switch as bypassing its cache](https://ccache.dev/manual/4.14.html).

| Measurement | Seconds | Meaning |
| --- | ---: | --- |
| Individual probe runners | 684.443 | Summed, non-overlapping runner wall intervals |
| Parent process CPU at trace end | 160.154 | Includes observer work |
| Reaped-child user CPU | 461.500 | C compiler descendants, plus any other reaped children |
| Reaped-child system CPU | 213.886 | Separate from parent CPU and runner wall |
| Recorded trace/source sink overhead | 46.412 wall / 46.187 CPU | Partial observer overhead; not a complete subtraction correction |

Probe runners occupy approximately 81.1% of the observed compiler interval.
The remaining measured parent work includes 93.915 seconds of probe-request
residual time, 23.392 seconds of checking residual, 13.897 seconds of initial
header preprocessing and 12.815 seconds of redeclaration-finalizer residual.
The request residual includes rendering, hashing, bookkeeping and observation;
this experiment does not isolate those components. Sink overhead is already
inside these intervals and must not be added again.

The span integrity checks pass. One unparented header-processing span overlaps
the compiler root by 0.269 seconds. Consequently, the category residual sums
are useful local attribution, not a perfectly disjoint partition of the entire
run. Inclusive module/check/request totals contain nesting and must not be
summed as startup time.

### Which questions create distinct probes?

The pilot issued 55,959 ordinary redeclaration requests, yielding 5,171 distinct
source keys. All accepted. Another 896 enum-carrier requests yielded 320 keys,
including 290 expected rejections used to select the correct carrier. Operators,
pointer conversions and ordered-header baselines account for the remaining
136 keys. Rejection counts therefore do not mean the Titan program has errors.

| Ordinary-probe shape | Distinct keys | Requests |
| --- | ---: | ---: |
| Exact function, identical rendered declarations | 3,476 | 11,377 |
| Exact typedef, identical rendered declarations | 1,391 | 3,580 |
| Conditional function, identical rendered declarations | 102 | 364 |
| Conditional typedef, identical rendered declarations | 86 | 193 |
| Exact integer, identical rendered declarations | 80 | 34,781 |
| Exact pointer, identical rendered declarations | 18 | 5,158 |
| Exact float, identical rendered declarations | 7 | 480 |
| Exact array, identical rendered declarations | 7 | 16 |
| Exact function, different rendered declarations | 4 | 10 |

These are the existing checker's classifications. They do not by themselves
prove a C-semantic shortcut. Of the 5,171 keys, 5,167 render identical left and
right declaration text. For 5,036 keys, every requesting candidate also records
the same physical source identity and line/column on both sides. That includes
all 3,476 identical exact-function keys. Matching source location does not prove
equal macro state or the same declaration emission under the cumulative header
preamble.

The distinction between requests and distinct keys changes the priority. SSL's
`int titan_probe_d` pair alone serves 13,965 candidates representing 5,534 names
with one physical driver launch. Its `const char *` pair serves another 4,832
candidates and 2,372 names with one launch. Avoiding repeated request construction
could save parent work, but those groups already avoid almost all repeated C
compilation. Function and typedef questions dominate the remaining distinct work.

### Observed demand is evidence, not a skip list

SSL itself contributes 32,698 ordinary candidates and 3,237 distinct keys across
all purposes. The completed demand observer finds 89 directly resolved C
header/name slots, including 28 macros. Among the candidates, 35 have directly
observed name/header demand, 17,572 only overlap reachable type identities, and
15,091 have no observed demand. Six candidates already take the existing
baseline-only `source-repeat` path.

At key level, 3,054 SSL keys have only unobserved ordinary-candidate origins.
Another 23 keys mix direct demand with other origins, and only three have solely
directly demanded ordinary origins. The remaining keys cover weak type overlap,
operations and the global header baseline. A rule that simply deletes every
unreferenced name would ignore these shared-key relationships and the compiler's
current requirement to reject incompatible header declarations.

The demand observer follows selected checked syntax and signature/type edges.
It does not establish complete aggregate-layout closure. Across the nine-module
pilot, four directly used `titan.uv` tag names have no ordinary-name inventory
row because tag projection is a separate namespace; that coverage limit is
reported rather than treating those names as unused.

## Where representative GCC invocations spend time

Ten captured keys were replayed three times each, sequentially, with ccache
explicitly disabled. The selection includes SSL's ordered-header baseline,
reused scalar, exact function and typedef, conditional declaration, C operator,
another expensive key, and three carrier examples from dependencies. All 30
runs preserved both the expected success/rejection and the exact exit status.
Raw sources match their original keys; temporary C/object paths are relocated.

GCC's `-ftime-report` places a median **95%** of reported time in parsing across
these selected runs (92–97%). Preprocessing has a median **51%** share (48–58%)
and is included in parsing. It is not another 51% to add. Representative
per-key median shares are:

| Selected SSL question | Parsing | Preprocessing, included in parsing |
| --- | ---: | ---: |
| Ordered-header baseline | 93% | 49% |
| Reused scalar declaration | 96% | 51% |
| Exact function declaration | 96% | 51% |
| Exact typedef declaration | 96% | 51% |
| Conditional declaration | 95% | 50% |
| C operator | 92% | 48% |

The common header preamble dominates these representative invocations even when
the actual question is a short declaration. This supports prioritizing fewer
unnecessary physical probes. It gives little support for expecting a large
improvement from adjusting C optimization/code-generation flags alone.

These are diagnostic replays, not a random sample or a replacement startup
benchmark. GCC's printed timers are coarse and add overhead. This GCC version
prints wall-only pass rows; per-pass CPU is unavailable. The separate `-time`
records preserve compiler/assembler user and system CPU. The raw stderr was
retained and reparsed after the initial parser encountered the wall-only format;
the original replay outputs remain unchanged.
[GCC documents these timing options](https://gcc.gnu.org/onlinedocs/gcc/Developer-Options.html).

## Leading proposal: one header environment and reserved `ffi`

The maintainer proposes replacing separately named foreign-import namespaces
with unbound header imports and a single reserved `ffi.` namespace:

```titan
foreign import "openssl/ssl.h"
foreign import "openssl/err.h"
```

For each Titan module, collect its headers in source order, build one ordered
header source, and preprocess/parse that source once. Expose the resulting C
values and types through `ffi.`. Reserve that compiler-provided binding so a
regular Titan import cannot claim the name. This derives the declarations from
the combined macro/include-guard context and removes the artificial task of
reconciling separate header namespaces.

The generated module header carries this environment. Put module A's ordered
foreign includes into `A.h`, before declarations that use their types. `A.c` includes `A.h`. If module B directly source-imports A, B's header includes
`A.h`, and `B.c` includes its own header. This also carries the chain to further
source importers. The ordinary C include graph carries transitive foreign dependencies,
replacing the compiler's separate collection and reconstruction of those header
lists for direct source imports.

The [implementation-boundary audit](ffi-probe-profile-data/combined-ffi-environment-design.md)
maps this design to the parser, checker, driver, code generator and LSP bridge.
The checker and LSP analysis should consume this same header structure. The
pipeline therefore needs the relevant generated module headers available before
dependent analysis, with matching include order and relative-header resolution.
Other generated C glue remains a separate question from foreign-header
propagation; the proposal does not imply removing code that implements source
foreign bodies merely because their headers become transitive includes.

The targeted native family is **8,729 distinct ordinary redeclaration probes
and 1,150.374 seconds of runner time**, including 3,219 probes and 512.395
seconds in SSL. Carrier selection, operators, pointer conversions and other
semantic questions remain separate families. Removing the reconciliation queue
also removes some request construction and finalization work, whose measured
residuals include instrumentation. Neither baseline is a measured speedup from
implementing the proposed interface.

This is a language-interface change, including migration of existing aliases
throughout the standard library, tests and other consumers. Its design needs
explicit header order for folder modules, reservation and lookup rules for
`ffi`, ordinary-name/tag exposure, and consistent C type identities across Titan
module boundaries. One combined declaration environment should avoid creating
the duplicate per-header type graphs whose reconciliation currently causes the
probe explosion.

The accepted FFI risk model leaves ordinary implicit C conversions to the
programmer and the C compiler. Deferring actual incompatible redeclarations to
compilation of generated C is an intentional diagnostic-policy change; this
proposal is not required to preserve every earlier per-name conflict diagnostic.

An alternative with less syntax migration is to keep the existing import forms,
remove their per-name probes and resolve repeats using the last declaration.
That still needs coherent redirection of earlier namespace/type references.
The [strict-equivalence review](ffi-probe-profile-data/semantic-review.md)
documents why preserving the old rejection behavior would require more proof;
its diagnostic and implicit-conversion concerns are not additional requirements
on the maintainer's proposed policy. No production FFI redesign is implemented
in this profiling change.

## Second proposal: one result-bearing enum-carrier probe

The maintainer proposes compiling all carrier alternatives in one specialized
query and caching the **selected carrier**, replacing the current series of
Boolean compatibility probes. Grouping the captured sources by their complete
common header/type question and checking the actual ordered eligibility lists
produces:

| Existing candidate search | Count |
| --- | ---: |
| Logical whole-selection requests | 138 |
| Logical candidate requests | 1,420 |
| Distinct whole-selection questions | 47 |
| Distinct candidate compilations | 501 |
| Questions with 9 eligible carriers | 8 |
| Questions with 11 eligible carriers | 39 |

Every distinct question has exactly one accepted carrier in this corpus; no
eligibility variants split an otherwise identical source-shape question. With
equivalent whole-query reuse, this would replace **501 compilations with 47**,
removing 454 compilations (90.6%). This is a source/question-count estimate,
not a measured reduction of the current 56.171-second carrier-runner interval.
The combined-header redesign may also change these contexts and counts.
See the [exact grouping evidence](ffi-probe-profile-data/native-full/enum-selection-analysis.json)
and [offline derivation](../scripts/profiling/analyze-enum-selection.py).

The complete raw probe source should encode the enum surface, ordered header
context, eligible alternatives and result protocol. Its SHA-256 remains the
cache identity. A result-bearing cache record stores a validated stable carrier
ID, or a deterministic no-supported-carrier result; infrastructure failures
remain retryable. Existing Boolean probe families retain their own result
contract. The selected type must still supply the compiler's signedness, width
and rank, and enumerator-value range checks remain a separate requirement.

The [carrier-query design](ffi-probe-profile-data/native-full/enum-selection-design.md)
describes a GCC/Clang compatibility-builtin expression and reuse of Titan's
existing ELF/Mach-O section reader. The compilation should reveal the selected
ID without executing a target program. A compile-time type selection can encode a result into an emitted
artifact; the exact selection expression and extraction protocol need to be
verified across the supported C compilers and target formats. This profiling
change does not implement that protocol or alter production cache records.

## Reproduction and evidence

See [the profiling tools](../scripts/profiling/README.md) for command syntax,
artifact schemas and analyzer limitations. The experiment patches are tied to
the revisions above and belong in disposable checkouts. They are observations,
not a selected compiler optimization.

The [evidence inventory](ffi-probe-profile-data/README.md) links compact checked-in
reports, exact selected sources, all 30 GCC replay outputs and the historical
measured harness. Its [manifest](ffi-probe-profile-data/manifest.json) records
hashes and identifies large raw traces, full source sets, database, binary and
logs retained locally under `.build/ffi-profiles/20260908/`. These local captures
are not remotely available through the repository.

## Delivery verification

The final uninstrumented server/extension passes the complete Linux gate under
`xvfb-run -a make -j1 verify`: 302 Titan tests, 56 JavaScript tests, 12 extension-host
tests, native protocol/cache/adapter smokes, plugin validation, installation and
VSIX/native dependency inspection. The first extension-host attempt lacked an
X display; the complete virtual-display rerun passed. The VSIX excludes the
experimental evidence, profiling scripts and clock module.

Separately, all 41 profiling-tool tests pass: 13 span/integrity fixtures, six
native process-cleanup cases, nine demand fixtures, nine GCC parser/relocation
cases and four replay process-lifecycle cases. Both observer patches reproduce
all 22 expected files and hashes. The deterministic observer fixture, real math
control, profiling-on native smoke, complete native trace integrity and 30
representative GCC replays provide the additional checks described above.

After measurement, the harness was hardened to stop surviving process groups
and wake pending protocol reads on interruption. If process termination cannot
be established, it preserves the experimental cache and original backup and
reports deferred restoration. These cleanup changes are tested separately; the
measured harness and unchanged observer patches remain identifiable. See
[the validation record](ffi-probe-profile-data/delivery-validation.json).
