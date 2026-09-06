# Replace the server JSON implementation with titan.json

Owner: [vscode-titan issue #47](https://github.com/mascarenhas/vscode-titan/issues/47).
Branch: `refactor/stdlib-json`, based on merged PR #46 at
`1de4488440241abc7e84a09818e215eace1c6918`.
Compiler baseline: pristine isolated Titan master
`65523fa1e0bcc23b411f956b967c3a3b17dbc581`.

## Intended result

Remove `server.json`, including its handwritten codec and recursive nominal
Value/Object/Member/Array tree. Use `titan.json` with native Maps and Arrays at
the wire boundary. Preserve nominal request IDs and parsed LSP records, saved
file semantics, asynchronous request ownership, and the static runtime boundary.

PR #46 passed Linux CI run `34000527739` and was merged with explicit maintainer
authorization before this branch was created. Its 21-module metadata inventory
and API 5 provider are the starting point. The migration and any new Titan PR
remain open for review after verification; they are not authorized for merge.

## Shared wire boundary

Add `server.wire` with transparent `Object = {string: value}` and
`Array = {value}` aliases, one private nonnil null singleton, `null`/`is_null`,
`decode`/`encode`, and strict `as_object`, `as_array`, `as_string`, `as_integer`,
and `as_boolean` extractors. Configure the same stdlib `null_value` token for
encoding and decoding. Do not add recursive conversion, legacy constructors,
a replacement parser-error record, or a second recursive JSON representation.

Use `reflect.inspect` tags for extraction, preserving integer-versus-float and
actual booleans. Dynamic request parameters/results use `value`, which already
admits nil. Missing fields are nil; explicit JSON null is the singleton.
Wire builders declare their native container type explicitly, preserving empty
arrays, absent optional members, scalar IDs, and protocol field names.

## Policies and upstream depth investigation

- Preserve explicit nulls, missing/null parameter distinctions, strict signed
  32-bit request and cancellation IDs, strict positions, false flags, and
  continued operation after rejected input.
- Preserve the existing accepted input depth of 128. Baseline Titan JSON
  capped the option at 64. Private experiments showed that removing only
  that check permits 128 nested arrays, while objects expose independent PEG
  matching-stack and delayed-capture limits. Investigate unnecessary capture
  layers before broadening native engine changes. Retain delayed folds, bounded
  callback arity, linear parsing/node construction, and independent engine-error
  propagation. Keep the encoder and post-parse traversal in validation.
- Any necessary stdlib/compiler change gets its own isolated Titan branch and
  plan; the active sibling checkout remains untouched. Publish its PR only after
  the extension is locally wrapped and verified, then pin its exact commit.
- Use strict stdlib rejection of numeric overflow/underflow, classified as
  Invalid Request for syntactically valid but unrepresentable values. This was
  the announced default after an optional preference question received no
  answer; regressions distinguish it from malformed-number Parse errors.
- Keep the 16 MiB input framing boundary. Choose node/output budgets explicitly
  without unintentionally rejecting valid input below that byte boundary. Ensure
  a fallback error can still encode the largest accepted string ID.
- Handle expected encoding errors in response construction with a fixed Internal
  Error response carrying the same ID; unexpected runtime failures retain their
  propagation. Preserve best-effort logging and diagnostics, and cover indexing
  status listener encoding failures without disrupting index work.
- Accept stdlib's deterministic sorted Map keys and update order-sensitive
  fixtures while preserving meaningful wire shape assertions.

## Implementation work

1. Add the shared wire boundary, migrate dispatcher/lifecycle/LSP validators and
   builders, and preserve typed request/parameter ownership.
2. Migrate application/coordinator/protocol/diagnostics/indexing and structured
   logging callers/tests to native containers. Remove the legacy codec and its
   duplicate generic tests; retain server-specific boundary regressions.
3. Update the test aggregator and runtime expectations: JSON/reflection become
   used runtimes, while SQLite stays the unused metadata-only witness. Preserve
   generator runtime independence and SDK-free package analysis.

Parallel ownership: root owns wire, dispatcher, lifecycle, LSP types, their tests,
legacy removal, aggregate/runtime tests, build staging, and delivery. The logging
owner changes logging, compiler bridge/I/O/scheduler, project service, semantic
index, executable logging callers, and logging tests. The application owner
changes application, coordinator, protocol, diagnostics, indexing status and
their tests plus semantic feature fixtures. Depth experiments use a private
source/build tree and never mutate the shared SDK or provider staging.

## Validation and delivery

- Focused protocol tests cover nulls and absence, strict numeric/boolean tags,
  limits and numeric error classification, UTF-8/duplicate-key rejection,
  optional omissions, empty collection shapes, and recovery.
- Exercise response fallback and best-effort log/notification paths with
  unencodable values. Check largest legal ID handling against the output budget.
- Run the complete documented `make verify` gate, including native, JavaScript,
  extension-host, protocol/Codex, packaging, SDK-free VSIX inspection, plugin,
  and staged installation checks. Root alone owns shared build staging.
- Compare startup and saved-source indexing measurements with the PR #46
  baseline; stdlib JSON initializes its PEG grammar at startup. Revalidate real
  stdlib semantic queries and unchanged-generation reuse where appropriate.
- If Titan changes are needed, run its focused JSON/PEG suites and complete
  documented gate in an isolated prefix, then Linux CI. Never run macOS CI.
- Independently review the final diff, stage exact paths, commit and open a new
  PR with local/CI evidence. Keep issue #47's board state current and leave the
  new PRs open for maintainer review.

## Progress

- [x] Merge clean PR #46 and create a fresh migration branch.
- [x] Record the implementation plan before production edits.
- [x] Resolve depth and numeric/resource policies.
- [x] Replace the codec and all production/test callers.
- [x] Complete local extension verification and independent review.
- Publication and Linux CI completion are tracked on the linked PRs and
  issue #47 board item; the new PRs remain open for review.

## Implemented policies

- A minimal upstream object-capture refactor removes the redundant member
  wrapper. JSON accepts positive depth options, defaults to 32, and preserves
  independent PEG engine errors. The server explicitly chooses depth 128 and
  configures its PEG matching stack to 2048 once at startup. The complete
  private JSON suite passed 149 tests before canonical provider rebuilding.
- Input bytes remain 16 MiB; the node budget equals that byte budget, avoiding
  the stdlib default one-million-node ceiling on otherwise valid frames. Output
  bytes and nodes allow 16 MiB plus 4096 bytes so fixed error envelopes can
  retain any accepted string ID. Expected response encoding failures become
  Internal Error with that ID; unexpected runtime failures still propagate.
- JSON/reflection runtimes are now used. SQLite remains the unused-runtime
  metadata witness; interface generation still loads no stdlib runtimes.

## Local verification evidence

- The isolated SDK was rebuilt from the reviewed `fix/json-depth-policy`
  sources. The native server suite passed all 236 tests. The first compile
  exposed Titan's top-level constant-initializer restriction; replacing the
  output-limit reference with the equivalent literal expression resolved it.
- The remaining complete `make verify` gate passed with the native target
  marked already complete: 56 JavaScript unit tests, 12 extension-host tests,
  native stdio and Codex transcripts, target-specific packaging, plugin checks,
  staged installation, and extracted-package analysis with headers and a C
  compiler unavailable. JSON/reflection/SQLite package probes all passed.
- The local Linux x64 VSIX is 23010579 bytes, SHA-256
  `8b5fd55e615d28fefffa8c9a68ab4f30729fa9e354618295170309d75345d7d7`.
  The native executable is 65075856 bytes. CI packaging is a separate artifact.
- The previous PR #46 executable and migrated executable each indexed the same
  current saved workspace: 53 files, zero diagnostic reports, generation 53,
  valid hover/definition, immediate hover completed during indexing, and zero
  indexing notifications for unchanged queries. Baseline/current cold index:
  17659.699/14230.081 ms wall, 17560/14140 ms process CPU, and
  1196256/1060564 KiB peak RSS. This single paired measurement is a regression
  check on a busy machine, not a statistically established speedup.
- The benchmark now separately reports spawn-to-initialize startup wall time
  and Linux process CPU/RSS, rather than omitting native module initialization.
  The comparison used the same installed compiler modules for both executables.

- Startup-only measurements used one discarded warmup and five fresh measured
  processes per executable with normal debug logging, identical Lua paths, and
  no indexing notification. Median spawn-to-initialize time was 10.600 ms for
  the baseline and 13.718 ms for the migration; ranges overlapped at
  9.335–14.941 and 11.070–15.385 ms. Median startup peak RSS was
  13400/15200 KiB. Process CPU accounting had only 10 ms resolution. All twelve
  processes initialized, shut down, and exited successfully. Concurrent work
  and the small sample prevent a robust wall-time regression estimate.
- Final independent review found no implementation issues. Its documentation
  cleanup was applied; pinning CI to the upstream fix remains part of the
  publication sequence after the complete Titan gate.

## Upstream prerequisite and publication

- [Titan PR #145](https://github.com/mascarenhas/titan/pull/145) contains the
  reviewed depth fix at `63aff6722212edd318486607c7e01823c31f378a`. CI pins that
  exact commit; the local SDK and all verification above used those same
  production sources. The active sibling Titan checkout was not modified.
- The complete Titan gate passed 129 retained build/runtime checks, 3293
  compiler tests in four shards, and 455 native stdlib tests. Separate focused
  canonical selections passed all 149 JSON tests and 16 PEG tests.
- Independent final review is clean. Both new PRs remain open for maintainer
  review; Linux CI results and artifact provenance are appended to their PR
  descriptions after completion. No macOS workflow is dispatched.
