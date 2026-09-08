# Retained profiling evidence

The [report](../ffi-probe-profile.md) explains the measurements and proposed
optimizations. This directory contains compact derived evidence, ten exact
representative C sources, and the stderr/results of their thirty GCC replays.
The [manifest](manifest.json) records their hashes and identifies larger
artifacts retained locally in `.build/ffi-profiles/20260908/`. Those local raw
traces, complete source sets, compiled binaries and databases are not published
by this repository. This directory is excluded from the VSIX.

`native-full/` is the controlled native timing reference: a fresh workspace
database and probe prefix, direct `/usr/bin/cc`, and `CCACHE_DISABLE=1`.
`ssl-pilot/` supplies standalone source/demand detail and representative GCC
replays. The pilot inherited ccache with an unknown hit state, so its timings
are provisional; the replays explicitly bypassed ccache. Instrumentation adds
work to both captures. The report distinguishes partial observer overhead,
overlapping spans and unmeasured costs.

The native probe, demand and span summaries describe the same completed
process. Demand attribution uses `demand-summary.json`; the probe analyzer's
older broad type-overlap labels are not the authoritative demand classes.
`enum-selection-analysis.json` derives complete carrier questions from the
existing individual Boolean sources and eligibility batches. Its grouping
hashes are analytical identifiers, not proposed cache keys.

`provenance.json` records source/toolchain fingerprints and all 135 configured
source hashes. `native-full/preservation-and-features.json` records the final
source/configuration/cache checks and saved-file feature answers. The separate
database summary records the read-only integrity check and table counts.
Absolute paths in captured metadata identify this run's environment; they do
not make those files available on another machine.

The historical native harness is retained as
`native-full/measured-profile-native-cold.mjs.txt`. After the successful capture,
the delivered harness gained bounded process-group cleanup for failed or
interrupted runs, including surviving descendants after leader exit. Use the
current [profiling tools](../../scripts/profiling/README.md) for reproduction;
the text snapshot records the measured code and is not an executable entrypoint
at its archive location. The observer patches remain exactly those used by the
captured executable and compiler overlay.

The design notes describe future changes. They do not alter the measured
compiler or implement the shared `ffi` header environment, selected-carrier
cache result, or launcher optimization. The strict-equivalence review is
background about the former diagnostic policy; the maintainer has accepted
ordinary C implicit conversions as an FFI responsibility and deferring C
redeclaration errors to generated-C compilation.

To reparse the committed GCC stderr without the original paths or a compiler
invocation, follow [the replay instructions](../../scripts/profiling/REPLAY.md).
To verify all checked-in evidence hashes from the repository root:

```sh
python3 - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path('docs/ffi-probe-profile-data')
manifest = json.loads((root / 'manifest.json').read_text())
for entry in manifest['checked_in_evidence']:
    data = (root / entry['path']).read_bytes()
    assert len(data) == entry['bytes'], entry['path']
    assert hashlib.sha256(data).hexdigest() == entry['sha256'], entry['path']
print('All checked-in evidence hashes match')
PY
```
