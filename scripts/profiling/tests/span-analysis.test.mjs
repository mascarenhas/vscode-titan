// Small, analytical trace fixtures. Never runs Titan, GCC, or the server.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const analyzer = fileURLToPath(new URL('../analyze-spans.mjs', import.meta.url));
const metrics = ['monotonic_ms', 'process_cpu_ms', 'thread_cpu_ms', 'child_user_ms', 'child_system_ms'];
const scales = [1, 1 / 2, 1 / 4, 1 / 3, 1 / 5];
function clock(time) {
  return Object.fromEntries(metrics.map((metric, index) => [metric, time * scales[index] + (index === 0 ? 100 : 0)]));
}
function pair(id, start, finish, parent, producer = 'compiler', name = id) {
  const fields = parent ? { parent_span_id: parent } : {};
  return [
    { event: 'span_begin', producer, span_id: id, name, fields },
    { event: 'span_end', producer, span_id: id, name, fields, start: clock(start), finish: clock(finish),
      delta: Object.fromEntries(metrics.map((metric, index) => [metric, (finish - start) * scales[index]])) },
  ];
}
function fixture() {
  // P = [0,30], A = [2,12], B = [7,22], Z = [25,25].
  // A union B = 20; A intersect B = 5; P residual = 10.
  const p = pair('P', 0, 30), a = pair('A', 2, 12, 'P');
  const b = pair('B', 7, 22, 'P'), z = pair('Z', 25, 25, 'P');
  return [p[0], a[0], b[0], a[1], b[1], ...z, p[1],
    { event: 'profile_end', producer: 'compiler', complete: true }];
}
function analyze(compiler, server) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-span-analysis-test-'));
  try {
    const args = [analyzer];
    for (const [kind, records] of [['compiler', compiler], ['server', server]]) {
      if (!records) continue;
      const input = path.join(directory, `${kind}.jsonl`);
      const prefix = kind === 'server' ? 'titan-language-server-profile ' : '';
      fs.writeFileSync(input, records.map((record, index) => prefix + JSON.stringify({ sequence: index + 1, ...record })).join('\n') + '\n');
      args.push(`--${kind}`, input);
    }
    const output = path.join(directory, 'summary.json');
    args.push('--out', output);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('overlapping children subtract their union, with zero-duration spans contributing zero', () => {
  const result = analyze(fixture());
  assert.equal(result.integrity.passed, true, JSON.stringify(result.integrity));
  assert.equal(result.complete_span_count, 4);
  assert.deepEqual(result.root_span_ids, ['P']);
  const spans = Object.fromEntries(result.spans.map(span => [span.id, span]));
  for (const [index, metric] of metrics.entries()) {
    near(spans.P.inclusive[metric], 30 * scales[index]);
    near(spans.P.direct_child_interval_union[metric], 20 * scales[index]);
    near(spans.P.residual[metric], 10 * scales[index]);
    near(spans.Z.inclusive[metric], 0);
    near(result.clock_coverage[metric].outside_every_span, 0);
  }
  near(result.non_ancestral_overlap.wall_interval_union_ms, 5);
  near(spans.P.non_ancestral_overlap_wall_ms, 0);
  near(spans.A.non_ancestral_overlap_wall_ms, 5);
  near(spans.B.non_ancestral_overlap_wall_ms, 5);
  near(spans.Z.non_ancestral_overlap_wall_ms, 0);
  assert.equal(result.non_ancestral_overlap.maximum_active_branches, 2);
});

test('CPU residual uses CPU endpoints independently of wall-time proportions', () => {
  const records = fixture();
  const endpoints = { P: [10, 50], A: [12, 18], B: [15, 31], Z: [36, 36] };
  for (const record of records.filter(record => record.event === 'span_end')) {
    const [start, finish] = endpoints[record.span_id];
    record.start.process_cpu_ms = start;
    record.finish.process_cpu_ms = finish;
    record.delta.process_cpu_ms = finish - start;
  }
  const result = analyze(records);
  assert.equal(result.integrity.passed, true);
  const parent = result.spans.find(span => span.id === 'P');
  near(parent.direct_child_interval_union.process_cpu_ms, 19);
  near(parent.residual.process_cpu_ms, 21);
  near(parent.residual.monotonic_ms, 10);
});

test('compiler spans can link to a server parent in a separately prefixed stream', () => {
  const child = pair('span:1', 2, 12, 'server-span:1');
  const parent = pair('server-span:1', 0, 30, undefined, 'server');
  const result = analyze([...child, { event: 'profile_end', producer: 'compiler', complete: true }],
    [...parent, { event: 'profile_summary', producer: 'server', active_spans: 0 }]);
  assert.equal(result.integrity.passed, true, JSON.stringify(result.integrity));
  assert.deepEqual(result.root_span_ids, ['server-span:1']);
  assert.equal(result.root_spans[0].linked_children, 1);
  near(result.spans.find(span => span.id === 'server-span:1').residual.monotonic_ms, 20);
  near(result.non_ancestral_overlap.wall_interval_union_ms, 0);
});

const invalidCases = [
  ['unclosed span', 'unfinished_span', records => records.filter(record => !(record.span_id === 'A' && record.event === 'span_end'))],
  ['duplicate begin', 'duplicate_begin', records => [records[0], ...records]],
  ['missing parent', 'unresolved_parent', records => records.map(record => record.span_id === 'A' ? { ...record, fields: { parent_span_id: 'absent' } } : record)],
  ['child outside parent', 'child_outside_parent', records => records.map(record => record.span_id === 'A' && record.event === 'span_end' ? { ...record, start: clock(0), finish: clock(31), delta: undefined } : record)],
  ['backwards clock', 'invalid_clock_interval', records => records.map(record => record.span_id === 'A' && record.event === 'span_end' ? { ...record, finish: clock(1), delta: undefined } : record)],
  ['inconsistent recorded delta', 'clock_delta_mismatch', records => records.map(record => record.span_id === 'A' && record.event === 'span_end' ? { ...record, delta: { ...record.delta, process_cpu_ms: 999 } } : record)],
  ['missing terminal marker', 'missing_compiler_profile_end', records => records.filter(record => record.event !== 'profile_end')],
  ['incomplete terminal marker', 'incomplete_profile_marker', records => records.map(record => record.event === 'profile_end' ? { ...record, complete: false } : record)],
  ['event sequence gap', 'event_sequence_gap', records => records.map((record, index) => ({ ...record, sequence: index + (index >= 3 ? 2 : 1) }))],
];
for (const [name, issue, change] of invalidCases) test(`integrity rejects ${name}`, () => {
  const result = analyze(change(fixture()));
  assert.equal(result.integrity.passed, false);
  assert.ok(result.integrity.counts[issue] > 0, JSON.stringify(result.integrity));
});

test('server traces require a summary and no active spans at that summary', () => {
  const records = pair('server-span:1', 0, 30, undefined, 'server');
  const missing = analyze(undefined, records);
  assert.equal(missing.integrity.passed, false);
  assert.equal(missing.integrity.counts.missing_server_profile_summary, 1);
  const active = analyze(undefined, [...records, { event: 'profile_summary', producer: 'server', active_spans: 1 }]);
  assert.equal(active.integrity.passed, false);
  assert.equal(active.integrity.counts.server_active_spans_at_summary, 1);
});
