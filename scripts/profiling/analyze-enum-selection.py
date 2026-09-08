#!/usr/bin/env python3
"""Group captured enum-carrier probes offline; never invoke a compiler."""
import argparse
import collections
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def analyze(analysis_path):
    analysis_bytes = Path(analysis_path).read_bytes()
    analysis = json.loads(analysis_bytes)
    if analysis.get('integrity_errors') or analysis.get('event_counts', {}).get('profile_end') != 1:
        raise ValueError('a complete, integrity-checked probe analysis is required')
    root = Path(analysis['capture'])
    enum_keys = {k: v for k, v in analysis['keys'].items()
                 if 'enum_carrier' in v['purposes']}
    key_shapes, shapes = {}, {}
    for key, record in enum_keys.items():
        raw = (root / record['source']['path']).read_bytes()
        if digest(raw) != key or len(raw) != record['source']['bytes']:
            raise ValueError('invalid source bytes: ' + key)
        left = record['rendered']['rendered_left']
        right = record['rendered']['rendered_right']
        pair = ('extern ' + left + ';\nextern ' + right + ';').encode()
        if raw.count(pair) != 1:
            raise ValueError('unrecognized or ambiguous source shape: ' + key)
        normalized = raw.replace(pair, ('extern ' + left +
                                       ';\n/* ENUM_CARRIER_CHOICE */').encode())
        shape = digest(normalized)
        key_shapes[key] = shape
        entry = shapes.setdefault(shape, {'shape_sha256': shape,
            'rendered_left': left, 'source_keys': [], 'runner_wall_ms': 0,
            'logical_candidate_requests': 0, 'modules': set()})
        entry['source_keys'].append(key)
        entry['runner_wall_ms'] += record['runner_wall_ms']
        entry['logical_candidate_requests'] += record['requests']
        entry['modules'].update(record['modules'])

    candidates, requests, outcomes, batches = {}, {}, {}, []
    active = None
    events_digest = hashlib.sha256()
    with (root / 'events.jsonl').open('rb') as stream:
        for raw in stream:
            events_digest.update(raw)
            if not any(token in raw for token in
                       (b'"candidate"', b'"request_start"',
                        b'"request_source"', b'"execution_result"')):
                continue
            event = json.loads(raw)
            kind = event['event']
            if kind == 'candidate' and event.get('purpose') == 'enum_carrier':
                index = event['carrier_index']
                if index == 1:
                    if active is not None:
                        raise ValueError('incomplete previous candidate batch')
                    active = []
                    batches.append(active)
                if active is None or index != len(active) + 1:
                    raise ValueError('invalid candidate order')
                if event['candidate_id'] in candidates:
                    raise ValueError('duplicate candidate')
                active.append(event)
                candidates[event['candidate_id']] = event
                if len(active) == event['eligible_carrier_count']:
                    active = None
            elif kind == 'request_start' and event.get('purpose') == 'enum_carrier':
                cid = event['caller']['candidate_id']
                if cid not in candidates or event['request_id'] in requests:
                    raise ValueError('invalid candidate request')
                requests[event['request_id']] = cid
            elif kind == 'request_source' and event['request_id'] in requests:
                candidate = candidates[requests[event['request_id']]]
                if 'source_key' in candidate:
                    raise ValueError('candidate has multiple source keys')
                candidate['source_key'] = event['key']
            elif kind == 'execution_result' and event.get('purpose') == 'enum_carrier':
                outcomes.setdefault(event['key'], []).append(event['outcome'])
    if active is not None:
        raise ValueError('incomplete final candidate batch')

    queries = {}
    for batch in batches:
        keys = [c['source_key'] for c in batch]
        batch_shapes = {key_shapes[k] for k in keys}
        if len(batch_shapes) != 1:
            raise ValueError('one candidate batch has different source contexts')
        shape = next(iter(batch_shapes))
        names = [c['carrier_name'] for c in batch]
        rendered_right = [enum_keys[k]['rendered']['rendered_right'] for k in keys]
        if len(set(names)) != len(names) or any(
                c['eligible_carrier_count'] != len(batch) for c in batch):
            raise ValueError('invalid carrier eligibility list')
        signature = json.dumps([shape, rendered_right], separators=(',', ':'))
        query = queries.setdefault(signature, {
            'shape_sha256': shape, 'rendered_left': shapes[shape]['rendered_left'],
            'ordered_eligible_carriers': names, 'rendered_eligible_declarations': rendered_right,
            'logical_selection_requests': 0, 'source_keys': set(), 'modules': set(),
            'eligibility_metadata_variants': set(), 'enumerator_names': set()})
        if query['ordered_eligible_carriers'] != names:
            raise ValueError('carrier names differ for the same rendered query')
        query['logical_selection_requests'] += 1
        query['source_keys'].update(keys)
        query['modules'].update(c['module_name'] for c in batch)
        query['enumerator_names'].update(c['enumerator_name'] for c in batch
                                         if c.get('enumerator_name'))
        query['eligibility_metadata_variants'].add(json.dumps([
            [c['carrier_name'], c['carrier_signed'], c['carrier_bits'],
             c['carrier_rank'], c['carrier_fits_lua_integer']] for c in batch]))
    represented_keys = {key for q in queries.values() for key in q['source_keys']}
    if represented_keys != set(enum_keys) or len(requests) != sum(
            r['requests'] for r in enum_keys.values()):
        raise ValueError('candidate batches do not account for the complete enum source family')
    result_queries = []
    for q in queries.values():
        q['source_keys'] = sorted(q['source_keys'])
        q['modules'] = sorted(q['modules'])
        q['enumerator_names'] = sorted(q['enumerator_names'])
        q['eligibility_metadata_variants'] = [json.loads(v) for v in
                                             sorted(q['eligibility_metadata_variants'])]
        q['existing_physical_starts'] = sum(enum_keys[k]['started_executions']
                                           for k in q['source_keys'])
        q['existing_runner_wall_ms'] = sum(enum_keys[k]['runner_wall_ms']
                                          for k in q['source_keys'])
        accepted = []
        for k in q['source_keys']:
            if outcomes.get(k) == ['success']:
                accepted.append(enum_keys[k]['rendered']['rendered_right'])
            elif outcomes.get(k) != ['compiler_rejection']:
                raise ValueError('non-deterministic or repeated execution: ' + k)
        q['accepted_rendered_carriers'] = accepted
        if len(accepted) != 1:
            raise ValueError('query does not have exactly one accepted carrier')
        result_queries.append(q)
    for s in shapes.values():
        s['modules'] = sorted(s['modules'])
    modules = collections.defaultdict(collections.Counter)
    for q in result_queries:
        if len(q['modules']) != 1:
            raise ValueError('cross-module query needs explicit attribution')
        row = modules[q['modules'][0]]
        row['selection_queries'] += 1
        row['logical_selection_requests'] += q['logical_selection_requests']
        row['physical_candidate_starts'] += q['existing_physical_starts']
        row['candidate_runner_wall_ms'] += q['existing_runner_wall_ms']
    return {
        'schema_version': 1, 'capture': analysis['capture'],
        'inputs': {'analysis_sha256': digest(analysis_bytes),
                   'events_sha256': events_digest.hexdigest()},
        'integrity_errors': [],
        'physical_candidate_keys': len(enum_keys),
        'logical_candidate_requests': len(requests),
        'logical_selection_requests': len(batches),
        'normalized_source_shapes': len(shapes),
        'complete_queries_with_ordered_eligibility': len(queries),
        'eligible_count_histogram': dict(collections.Counter(
            len(q['ordered_eligible_carriers']) for q in result_queries)),
        'existing_runner_wall_ms': sum(r['runner_wall_ms'] for r in enum_keys.values()),
        'modules': dict(modules),
        'queries': sorted(result_queries, key=lambda q:(q['modules'],q['rendered_left'])),
        'method': 'Replace only the second extern declaration in each captured pair with a placeholder; retain every other raw byte. Join candidate batches using carrier_index and eligible_carrier_count, then distinguish full questions by the ordered rendered eligible declarations.',
        'limitations': [
            'shape_sha256 identifies an offline grouping template, not a proposed compiled-source cache key.',
            'Query counts assume deterministic whole-query source generation and equivalent source-key reuse; they are not measured optimized executions.',
            'The generated selection source must include its complete eligibility list, stable carrier IDs and result protocol.',
            'Current observed durations cannot determine the cost of one unimplemented whole-selection compilation.',
            'Counts precede the separate combined-FFI module-header redesign, which can change header contexts and demand.',
        ],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('analysis')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    result = analyze(args.analysis)
    output = Path(args.out)
    if output.exists():
        raise SystemExit('output exists; choose a fresh output path')
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k:result[k] for k in (
        'physical_candidate_keys', 'logical_candidate_requests', 'logical_selection_requests',
        'normalized_source_shapes', 'complete_queries_with_ordered_eligibility',
        'eligible_count_histogram', 'integrity_errors')}, indent=2))
