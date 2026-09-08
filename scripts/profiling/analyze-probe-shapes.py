#!/usr/bin/env python3
"""Classify completed probe capture keys by recorded declaration shapes/origins."""
import argparse
import collections
import json
import pathlib


def same_source(left, right):
    left, right = left or {}, right or {}
    a, b = left.get('location') or {}, right.get('location') or {}
    if not all(x.get('line') is not None and x.get('column') is not None for x in (a, b)):
        return False
    if all(x.get('device') is not None and x.get('inode') is not None for x in (left, right)):
        same_file = (left['device'], left['inode']) == (right['device'], right['inode'])
    else:
        same_file = a.get('file') is not None and a.get('file') == b.get('file')
    return same_file and (a['line'], a['column']) == (b['line'], b['column'])


def analyze(analysis):
    assert not analysis['integrity_errors'], 'capture integrity failed'
    origins = {}
    with (pathlib.Path(analysis['capture']) / 'events.jsonl').open() as stream:
        for line in stream:
            if '"candidate_queued"' not in line:
                continue
            event = json.loads(line)
            if event.get('event') == 'candidate_queued':
                origins[event['candidate_id']] = same_source(event.get('previous'), event.get('current'))
    candidates = analysis['candidates']
    groups = collections.defaultdict(collections.Counter)
    for key, record in analysis['keys'].items():
        if record['purposes'] != ['foreign_redeclaration']:
            continue
        members = [candidates[i] for i in record['candidate_ids']]
        compatibility = ','.join(sorted({c.get('compatibility', 'none') for c in members}))
        tags = ','.join(sorted({(c.get('left') or {}).get('tag', 'none') for c in members}))
        rendered = record.get('rendered') or {}
        identical = rendered.get('rendered_left') == rendered.get('rendered_right')
        origin_count = sum(origins.get(i, False) for i in record['candidate_ids'])
        origin_class = ('all_recorded_same_source' if origin_count == len(members)
                        else 'some_recorded_same_source' if origin_count else 'none_recorded_same_source')
        for scope in ['all'] + record['modules']:
            row = groups[(scope, compatibility, tags, identical, origin_class)]
            row['keys'] += 1
            row['logical_requests'] += record['requests']
            row['physical_started'] += record['started_executions']
            row['runner_wall_ms'] += record['runner_wall_ms']
            row['candidates_recorded_same_source'] += origin_count
            row['candidates_other_or_unknown_source'] += len(members) - origin_count
    return {
        'capture': analysis['capture'],
        'interpretation': [
            'Shapes are recorded checker classifications, not independent proofs of C semantics.',
            'Same source means matching recorded device/inode (or path fallback), line and column.',
            'Identical source location does not establish identical macro expansion or ordered-header meaning.',
            'Each key occurs once per scope; the all scope overlaps the per-module scopes.',
            'Same rendered declaration text does not independently prove a compiler probe can be skipped.',
        ],
        'rows': [dict(scope=k[0], compatibility=k[1], left_tags=k[2],
                      identical_rendered_declarations=k[3], source_identity=k[4], **v)
                 for k, v in sorted(groups.items(), key=lambda p: (p[0][0], -p[1]['runner_wall_ms']))],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('analysis', help='Completed analyze-probes.py JSON output')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    result = analyze(json.loads(pathlib.Path(args.analysis).read_text()))
    pathlib.Path(args.out).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'rows': len(result['rows']), 'out': args.out}))
