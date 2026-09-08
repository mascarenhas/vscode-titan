# Native cold-start probe findings

This completed native LSP capture used `CC=/usr/bin/cc`, `CCACHE_DISABLE=1`, and the recorded SDK/system PATH. It is the controlled timing evidence; the earlier SSL pilot used ambient ccache and must not be treated as a comparable performance baseline. The compiler observer and source capture add work, so these are instrumented timings.

Integrity: **PASS**. The audit accounted for 1,387,134 events, 230,227 balanced compiler spans, 104,316 logical requests, 9,496 unique raw-source SHA256 keys, and 9,496 confirmed compiler-driver starts. All 39,957,167 captured source bytes matched their recorded size and source hash; no missing request ends, unmatched executions, or unknown starts were found.

Native indexing reached ready in 1775.141 s. Confirmed probe-runner intervals total 1239.624 s (69.83% of that interval); ordinary redeclaration probes account for 1150.374 s (92.80% of probe-runner time and 64.80% of indexing). These percentages describe recorded intervals, not the measured speedup of a proposed implementation.

| Purpose | Logical requests | Raw-source keys / starts | Runner wall, s |
| --- | ---: | ---: | ---: |
| foreign_redeclaration | 92,834 | 8,729 / 8,729 | 1150.374 |
| enum_carrier | 1,420 | 501 / 501 | 56.171 |
| c_operator | 497 | 209 / 209 | 26.381 |
| header_baseline | 9,502 | 32 / 32 | 3.927 |
| unsafe_object_pointer | 63 | 25 / 25 | 2.771 |

Of the enum/carrier runs, 454 were deterministic compiler rejections and 47 accepted. Other recorded physical outcomes were successful. The trace contains 94,173 service hits and 647 analysis hits, so repeated logical requests are already heavily shared by raw source.

## Ordinary probe shapes

Each key appears once in the following corpus-wide grouping. These are the checker classification and emitted declaration shape recorded by the observer, not independent proofs that the current checker may suppress a probe.

| Recorded classification and left type | Same rendered left/right | Keys | Requests | Runner wall, s |
| --- | :---: | ---: | ---: | ---: |
| exact, Type.CFunction | yes | 5,072 | 15,373 | 709.155 |
| exact, Type.CTypedef | yes | 3,118 | 6,963 | 373.248 |
| exact, Type.CInteger | yes | 182 | 62,755 | 23.029 |
| conditional, Type.CTypedef | yes | 139 | 265 | 16.832 |
| conditional, Type.CFunction | yes | 110 | 372 | 15.208 |
| exact, Type.CPointer | yes | 57 | 5,764 | 6.856 |
| exact, Type.CFloat | yes | 25 | 1,290 | 2.970 |
| exact, Type.CArray | yes | 20 | 40 | 2.395 |
| exact, Type.CFunction | no | 6 | 12 | 0.682 |

The 5,072 identical exact-function keys and 3,118 identical exact-typedef keys together account for 1,082.402 s, or 94.09% of ordinary probe time. In 8,322 ordinary keys every candidate pair had the same recorded physical source position; those keys account for 1,099.091 s. Source-position equality and matching rendered declarations do not establish the same macro environment by themselves.

The selected follow-up architecture removes this cross-import comparison layer: one generated module header, one C environment, and reserved `ffi`. The native data identifies why that is a high-value architectural change. It does not supply an end-to-end performance result for an implementation that has not been built.

## SSL and demand

SSL accounts for 35,989 requests, 3,237 starts, and 515.297 s of probe-runner time. Its 3,219 ordinary keys take 512.395 s. All SSL ordinary pairs have identical rendered left/right declarations; exact functions account for 2,582 keys / 414.304 s and exact typedefs for 495 keys / 75.883 s.

The completed demand observer provides the authoritative name-to-origin classification in `demand-summary.json`. It recorded 780 direct resolved-name slots across 63 completed module observers. Across the corpus, 7,212 keys with no recorded demand account for 972.350 s. SSL has 89 direct slots, including 28 macro slots, and 3,054 keys with no recorded demand account for 488.176 s. These are observation classes, not a proof that every corresponding declaration can be omitted: aggregate layout and relation-specific obligations remain outside the observer.

The most repeated SSL integer source (`3db359b...`) represents 13,965 candidates across 5,534 ordinary names but launches once, for 146.159 ms. Only four candidate origins match three directly observed names; the remaining candidates share scalar type identity. The `const char *` source (`f6e91c...`) represents 4,832 candidates across 2,372 names and launches once, for 159.389 ms. Candidate counts cannot be multiplied by per-launch cost, and weak scalar overlap does not establish per-name demand.

## Timing limits and replay validation

The observer reports 100.131 s wall and 99.611 s process CPU while writing 1,150,727,079 bytes. That narrow sink/source metric excludes metadata-construction overhead. Do not subtract it from overlapping compiler span sums to claim a clean uninstrumented result.

The compiler spans named `c_header.*` measure Titan preprocessor/parser/conversion work. GCC internal preprocessing/parser/pass timings are separate evidence, obtainable only from the diagnostic replay stderr. The previous 30 saved replays still parse as GCC wall-only reports, with all original exit statuses matching; relocation through the committed `gcc-stderr` directory now passes without consulting historical paths.

Replay parser/relocation tests pass 9/9. Process lifecycle tests pass 4/4, including termination while waiting, termination during the Popen handoff, timeout of a process tree, and cleanup after an already-exited process group. No compiler replay was launched by these tests or the offline reanalysis.

Sources: `setup.json`, `summary.json`, `probe-analysis.json`, `probe-shapes.json`, and `demand-summary.json`. Full request/span totals are inclusive and can overlap; do not sum them as exclusive stages.
