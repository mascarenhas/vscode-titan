#!/usr/bin/env node
// Offline evidence analysis only. This program never starts a compiler/server.
import fs from 'node:fs';
import { once } from 'node:events';
import readline from 'node:readline';
import { finished } from 'node:stream/promises';

const args = process.argv.slice(2);
const inputs = [];
let output;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--compiler' || arg === '--server') {
    if (!args[index + 1]) throw new Error(`${arg} needs a path`);
    inputs.push({ kind: arg.slice(2), path: args[++index] });
  } else if (arg === '--out') {
    output = args[++index];
    if (!output) throw new Error('--out needs a path');
  } else if (arg === '--help') {
    console.log('Usage: node analyze-spans.mjs --compiler events.jsonl [--server stderr.log] [--out summary.json]');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${arg}`);
}
if (!inputs.length) throw new Error('At least one --compiler or --server input is required');

const metrics = ['monotonic_ms', 'process_cpu_ms', 'thread_cpu_ms', 'child_user_ms', 'child_system_ms'];
const spans = new Map();
const eventCounts = {};
const issueCounts = {};
const issues = [];
const markers = [];
const inputStats = [];
function issue(kind, fields) {
  issueCounts[kind] = (issueCounts[kind] ?? 0) + 1;
  if (issues.length < 1000) issues.push({ kind, ...fields });
}
for (const input of inputs) {
  const stat = { ...input, lines: 0, records: 0, ignored_lines: 0 };
  const sequences = new Map();
  const lines = readline.createInterface({ input: fs.createReadStream(input.path), crlfDelay: Infinity });
  for await (let line of lines) {
    stat.lines++;
    if (input.kind === 'server') {
      const prefix = 'titan-language-server-profile ';
      const start = line.indexOf(prefix);
      if (start < 0) { stat.ignored_lines++; continue; }
      line = line.slice(start + prefix.length);
    }
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch (error) { issue('invalid_json', { file: input.path, line: stat.lines, message: error.message }); continue; }
    stat.records++;
    const producer = record.producer ?? input.kind;
    if (Number.isInteger(record.sequence)) {
      const previous = sequences.get(producer);
      if (previous !== undefined && record.sequence !== previous + 1) issue('event_sequence_gap', {
        source: input.path, producer, previous, current: record.sequence,
      });
      sequences.set(producer, record.sequence);
    }
    const event = record.event ?? '<missing>';
    const countKey = `${producer}:${event}`;
    eventCounts[countKey] = (eventCounts[countKey] ?? 0) + 1;
    if (event === 'profile_end' || event === 'profile_summary' || event === 'profile_start') {
      markers.push({ producer, event, source: input.path, ...record });
    }
    if (event !== 'span_begin' && event !== 'span_end') continue;
    const id = record.span_id;
    if (typeof id !== 'string') { issue('missing_span_id', { source: input.path, line: stat.lines }); continue; }
    let span = spans.get(id);
    if (!span) {
      span = { id, producer, name: record.name, source: input.path };
      spans.set(id, span);
    } else if (span.producer !== producer) issue('cross_producer_id_collision', { id, producer, other: span.producer });
    const slot = event === 'span_begin' ? 'begin' : 'end';
    if (span[slot]) { issue(`duplicate_${slot}`, { id, source: input.path, line: stat.lines }); continue; }
    span[slot] = record;
    if (span.name !== record.name) issue('span_name_changed', { id, begin: span.name, end: record.name });
  }
  inputStats.push(stat);
}

const complete = [];
for (const span of spans.values()) {
  if (!span.begin) issue('end_without_begin', { id: span.id });
  if (!span.end) issue('unfinished_span', { id: span.id, name: span.name });
  if (!span.begin || !span.end) continue;
  span.fields = { ...(span.begin.fields ?? {}), ...(span.end.fields ?? {}) };
  span.parent_id = span.begin.fields?.parent_span_id ?? null;
  span.start = span.end.start;
  span.finish = span.end.finish;
  span.children = [];
  span.inclusive = {};
  let valid = true;
  for (const metric of metrics) {
    const start = span.start?.[metric], finish = span.finish?.[metric];
    if (!Number.isFinite(start) || !Number.isFinite(finish) || start < 0 || finish < start) {
      issue('invalid_clock_interval', { id: span.id, metric, start, finish });
      span.inclusive[metric] = null;
      if (metric === 'monotonic_ms') valid = false;
    } else {
      span.inclusive[metric] = finish - start;
      const recorded = span.end.delta?.[metric];
      if (Number.isFinite(recorded) && Math.abs(recorded - span.inclusive[metric]) > 0.001) {
        issue('clock_delta_mismatch', { id: span.id, metric, recorded, endpoint_delta: span.inclusive[metric] });
      }
    }
  }
  if (valid) complete.push(span);
}
const validById = new Map(complete.map(span => [span.id, span]));
for (const span of complete) {
  if (!span.parent_id) continue;
  const parent = validById.get(span.parent_id);
  if (!parent) issue('unresolved_parent', { id: span.id, parent_id: span.parent_id });
  else span.parent = parent;
}
// Remove cyclic edges before calculating ancestry or descendants.
const parentChecked = new Set();
for (const span of complete) {
  const chain = new Set();
  let current = span;
  while (current && !parentChecked.has(current)) {
    if (chain.has(current)) {
      issue('parent_cycle', { id: current.id, chain: [...chain].map(item => item.id) });
      current.parent = null;
      break;
    }
    chain.add(current);
    current = current.parent;
  }
  for (const item of chain) parentChecked.add(item);
}
for (const span of complete) if (span.parent) {
  span.parent.children.push(span);
  if (span.start.monotonic_ms < span.parent.start.monotonic_ms - 0.05 ||
      span.finish.monotonic_ms > span.parent.finish.monotonic_ms + 0.05) {
    issue('child_outside_parent', { id: span.id, parent_id: span.parent.id,
      start_offset_ms: span.start.monotonic_ms - span.parent.start.monotonic_ms,
      finish_offset_ms: span.finish.monotonic_ms - span.parent.finish.monotonic_ms });
  }
}
let order = 0;
const roots = complete.filter(span => !span.parent);
for (const root of roots) {
  const stack = [{ span: root, ending: false }];
  while (stack.length) {
    const { span, ending } = stack.pop();
    if (ending) { span.post = order++; continue; }
    span.pre = order++;
    stack.push({ span, ending: true });
    for (let index = span.children.length - 1; index >= 0; index--) stack.push({ span: span.children[index], ending: false });
  }
}
function unionLength(intervals) {
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let length = 0, low, high;
  for (const [start, finish] of intervals) {
    if (!(finish > start)) continue;
    if (low === undefined) { low = start; high = finish; }
    else if (start <= high) high = Math.max(high, finish);
    else { length += high - low; low = start; high = finish; }
  }
  return length + (low === undefined ? 0 : high - low);
}
for (const span of complete) {
  span.direct_child_union = {};
  span.residual = {};
  span.non_ancestral_overlap_wall_ms = 0;
  for (const metric of metrics) {
    if (span.inclusive[metric] === null) { span.direct_child_union[metric] = null; span.residual[metric] = null; continue; }
    const childIntervals = span.children.filter(child => child.inclusive[metric] !== null).map(child => [
      Math.max(span.start[metric], child.start[metric]), Math.min(span.finish[metric], child.finish[metric]),
    ]);
    span.direct_child_union[metric] = unionLength(childIntervals);
    span.residual[metric] = Math.max(0, span.inclusive[metric] - span.direct_child_union[metric]);
  }
}

// A sweep reports the union of intervals containing unrelated active branches.
// A branch can represent a different Task or an incompletely linked same-Task
// phase. No durable Task ID exists in this experimental stream.
const boundaries = complete.filter(span => span.finish.monotonic_ms > span.start.monotonic_ms).flatMap(span => [
  { time: span.start.monotonic_ms, start: true, span },
  { time: span.finish.monotonic_ms, start: false, span },
]).sort((a, b) => a.time - b.time || Number(a.start) - Number(b.start));
const active = new Set();
let last, overlapUnion = 0, overlapSegments = 0, maxBranches = 0;
for (let index = 0; index < boundaries.length;) {
  const now = boundaries[index].time;
  if (last !== undefined && now > last && active.size > 1) {
    const ordered = [...active].sort((a, b) => a.pre - b.pre);
    const leaves = ordered.filter((span, position) => !ordered[position + 1] || ordered[position + 1].pre > span.post);
    maxBranches = Math.max(maxBranches, leaves.length);
    if (leaves.length > 1) {
      const duration = now - last;
      overlapUnion += duration;
      overlapSegments++;
      const first = leaves[0].pre, final = leaves.at(-1).post;
      for (const span of ordered) if (!(span.pre <= first && final <= span.post)) span.non_ancestral_overlap_wall_ms += duration;
    }
  }
  while (index < boundaries.length && boundaries[index].time === now) {
    const boundary = boundaries[index++];
    if (boundary.start) active.add(boundary.span); else active.delete(boundary.span);
  }
  last = now;
}

const grouped = new Map();
for (const span of complete) {
  const categoryName = span.name === 'c_header.phase' && typeof span.fields.phase === 'string'
    ? `c_header.${span.fields.phase}` : span.name;
  const key = `${span.producer}:${categoryName}`;
  let group = grouped.get(key);
  if (!group) {
    group = { producer: span.producer, name: categoryName, count: 0, inclusive_sum: {}, residual_sum: {}, intervals: [], non_ancestral_overlap_sum_ms: 0 };
    for (const metric of metrics) { group.inclusive_sum[metric] = 0; group.residual_sum[metric] = 0; }
    grouped.set(key, group);
  }
  group.count++;
  group.intervals.push([span.start.monotonic_ms, span.finish.monotonic_ms]);
  group.non_ancestral_overlap_sum_ms += span.non_ancestral_overlap_wall_ms;
  for (const metric of metrics) {
    group.inclusive_sum[metric] += span.inclusive[metric] ?? 0;
    group.residual_sum[metric] += span.residual[metric] ?? 0;
  }
}
const categories = [...grouped.values()].map(({ intervals, ...group }) => ({ ...group, wall_interval_union_ms: unionLength(intervals) }))
  .sort((a, b) => b.residual_sum.process_cpu_ms - a.residual_sum.process_cpu_ms);
const clockCoverage = {};
for (const metric of metrics) {
  const observed = complete.filter(span => span.inclusive[metric] !== null);
  const starts = observed.map(span => span.start[metric]), finishes = observed.map(span => span.finish[metric]);
  const low = starts.reduce((a, b) => Math.min(a, b), Infinity), high = finishes.reduce((a, b) => Math.max(a, b), -Infinity);
  const window = observed.length ? high - low : 0;
  const covered = unionLength(observed.map(span => [span.start[metric], span.finish[metric]]));
  const leafCovered = unionLength(observed.filter(span => span.children.length === 0).map(span => [span.start[metric], span.finish[metric]]));
  clockCoverage[metric] = { observed_window: window, span_interval_union: covered,
    outside_every_span: Math.max(0, window - covered), leaf_interval_union: leafCovered,
    outside_leaf_spans: Math.max(0, window - leafCovered) };
}
for (const input of inputs.filter(input => input.kind === 'compiler')) {
  if (!markers.some(marker => marker.source === input.path && marker.event === 'profile_end')) issue('missing_compiler_profile_end', { source: input.path });
}
for (const input of inputStats.filter(input => input.kind === 'server' && input.records > 0)) {
  if (!markers.some(marker => marker.source === input.path && marker.event === 'profile_summary')) issue('missing_server_profile_summary', { source: input.path });
}
for (const marker of markers) {
  if (marker.complete === false) issue('incomplete_profile_marker', { source: marker.source });
  if (marker.event === 'profile_summary' && marker.active_spans > 0) issue('server_active_spans_at_summary', { count: marker.active_spans });
}
const result = {
  schema_version: 1,
  method: {
    clock_unit: 'milliseconds', process_scope: 'Inputs must describe one process lifetime on one machine monotonic clock.',
    residual: 'Inclusive clock interval minus union of directly linked child intervals, clipped to the parent, independently in each clock coordinate.',
    cpu_limit: 'CPU residual is process/thread clock consumption outside linked child time windows. It is not isolated Task CPU or a causal attribution; suspended Tasks and worker threads can contribute.',
    overlap_limit: 'Non-ancestral overlap is possible cross-Task activity or incomplete parent linkage. Task identity is unavailable. No wall-time fraction is used to estimate CPU.',
    aggregate_limit: 'Category sums can overlap across unrelated branches; use interval unions and overlap metadata. Outside-leaf coverage is unassigned to a narrow leaf phase, not necessarily uninstrumented overall.',
    missing_clock_limit: 'Invalid or unavailable metric intervals are reported as issues and omitted from sums, never interpreted as observed zero CPU.',
  },
  inputs: inputStats, event_counts: eventCounts, markers,
  integrity: { passed: Object.keys(issueCounts).length === 0, counts: issueCounts, issues, issue_list_truncated: Object.values(issueCounts).reduce((a, b) => a + b, 0) > issues.length },
  span_count: spans.size, complete_span_count: complete.length, root_span_ids: roots.map(span => span.id),
  root_spans: roots.map(span => ({ id: span.id, name: span.name, producer: span.producer, declared_parent_id: span.parent_id,
    linked_children: span.children.length, start: span.start.monotonic_ms, finish: span.finish.monotonic_ms })),
  clock_coverage: clockCoverage,
  non_ancestral_overlap: { wall_interval_union_ms: overlapUnion, segments: overlapSegments, maximum_active_branches: maxBranches, task_identity_available: false },
  categories,
  spans: complete.map(span => ({ id: span.id, producer: span.producer, name: span.name, parent_id: span.parent_id,
    fields: span.fields, start: span.start, finish: span.finish, inclusive: span.inclusive,
    direct_child_interval_union: span.direct_child_union, residual: span.residual,
    non_ancestral_overlap_wall_ms: span.non_ancestral_overlap_wall_ms })),
};
// A full workspace can exceed V8's single-string limit. Serialize each array
// entry separately while preserving one ordinary JSON result for consumers.
const destination = output ? fs.createWriteStream(output) : process.stdout;
const completion = output ? finished(destination) : null;
if (completion) void completion.catch(() => undefined);
async function write(chunk) {
  if (!destination.write(chunk)) await once(destination, 'drain');
}
await write('{\n');
const entries = Object.entries(result);
for (let index = 0; index < entries.length; index++) {
  const [key, value] = entries[index];
  await write(`  ${JSON.stringify(key)}: `);
  if (Array.isArray(value)) {
    await write('[\n');
    for (let item = 0; item < value.length; item++) {
      await write('    ' + JSON.stringify(value[item]) + (item + 1 < value.length ? ',' : '') + '\n');
    }
    await write('  ]');
  } else await write(JSON.stringify(value, null, 2).replaceAll('\n', '\n  '));
  await write((index + 1 < entries.length ? ',' : '') + '\n');
}
await write('}\n');
if (output) { destination.end(); await completion; }
