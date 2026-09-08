# Fake-runner observer integrity, suffix3

This is the latest completed `titan-ffi-profile-integrity` suffix3 evidence.
The JSONL stream, raw C sources, wrapper variants, and analyzer outputs are
copied byte-for-byte; [manifest.json](manifest.json) records their hashes.
Historical `/tmp` paths in event metadata and the original report describe the
capture location. Offline analysis uses the retained relative source paths;
those historical directories are not required.

Every runner result is simulated. The generic archived analyzer uses the term
"compiler launches" for `started=true`; **this fixture launched no C compiler**.
Its wall/CPU measurements are fixture overhead and have no workload-performance
meaning.

| Recorded case | Count |
| --- | ---: |
| Logical requests | 18 |
| Exact raw source keys | 3 |
| Fake runner attempts | 9 |
| Simulated started results | 7 |
| Simulated not-started result | 1 |
| Unknown launch state after cancellation exception | 1 |
| Preparation failure before an execution ID exists | 1 |

[profile-off.stdout](profile-off.stdout) and
[profile-on.stdout](profile-on.stdout) are identical. They preserve results for
service, persistent, and analysis-cache hits; deterministic rejection and its
cached repeat; baseline, rendering, preparation, and spawn failures; publication
of an existing result; interruption; cancellation identity; and a closed
service. The final rows pair every fake runner source key with a fresh hash of
its exact bytes.

The captured wrappers use one logical name for two distinct byte sequences and
reuse the original variant. The demand observer sees a primitive foreign macro
and a type-qualified alias while excluding the unused imported member table.

To analyze the archived stream independently:

```sh
python3 -E "$TOOLS/analyze-probes.py" \
  "$TOOLS/tests/fixtures/observer-integrity-v3/capture" \
  --out "$REPORT/archived-observer-probes"
python3 -E "$TOOLS/analyze-demand.py" \
  --trace "$TOOLS/tests/fixtures/observer-integrity-v3/capture" \
  --output "$REPORT/archived-observer-demand.json" --verify-sources
```

Write reports outside this archive. To regenerate the experiment using explicit
local paths, follow [the validation instructions](../../README.md).
