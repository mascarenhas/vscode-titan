# Native cold demand summary

Compiler: `/usr/bin/cc`, with `CCACHE_DISABLE=1` and the recorded SDK/system-only PATH. Capture closure and source hashes passed with zero anomalies. All 63 recorded module observers completed.

| Scope | Candidates | Logical requests | Exact source keys | Confirmed physical launches | Direct name slots |
| --- | ---: | ---: | ---: | ---: | ---: |
| Whole corpus | 94,260 | 104,316 | 9,496 | 9,496 | 780 |
| `titan.ssl` | 32,698 | 35,989 | 3,237 | 3,237 | 89 |

| Candidate evidence | Whole corpus | `titan.ssl` |
| --- | ---: | ---: |
| `exact_direct_resolved_name` | 453 | 35 |
| `not_observed_in_recorded_syntax_or_selected_types` | 28,454 | 15,091 |
| `operation_predicate_postcheck_relation_unknown` | 1,420 | 0 |
| `selected_type_identity_overlap_only` | 63,933 | 17,572 |

Entirely scalar identity overlaps: 63,813 in the corpus and 17,525 in SSL. These do not establish ordinary-name demand.

| Key evidence, considering all origins | Corpus keys | Corpus runner / reported child seconds | SSL keys | SSL runner / reported child seconds |
| --- | ---: | ---: | ---: | ---: |
| `direct_name_observed_shared_with_other_origins` | 150 | 18.608 / 18.491 | 23 | 3.673 / 3.628 |
| `direct_names_observed` | 52 | 6.530 / 6.477 | 3 | 0.489 / 0.486 |
| `global_header_validity` | 32 | 3.927 / 3.918 | 1 | 0.148 / 0.148 |
| `not_observed_by_completed_observer` | 7,212 | 972.350 / 966.703 | 3,054 | 488.176 / 485.735 |
| `operation_predicate_or_conversion` | 735 | 85.323 / 85.017 | 17 | 2.754 / 2.748 |
| `selected_type_overlap_without_direct_name` | 1,315 | 152.886 / 152.132 | 139 | 20.057 / 20.018 |

Keys requested by multiple modules: 465; SSL keys shared with another module: 0. Each key contributes once to the corpus groups.

## SSL shared-key examples

| Source key | Candidates | Names | Class counts | Physical launches | Runner / child seconds |
| --- | ---: | ---: | --- | ---: | ---: |
| `3db359b64964241182f4c308012193b88dd36dee8f5de6370e6d9a984836c7bb` | 13,965 | 5,534 | exact_direct_resolved_name: 4, selected_type_identity_overlap_only: 13961 | 1 | 0.146 / 0.146 |
| `f6e91c629bb3aaf539b7a85271ffd2e50156a420fa5a49969afdcd20ae601f66` | 4,832 | 2,372 | not_observed_in_recorded_syntax_or_selected_types: 4832 | 1 | 0.159 / 0.159 |
| `3d71a49227fd5f2b71f41cb2432fdd02ce8b8e1ab3705e37ce77637b27b70a4d` | 3,219 | 3,219 | exact_direct_resolved_name: 6, not_observed_in_recorded_syntax_or_selected_types: 3058, selected_type_identity_overlap_only: 155 | 1 | 0.148 / 0.148 |
| `5ff7780c5e639dceba96bdba477ad9a54a0bdeb4ca529219accb085f5024eb1b` | 3,012 | 1,461 | selected_type_identity_overlap_only: 3012 | 1 | 0.185 / 0.185 |

There are 5 direct slots without an ordinary inventory match, retained in the compact JSON. SSL has 0. Aggregate tags can be projected separately from ordinary inventory; these rows do not establish missing direct observations.

## Verification and limits

The native harness completed with zero diagnostics. The selected feature source and project configuration still match their setup hashes, and the original workspace-cache presence is restored. The 866,623,488-byte retained DB passed `PRAGMA quick_check` in `mode=ro&immutable=1` with `query_only=ON`; its size and mtime stayed unchanged and no sidecars were present. It contains 63 project snapshots, 135 semantic files, 66,787 hovers/occurrences and 4,817 folds.

The nine demand unit tests and relocated observer fixture also passed. The latter reproduced profiling-off/on and pinned suffix3 output exactly, using fake runners with 18 requests, three keys, nine attempts and simulated launch states 7 started / 1 not started / 1 unknown, plus one preparation failure before an execution ID.

Full analysis is retained as `demand-analysis.json`; this compact report omits per-candidate, per-request, per-key and per-execution arrays. Raw capture availability remains local unless separately published.

- Candidate counts, logical requests, exact source keys, and physical launches are separate measures.
- Key groups consider all related candidate origins and unassociated requests; baseline validity remains global.
- Selected type identity overlap is not demand for the ordinary name. Shared scalar identities can match many declarations.
- A completed observer supports only absence from recorded syntax and selected type edges. It excludes aggregate-field/global-validity closure and does not prove safe omission.
- Direct resolved header/name slots need not have redeclaration candidates; first imported declarations may require no conflict queue entry.
- Runner interval wall and reported child wall are distinct recorded measurements. Their difference is not isolated intrinsic overhead; interval/clock attribution limits still apply.
- Whole-key times identify observed work rather than predicted savings. Retaining one required origin retains its shared key.
- Module-key counts include any key requested by that module; shared module totals must not be summed as distinct physical work.
- Unmatched direct slots remain observed even when ordinary-name inventory has no matching row, including the separate C tag namespace.
- The retained DB check is read-only structural/count validation, not a warm-restart or semantic-equivalence test.
- Relative evidence paths identify retained local artifacts; this compact summary does not make the full raw capture remotely available.
