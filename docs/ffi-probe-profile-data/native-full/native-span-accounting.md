# Native span accounting

Integrity: PASS; 340,708 complete spans.

Values are seconds. Residuals subtract directly linked child unions in each clock coordinate; rows are not a globally exclusive CPU partition.

| Startup phase | Residual wall | Process CPU | Sampling-thread CPU | Reaped-child CPU |
| --- | ---: | ---: | ---: | ---: |
| Other header processing and cache residual | 5.664 | 5.523 | 5.241 | 0.078 |
| Other named residual | 8.899 | 8.860 | 8.723 | 0.023 |
| Header preprocessing | 28.075 | 27.643 | 26.716 | 0.000 |
| C parsing | 0.447 | 0.444 | 0.444 | 0.000 |
| C type and macro conversion | 3.680 | 3.659 | 3.659 | 0.000 |
| Graph serialization | 60.471 | 60.192 | 60.187 | 0.000 |
| Source parsing | 1.212 | 1.207 | 1.207 | 0.000 |
| Source checking residual | 56.508 | 54.479 | 54.432 | 1.830 |
| Downstream FFI conversion | 10.113 | 10.068 | 10.068 | 0.000 |
| Redeclaration finalizer residual | 34.777 | 34.600 | 34.601 | 0.000 |
| Probe request construction and bookkeeping residual | 214.536 | 214.172 | 207.343 | 0.000 |
| Physical probe runner intervals | 1239.624 | 344.320 | 344.332 | 890.617 |
| Demand observation | 1.530 | 1.524 | 1.524 | 0.000 |
| Project export validation and wrapper residual | 4.129 | 4.109 | 4.109 | 0.000 |
| Other SQLite lifecycle APIs | 8.910 | 8.985 | 8.852 | 0.000 |
| SQLite statement-helper residual | 30.771 | 30.603 | 30.596 | 0.000 |
| SQLite prepare API | 6.545 | 7.019 | 6.371 | 0.000 |
| SQLite execute API | 10.289 | 9.858 | 7.569 | 0.000 |
| SQLite query and scalar-fetch APIs | 2.266 | 2.334 | 2.088 | 0.000 |
| SQLite cursor iteration including row decoding | 1.054 | 1.054 | 0.779 | 0.000 |
| Cache/publication wrapper residual | 6.615 | 6.576 | 6.576 | 0.000 |
| SQLite commit API | 0.131 | 0.028 | 0.002 | 0.000 |
| Project graph and scan wrapper residual | 6.863 | 6.820 | 6.665 | 0.000 |
| Workspace discovery and configuration | 0.059 | 0.058 | 0.040 | 0.000 |
| Saved-source observation residual | 0.251 | 0.248 | 0.235 | 0.000 |
| Compiler module normalization | 3.211 | 3.200 | 3.196 | 0.000 |
| Semantic preparation | 1.165 | 1.159 | 1.159 | 0.000 |
| Semantic publication wrapper residual | 27.174 | 27.030 | 27.025 | 0.000 |
| SQLite argument-array construction | 2.696 | 2.682 | 2.682 | 0.000 |

## Inclusive pipeline windows

These rows nest and must not be added to the residual table or to each other.

| Window | Count | Wall | Process CPU | Sampling-thread CPU |
| --- | ---: | ---: | ---: | ---: |
| project.scan | 3 | 14.132 | 14.139 | 13.908 |
| compiler.attempt | 37 | 1628.196 | 729.574 | 721.473 |
| compiler.resolve_check | 37 | 1624.852 | 726.229 | 718.158 |
| compiler.module_normalization | 63 | 3.211 | 3.200 | 3.196 |
| project.result_commit | 1 | 20.624 | 20.732 | 20.282 |
| publication.view | 1 | 101.393 | 101.371 | 98.731 |
| compiler.export_projects | 1 | 40.259 | 40.065 | 40.065 |
| semantic.features_prepare | 1 | 1.164 | 1.159 | 1.159 |
| publication.transaction | 1 | 59.636 | 60.046 | 57.433 |
| semantic.features_publish | 1 | 39.145 | 39.454 | 38.458 |
| publication.cache_write | 1 | 20.434 | 20.555 | 18.954 |

## Limits

- Client launch/initialized clocks and server monotonic clocks have different origins. Duration differences are available; no invented absolute READY timestamp or proportional CPU split is used.
- Root-link gaps and independent Tasks can both create unrelated branches. Category residual sums can double-count overlapping work; global wall overlap is a union, while per-category overlap is a sum.
- Probe runner wall spans include server spawn/drain/reap and any work during suspension. Process/thread CPU inside them is server CPU, not child GCC CPU.
- Public SQLite API spans include marshaling, worker queueing, native execution and completion. Argument arrays are a separately observed subset; native bind/step/worker CPU are not independently measured.
- Compiler and server overhead markers measure different partial producer costs. They exclude some sampling, metadata, GC and asynchronous writer work, and cannot be subtracted as a production speedup.
