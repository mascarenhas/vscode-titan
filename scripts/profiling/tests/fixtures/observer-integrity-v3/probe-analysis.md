# Experimental FFI probe profile

Capture: `/tmp/titan-ffi-profile-integrity-capture3`

Integrity: PASS.

18 logical requests; 3 exact source keys; 7 confirmed compiler launches; 9 runner attempts; 1 attempts with unknown launch state.

| Purpose | Requests | Unique keys | Started | Runner wall, s |
| --- | ---: | ---: | ---: | ---: |
| header_baseline | 8 | 1 | 5 | 0.001 |
| foreign_redeclaration | 1 | 1 | 1 | 0.000 |
| declaration_compatibility | 8 | 2 | 1 | 0.000 |
| enum_carrier | 1 | 1 | 0 | 0.000 |

## Candidate demand evidence

| Evidence | Candidates |
| --- | ---: |
| no_observed_demand | 2 |

Observed 2 distinct module/header/name slots.

## Most expensive exact source keys

| Key | Purpose | Requests | Candidates | Started | Runner wall, s |
| --- | --- | ---: | ---: | ---: | ---: |
| `19487d82d89b30832e2bb679aa9f2bde9cdc617e06157b5ab2561aab41b01328` | header_baseline | 8 | 0 | 5 | 0.001 |
| `5646d9813dbf1dde74cd146b3f73d53c7ca3927d921ff237fae1328c161c74e6` | declaration_compatibility, enum_carrier, foreign_redeclaration | 5 | 2 | 1 | 0.000 |
| `c94feff99d2d58c83612c323104f7f613bf3bb1e64bf686ef4d258f0ba89ec19` | declaration_compatibility | 3 | 0 | 1 | 0.000 |

## Interpretation limits

- No observed demand does not prove a candidate unnecessary; aggregate layout closure is unknown.
- Shared scalar type IDs do not independently establish demand for each ordinary declaration name.
- Candidate names and raw-source keys have a many-to-many relation; a key can serve both directly used and unobserved names.
- Request and general span totals are inclusive and may overlap; do not sum them as exclusive work.
- Runner child CPU is cumulative reaped-child rusage; concurrency can prevent per-child attribution.
- Foreign-name inventory occurs on conversion misses; restored queues still yield candidate decisions.
