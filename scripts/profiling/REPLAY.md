# Representative probe replay

Run this only after the baseline compiler/server measurements have finished. It is a separate diagnostic experiment; it does not modify the instrumented compiler, cache policy, or production compiler flags.

Prepare a reviewable selection from a completed capture:

```sh
python3 scripts/profiling/replay-probes.py prepare CAPTURE_DIRECTORY \
  --out FRESH_REPLAY_DIRECTORY --module titan.ssl --limit 10
```

Preparation invokes no compiler. It selects at most 12 distinct physical source keys: an ordered-header baseline, a highly reused scalar pair, accepted exact function and typedef pairs, a conditional pair, named-enum and enumerator carrier rejections, an accepted carrier, and available range/extent/operator examples. Remaining slots use high-cost physical keys. The requested module is preferred; dependency examples can supply families absent from that module. Unavailable categories and blocked replays are explicit in `plan.json`.

Each selected C file is copied byte-for-byte and checked against its captured raw-source SHA256. Captured wrapper bytes are placed under their original basenames beside it. The original argv and working directory are retained; only temporary C/object path operands are relocated. The replay adds `-ftime-report` and `-time`: GCC documents these as per-pass timing on stderr and compiler-subprocess CPU timing, respectively. [GCC developer options](https://gcc.gnu.org/onlinedocs/gcc/Developer-Options.html)

After reviewing the concrete `plan.json`, execute that already prepared plan:

```sh
python3 scripts/profiling/replay-probes.py run FRESH_REPLAY_DIRECTORY/plan.json \
  --execute --repeats 3
```

Runs are sequential. The script verifies the selected source, wrappers, direct external headers, and resolved compiler executable before execution; records compiler version; preserves each raw stderr/stdout file; and emits `results.jsonl` with external wall/child CPU, exit-status checks, GCC pass rows, and GCC subprocess rows. Timeout, SIGINT or SIGTERM kills the started replay process group and reaps its leader; signals received during process creation are handled after the child handle becomes available. Compiler-version queries use the same cleanup path. An already-exited process group does not mask the original interruption. No resulting binary is executed.

If the recorded driver resolves through a `ccache` symlink, execution requires explicit `CCACHE_DISABLE=1`. Keep the original `PATH` so the driver fingerprint still matches, and label this bypass as a replay environment change when the baseline used ambient ccache. The script records `PATH`, `CC`, and a small allowlist of ccache variables in `replay-environment.json`, before launching anything. A ccache executable fingerprint identifies the wrapper; the subsequently recorded GCC version identifies the reported underlying compiler version. It does not fingerprint that underlying executable. Ccache documents `disable` as bypassing its cache and invoking the real compiler. [Ccache manual](https://ccache.dev/manual/4.14.html)

Use GCC's reported parsing/front-end, preprocessing, optimization/generation, and total rows to describe where representative invocations spend time. Keep raw rows: phase and detail timers can overlap, printed precision is coarse, and instrumentation perturbs these short compiles. Do not sum parent parsing time and its preprocessing detail as independent work or substitute replay timings for the baseline capture.

Reparse saved stderr offline into new JSON and Markdown artifacts without changing the original `results.jsonl` or invoking a compiler:

```sh
python3 scripts/profiling/replay-probes.py summarize FRESH_REPLAY_DIRECTORY/results.jsonl \
  --out FRESH_REPLAY_DIRECTORY/gcc-analysis
python3 scripts/profiling/test-replay-parser.py
python3 scripts/profiling/test-replay-lifecycle.py
```

For the committed evidence, whose raw stderr files have moved from their historical absolute paths, provide the relocation explicitly and choose a new output prefix:

```sh
EVIDENCE=docs/ffi-probe-profile-data/ssl-pilot
python3 scripts/profiling/replay-probes.py summarize "$EVIDENCE/results.jsonl" \
  --stderr-dir "$EVIDENCE/gcc-stderr" --out /tmp/titan-gcc-reanalysis-unique
```

Relocation reads only `<64-character-source-key>-repeat-<N>.stderr` from the supplied directory. The tool validates keys, repeat numbers, duplicate records, source-key agreement, regular files and directory containment; a missing file never falls back to the historical path. A recorded stderr hash is checked when available. Each observation retains the original `stderr`/`stderr_reported_path`, the actual `stderr_read_path`, and the bytes' SHA256. Original records and stderr remain unchanged. Lifecycle tests use sleeping Python process trees, including a signal injected during creation; they invoke no compiler. Run these functional tests outside measured captures.

This GCC 16 build prints `Time variable wall GGC`, so its pass rows contain wall seconds and memory, without per-pass user/system CPU. The parser recognizes that header and the legacy `usr sys wall GGC` form. It retains GCC's reported percentages, which can differ from ratios of the coarsely rounded printed seconds. `-time` subprocess CPU rows remain separate. Unparsed rows and missing/multiple compiler totals are explicit summary errors. The two real GCC 16 fixtures retain both successful and expected-rejection stderr; the legacy fixture exercises distinct CPU/wall columns.

The completed SSL diagnostic set parsed all 30 runs over ten exact keys. Reported parsing share ranges from 92% to 97% of GCC wall time (median 95%); preprocessing ranges from 48% to 58% (median 51%) and is included in parsing. These are representative samples with ccache disabled, not a workload-wide estimate or measured optimization speedup.

Exact raw C bytes do not mean a complete historical environment snapshot. The original capture did not preserve every transitive external header or ambient environment variable. Direct headers and the compiler are fingerprinted at preparation and checked again before replay. A captured wrapper that includes a deleted absolute temporary companion header cannot be reconstructed from wrapper text alone; the plan reports it blocked. Compiler wrappers/response files and SARIF diagnostic output also require separate review. A changed temporary source pathname can affect file-name macros, so these runs are labeled diagnostic replays rather than bit-for-bit historical executions.
