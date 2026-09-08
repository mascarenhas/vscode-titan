#!/usr/bin/env python3
"""Read experimental FFI capture; never changes source, cache or trace files."""
import argparse
import collections
import hashlib
import json
import pathlib


def analyze(directory):
    directory = pathlib.Path(directory)
    counts = collections.Counter()
    requests, contexts, sources, executions, candidates = {}, {}, {}, {}, {}
    pending_renders, key_renders, spans = {}, {}, {}
    span_totals = collections.defaultdict(lambda: collections.Counter())
    started_spans, ended_spans = set(), set()
    request_starts, request_ends = collections.Counter(), collections.Counter()
    execution_starts, execution_ends = collections.Counter(), collections.Counter()
    direct_names, direct_slots = set(), set()
    demanded_types = collections.defaultdict(set)
    inventories = collections.Counter()
    inventory_modules = set()
    profile_end = None
    link_errors = []

    def candidate(fields):
        ident = fields.get('candidate_id')
        if not ident:
            return
        item = candidates.setdefault(ident, {})
        for key in ('purpose', 'module_name', 'ordinary_name', 'compatibility',
                    'previous_header', 'current_header', 'queue_index', 'decision',
                    'enum_spelling', 'enumerator_name', 'carrier_name'):
            if key in fields:
                item[key] = fields[key]
        for side in ('left', 'right'):
            if fields.get(side):
                item[side] = {k: fields[side].get(k) for k in
                              ('type_id', 'tag', 'resolved_type_id', 'resolved_tag')}

    with (directory / 'events.jsonl').open() as stream:
        for line_number, line in enumerate(stream, 1):
            event = json.loads(line)
            if event.get('producer', 'compiler') != 'compiler':
                continue
            name = event['event']
            counts[name] += 1
            if name == 'context':
                fields = event['fields']
                contexts[event['context_id']] = {
                    'module_name': fields.get('module_name'),
                    'baseline_key': fields.get('baseline_key'),
                    'headers': [item.get('rendered') for item in fields.get('includes', [])],
                }
            elif name == 'source':
                sources[event['key']] = {k: event[k] for k in ('path', 'bytes')}
            elif name == 'request_start':
                ident = event['request_id']
                request_starts[ident] += 1
                caller = event.get('caller') or {}
                candidate(caller)
                requests.setdefault(ident, {}).update({
                    'purpose': event.get('purpose'), 'context_id': event.get('context_id'),
                    'module_name': event.get('module_name'),
                    'parent_request_id': event.get('parent_request_id'),
                    'candidate_id': caller.get('candidate_id'),
                    'ordinary_name': caller.get('ordinary_name'),
                })
            elif name == 'request_rendered':
                pending_renders[event['request_id']] = {
                    k: event[k] for k in ('rendered_left', 'rendered_right',
                                         'source_type', 'target_type', 'expression') if k in event}
            elif name == 'request_source':
                ident, key = event['request_id'], event['key']
                requests.setdefault(ident, {})['key'] = key
                rendered = pending_renders.pop(ident, None)
                if rendered:
                    key_renders.setdefault(key, rendered)
            elif name == 'request_result':
                ident = event['request_id']
                request_ends[ident] += 1
                prior = requests.get(ident, {})
                if prior.get('key') and event.get('key') and prior['key'] != event['key']:
                    link_errors.append('logical result changed request source key: ' + ident)
                requests.setdefault(ident, {}).update({k: event.get(k) for k in
                    ('key', 'outcome', 'resolution', 'execution_id', 'publication', 'cache_tier')
                    if event.get(k) is not None})
            elif name == 'execution_start':
                ident = event['execution_id']
                execution_starts[ident] += 1
                executions.setdefault(ident, {}).update({k: event.get(k) for k in
                    ('request_id', 'key', 'purpose', 'context_id', 'stage')})
            elif name == 'execution_result' and event.get('execution_id'):
                ident = event['execution_id']
                execution_ends[ident] += 1
                prior = executions.get(ident, {})
                for field in ('request_id', 'key', 'context_id'):
                    if prior.get(field) and event.get(field) and prior[field] != event[field]:
                        link_errors.append(f'execution result changed {field}: {ident}')
                executions.setdefault(ident, {}).update({k: event.get(k) for k in
                    ('request_id', 'key', 'purpose', 'context_id', 'outcome', 'started',
                     'status', 'reason', 'wall_ms', 'publication', 'execution_started_unknown')})
            elif name in ('candidate_queued', 'candidate_decision', 'candidate'):
                candidate(event)
            elif name == 'foreign_name_inventory':
                inventories[(event.get('module_name'), event.get('category'),
                             event.get('decision'), event.get('macro_definition_present'))] += 1
                inventory_modules.add(event.get('module_name'))
            elif name == 'demand_root':
                module = event['module_name']
                if event.get('direct_foreign_use'):
                    direct_names.add((module, event.get('ordinary_name')))
                    direct_slots.add((module, event.get('foreign_header'), event.get('ordinary_name')))
                typ = event.get('type') or {}
                demanded_types[module].update(x for x in (typ.get('type_id'), typ.get('resolved_type_id')) if x)
            elif name == 'demand_type':
                typ = event.get('type') or {}
                demanded_types[event['module_name']].update(x for x in
                    (typ.get('type_id'), typ.get('resolved_type_id')) if x)
            elif name == 'span_begin':
                ident = event['span_id']
                started_spans.add(ident)
                fields = event.get('fields') or {}
                spans[ident] = {'name': event['name'], 'request_id': fields.get('request_id'),
                               'execution_id': fields.get('execution_id')}
            elif name == 'span_end':
                ident = event['span_id']
                ended_spans.add(ident)
                begin = spans.pop(ident, {})
                delta = event.get('delta') or {}
                for clock, value in delta.items():
                    span_totals[event['name']][clock] += value
                span_totals[event['name']]['count'] += 1
                if begin.get('name') == 'probe_request' and begin.get('request_id'):
                    requests.setdefault(begin['request_id'], {})['inclusive_wall_ms'] = delta.get('monotonic_ms', 0)
                if begin.get('name') == 'probe_runner' and begin.get('execution_id'):
                    executions.setdefault(begin['execution_id'], {})['runner_delta'] = delta
            elif name == 'profile_end':
                profile_end = event

    errors = link_errors
    if (directory / 'INCOMPLETE').exists():
        errors.append('INCOMPLETE marker exists')
    if not profile_end or not profile_end.get('complete'):
        errors.append('no successful compiler profile_end')
    for label, starts, ends in (('request', request_starts, request_ends),
                                ('execution', execution_starts, execution_ends)):
        if starts != ends:
            errors.append(f'{label} start/end counters differ')
        if any(n != 1 for n in starts.values()):
            errors.append(f'duplicate {label} starts')
    if started_spans != ended_spans:
        errors.append(f'{len(started_spans-ended_spans)} open and {len(ended_spans-started_spans)} orphan spans')
    if len(started_spans) != counts['span_begin'] or len(ended_spans) != counts['span_end']:
        errors.append('duplicate span begin/end IDs')
    for key, source in sources.items():
        raw = (directory / source['path']).read_bytes()
        if len(raw) != source['bytes'] or hashlib.sha256(raw).hexdigest() != key:
            errors.append('source bytes/hash mismatch: ' + key)
    for ident, request in requests.items():
        if request.get('key') and request['key'] not in sources:
            errors.append('request has no exact source artifact: ' + ident)
        if request.get('resolution', '').endswith('_hit') and request.get('execution_id'):
            errors.append('cache hit has execution id: ' + ident)
        if request.get('context_id') and request['context_id'] not in contexts:
            errors.append('request has unknown context: ' + ident)

    scalar_tags = {'Type.CInteger', 'Type.CFloat', 'Type.Integer', 'Type.Float', 'Type.Boolean'}
    for item in candidates.values():
        module, ordinary_name = item.get('module_name'), item.get('ordinary_name')
        headers = (item.get('previous_header'), item.get('current_header'))
        if any((module, header, ordinary_name) in direct_slots for header in headers):
            demand = 'direct_name_and_header_observed'
        elif (module, ordinary_name) in direct_names:
            demand = 'same_name_in_other_header_only'
        else:
            sides = [item.get(side) or {} for side in ('left', 'right')]
            referred = any(side.get(field) in demanded_types[module]
                           for side in sides for field in ('type_id', 'resolved_type_id'))
            scalar = all(side.get('tag') in scalar_tags for side in sides)
            demand = ('shared_scalar_type_only' if scalar else 'type_reference_observed') if referred else 'no_observed_demand'
        item['demand_evidence'] = demand

    families = collections.defaultdict(collections.Counter)
    modules = collections.defaultdict(collections.Counter)
    keys = {}
    for request in requests.values():
        purpose = request.get('purpose') or 'unknown'
        module = request.get('module_name') or 'unknown'
        for row in (families[purpose], modules[module]):
            row['requests'] += 1
            row['resolution:' + (request.get('resolution') or 'unterminated')] += 1
            row['request_inclusive_wall_ms'] += request.get('inclusive_wall_ms', 0)
        key = request.get('key')
        if key:
            row = keys.setdefault(key, {'requests': 0, 'candidate_ids': set(), 'purposes': set(),
                                       'modules': set(), 'started_executions': 0, 'runner_wall_ms': 0})
            row['requests'] += 1
            row['purposes'].add(purpose)
            row['modules'].add(module)
            if request.get('candidate_id'):
                row['candidate_ids'].add(request['candidate_id'])
    for execution in executions.values():
        request = requests.get(execution.get('request_id'), {})
        purpose = request.get('purpose') or execution.get('purpose') or 'unknown'
        module = request.get('module_name') or 'unknown'
        delta = execution.get('runner_delta') or {}
        started = execution.get('started') is True
        for row in (families[purpose], modules[module]):
            row['runner_attempts'] += 1
            row['physical_started'] += started
            row['physical_started_unknown'] += execution.get('execution_started_unknown') is True
            row['physical_outcome:' + (execution.get('outcome') or 'unknown')] += 1
            row['runner_wall_ms'] += delta.get('monotonic_ms', 0)
            row['runner_process_cpu_ms'] += delta.get('process_cpu_ms', 0)
            row['runner_children_cpu_ms'] += delta.get('child_user_ms', 0) + delta.get('child_system_ms', 0)
        key = execution.get('key')
        if key in keys:
            keys[key]['started_executions'] += started
            keys[key]['runner_wall_ms'] += delta.get('monotonic_ms', 0)
    for key, row in keys.items():
        row['candidate_demand'] = dict(collections.Counter(candidates[c]['demand_evidence']
            for c in row['candidate_ids'] if c in candidates))
        row['candidate_count'] = len(row['candidate_ids'])
        row['candidate_names'] = sorted({candidates[c].get('ordinary_name') for c in row['candidate_ids']
                                        if c in candidates and candidates[c].get('ordinary_name')})
        row['candidate_ids'] = sorted(row['candidate_ids'])
        row['purposes'] = sorted(row['purposes'])
        row['modules'] = sorted(row['modules'])
        row['source'] = sources.get(key)
        row['rendered'] = key_renders.get(key)
    for purpose, row in families.items():
        row['unique_source_keys'] = sum(purpose in value['purposes'] for value in keys.values())
    for module, row in modules.items():
        row['unique_source_keys'] = sum(module in value['modules'] for value in keys.values())

    return {
        'capture': str(directory.resolve()),
        'integrity_errors': errors,
        'event_counts': dict(counts),
        'request_count': len(requests), 'execution_attempts': len(executions),
        'physical_started': sum(e.get('started') is True for e in executions.values()),
        'physical_started_unknown': sum(e.get('execution_started_unknown') is True for e in executions.values()),
        'source_count': len(sources), 'source_bytes': sum(s['bytes'] for s in sources.values()),
        'candidate_count': len(candidates),
        'candidate_demand': dict(collections.Counter(c['demand_evidence'] for c in candidates.values())),
        'candidate_compatibility': dict(collections.Counter(c.get('compatibility', 'purpose_specific') for c in candidates.values())),
        'direct_foreign_slots': [list(slot) for slot in sorted(direct_slots, key=str)],
        'inventory_rows': [{'module_name': k[0], 'category': k[1], 'decision': k[2],
                            'macro_definition_present': k[3], 'count': count}
                           for k, count in sorted(inventories.items(), key=str)],
        'inventory_modules': sorted(inventory_modules),
        'families': {k: dict(v) for k, v in families.items()},
        'modules': {k: dict(v) for k, v in modules.items()},
        'keys': keys,
        'candidates': candidates,
        'inclusive_span_totals': {k: dict(v) for k, v in span_totals.items()},
        'instrumentation_overhead': (profile_end or {}).get('overhead'),
        'interpretation_limits': [
            'No observed demand does not prove a candidate unnecessary; aggregate layout closure is unknown.',
            'Shared scalar type IDs do not independently establish demand for each ordinary declaration name.',
            'Candidate names and raw-source keys have a many-to-many relation; a key can serve both directly used and unobserved names.',
            'Request and general span totals are inclusive and may overlap; do not sum them as exclusive work.',
            'Runner child CPU is cumulative reaped-child rusage; concurrency can prevent per-child attribution.',
            'Physical launches count the recorded compiler driver; an ambient compiler wrapper can independently cache or spawn underlying work.',
            'Foreign-name inventory occurs on conversion misses; restored queues still yield candidate decisions.',
        ],
    }


def markdown(result):
    lines = ['# Experimental FFI probe profile', '',
             f"Capture: `{result['capture']}`", '',
             f"Integrity: {'PASS' if not result['integrity_errors'] else 'FAILED: ' + '; '.join(result['integrity_errors'])}.", '',
             f"{result['request_count']:,} logical requests; {result['source_count']:,} exact source keys; "
             f"{result['physical_started']:,} confirmed compiler-driver launches; "
             f"{result['execution_attempts']:,} runner attempts; "
             f"{result['physical_started_unknown']:,} attempts with unknown launch state.", '',
             '| Purpose | Requests | Unique keys | Started | Runner wall, s |',
             '| --- | ---: | ---: | ---: | ---: |']
    for purpose, row in sorted(result['families'].items(), key=lambda x: -x[1].get('runner_wall_ms', 0)):
        lines.append(f"| {purpose} | {row['requests']:,} | {row['unique_source_keys']:,} | "
                     f"{row.get('physical_started', 0):,} | {row.get('runner_wall_ms', 0)/1000:.3f} |")
    lines += ['', '## Candidate demand evidence', '',
              '| Evidence | Candidates |', '| --- | ---: |']
    for name, count in sorted(result['candidate_demand'].items()):
        lines.append(f'| {name} | {count:,} |')
    lines += ['', f"Observed {len(result['direct_foreign_slots']):,} distinct module/header/name slots.", '',
              '## Most expensive exact source keys', '',
              '| Key | Purpose | Requests | Candidates | Started | Runner wall, s |',
              '| --- | --- | ---: | ---: | ---: | ---: |']
    for key, row in sorted(result['keys'].items(), key=lambda x: -x[1]['runner_wall_ms'])[:30]:
        lines.append(f"| `{key}` | {', '.join(row['purposes'])} | {row['requests']:,} | "
                     f"{row['candidate_count']:,} | {row['started_executions']:,} | {row['runner_wall_ms']/1000:.3f} |")
    lines += ['', '## Interpretation limits', '']
    lines.extend('- ' + item for item in result['interpretation_limits'])
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture')
    parser.add_argument('--out', required=True, help='Output path prefix for .json and .md reports')
    args = parser.parse_args()
    result = analyze(args.capture)
    pathlib.Path(args.out + '.json').write_text(json.dumps(result, indent=2) + '\n')
    pathlib.Path(args.out + '.md').write_text(markdown(result))
    print(json.dumps({key: result[key] for key in ('request_count', 'source_count', 'physical_started',
                                                  'execution_attempts', 'candidate_count', 'integrity_errors')}, indent=2))
