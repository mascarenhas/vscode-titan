# Completion delivery measurements

Measured on 17 September 2026 with vscode-titan revision
`75ca2451916ab0afd75ce2f83a9baed38bf42b28`, compiler revision
`5c0cefb48c513956f6463674d8d3346390033ae9`, and a freshly built SDK. These
measurements precede the selected-provider catalog follow-up. The executable SHA-256
was `4310beb3f8ba1c69a10c92ab40a9c2082bcecd461047cdc840557e80483e187c`.
The host was Linux x86-64, AMD Ryzen AI 9 HX 370 (24 logical CPUs), GCC 16.2.1
and Node.js 24.13.0. Host load was not controlled; these are local observations,
not latency guarantees.

`scripts/test-completion-protocol.mjs` drives the native server over stdio. Its
large dirty module has 800 record fields; 30 unchanged requests measure warm
reuse. Separate cases exercise prefix typing, an unsaved-only header changing
without a document notification, eight successive buffer replacements, and a
saved-module refresh. No editor rendering time is included.

| Measurement | Samples | Median | p95 |
| --- | ---: | ---: | ---: |
| Warm large-module request, including framing and response | 30 | 3.68 ms | 14.57 ms |
| Fresh SQL selection, including connection-lease wait | 46 | 1.45 ms | 2.61 ms |
| Private preparation, including baseline reads and compiler contention | 17 | 77.69 ms | 460.84 ms |
| All transcript requests, including cold and refresh cases | 74 | 8.31 ms | 215.86 ms |

Medians use the middle pair where needed; p95 uses the nearest-rank definition.
Provisional selection has its own event and is not included in the fresh SQL
timings. The SQL and preparation rows include different contexts from the whole
transcript, so their distributions must not be subtracted from each other.
Preparation includes parsing/checking and header validation; publication and
encoding are reflected in request time rather than a separate phase timer.

The first useful large-module result took 212.81 ms. Provisional typing took
9.94 ms, and the first provisional response after an unsaved-only header edit
took 2.09 ms. Repeated requests eventually returned the new header name and
excluded the old one. A request competing with saved reanalysis took 215.86 ms.
The roughly 150 ms preparation wait is cooperative: synchronous compiler work
and connection contention can delay execution beyond that budget. Retained
candidates avoid requiring fresh analysis before every response; they remain
explicitly incomplete and use the current token's edit range.

## Memory and lifetime

Linux process RSS was 160.66 MiB before the large dirty module, 170.88 MiB after
it, 176.59 MiB after eight successive replacements, and 177.47 MiB after close.
The whole-transcript peak was 520.61 MiB, including earlier foreign-header work.
Successive updates can coalesce; these are eight buffer replacements, not a
claim that eight complete analyses were retained. RSS includes transient
compiler objects, saved state and allocator capacity, and need not fall
immediately when SQL rows are deleted.

The implementation enforces these owned-data bounds: 4 MiB per buffer, 32 MiB total
buffer text, 256 tracked documents, and 64 MiB of derived snapshot data with at
most 16 snapshots. Tests exercise admission at capacity, whole-batch replacement,
close/reopen cleanup, cancellation rollback, unchanged persistent file bytes,
second-connection isolation, and disappearance of TEMP tables after restart.
These bounds do not promise a process-RSS ceiling. See
[completion.md](completion.md) for descriptor and saved-baseline limits.

The extracted SDK smoke also exercises a large foreign namespace (23,475 saved
candidates and a roughly 12 MB detached descriptor). Profiling found that a
WITHOUT ROWID descriptor parent made child foreign-key checks reread its large
payload. Schema 5 separates the module-key index from that payload, and candidate
publication uses bounded 13-row inserts. Regression tests check the parent layout,
non-null key, large payload, partial batches and rollback after supersession.

Deterministic service tests separately pause workspace restoration with the
compiler permit available and held. They prove that private preparation uses
detached descriptors, warm selection performs no payload decoding, and useful
provisional candidates remain available during refresh. Those tests establish
ownership and independence; the transcript supplies the timing observations.

Reproduce with the pinned production SDK and shipping compiler flags:

```sh
make -j2 server server-test-build BUILD_PROFILE=production
make completion-protocol-test BUILD_PROFILE=production
```

The script prints raw request, preparation, selection and RSS samples as JSON.
Do not compare these shipping measurements with the cheaper `-O0 -fno-lto`
development build without recording that change.
