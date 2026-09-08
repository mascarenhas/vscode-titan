#!/usr/bin/env python3
"""Prepare exact-source GCC diagnostic replays; execution is a separate command."""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import re
import resource
import signal
import statistics
import subprocess
import time

GCC_DOC = 'https://gcc.gnu.org/onlinedocs/gcc/Developer-Options.html'
DIAGNOSTIC_FLAGS = ['-ftime-report', '-time']
REPLAY_ENV_ALLOWLIST = ('PATH', 'CC', 'CCACHE_DISABLE', 'CCACHE_DIR',
                        'CCACHE_BASEDIR', 'CCACHE_CONFIGPATH', 'CCACHE_COMPILERCHECK')


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def resolve_driver(name, cwd):
    if '/' in name:
        path = pathlib.Path(name)
        if not path.is_absolute(): path = pathlib.Path(cwd) / path
        return path.resolve() if path.is_file() and os.access(path, os.X_OK) else None
    for directory in os.environ.get('PATH', os.defpath).split(os.pathsep):
        path = pathlib.Path(directory or '.')
        if not path.is_absolute(): path = pathlib.Path(cwd) / path
        path = path / name
        if path.is_file() and os.access(path, os.X_OK): return path.resolve()
    return None


def read_capture(capture):
    requests, sources, contexts, services, executions = {}, {}, {}, {}, {}
    key_requests = collections.Counter()
    span_execution = {}
    complete = False
    with (capture / 'events.jsonl').open() as stream:
        for line in stream:
            event = json.loads(line)
            if event.get('producer', 'compiler') != 'compiler':
                continue
            name = event['event']
            if name == 'request_start':
                requests[event['request_id']] = {k: event.get(k) for k in
                    ('module_name', 'purpose', 'context_id', 'caller')}
            elif name == 'request_source':
                key_requests[event['key']] += 1
            elif name == 'source':
                sources[event['key']] = event
            elif name == 'context':
                contexts[event['context_id']] = event['fields']
            elif name == 'probe_service':
                services[event['service_id']] = event
            elif name == 'execution_start':
                executions[event['execution_id']] = dict(event)
            elif name == 'execution_result' and event.get('execution_id'):
                executions.setdefault(event['execution_id'], {}).update(event)
            elif name == 'span_begin' and event['name'] == 'probe_runner':
                span_execution[event['span_id']] = (event.get('fields') or {}).get('execution_id')
            elif name == 'span_end' and event['span_id'] in span_execution:
                execution_id = span_execution.pop(event['span_id'])
                executions.setdefault(execution_id, {})['runner_delta'] = event.get('delta') or {}
            elif name == 'profile_end':
                complete = event.get('complete') is True
    assert complete and not (capture / 'INCOMPLETE').exists(), 'capture is incomplete'
    eligible = []
    for execution_id, execution in executions.items():
        if execution.get('started') is not True or execution.get('outcome') not in ('success', 'compiler_rejection'):
            continue
        request = requests[execution['request_id']]
        key = execution['key']
        assert key in sources, 'missing exact source artifact: ' + key
        eligible.append({
            'execution_id': execution_id, 'request_id': execution['request_id'],
            'key': key, 'execution': execution, 'request': request,
            'source': sources[key], 'context': contexts[request['context_id']],
            'service': services[contexts[request['context_id']]['service_id']],
            'request_count_for_key': key_requests[key],
            'observed_runner_wall_ms': (execution.get('runner_delta') or {}).get('monotonic_ms', 0),
        })
    return eligible


def choose(rows, module, limit):
    chosen, keys, unavailable = [], set(), []
    def pick(label, condition, score=None):
        pool = [row for row in rows if row['key'] not in keys and condition(row)]
        if not pool:
            unavailable.append(label)
            return
        if score is None:
            score = lambda row: row['observed_runner_wall_ms']
        pool.sort(key=lambda row: (row['request'].get('module_name') == module, score(row)), reverse=True)
        row = dict(pool[0]); row['selection_reason'] = label
        chosen.append(row); keys.add(row['key'])
    def purpose(row): return row['request'].get('purpose')
    def caller(row): return row['request'].get('caller') or {}
    def accepted(row): return row['execution']['outcome'] == 'success'
    def ordinary(row): return purpose(row) == 'foreign_redeclaration'
    def tag(row): return (caller(row).get('left') or {}).get('tag')
    pick('ordered_header_baseline', lambda row: purpose(row) == 'header_baseline' and accepted(row))
    pick('most_reused_accepted_exact_scalar', lambda row: ordinary(row) and accepted(row)
         and caller(row).get('compatibility') == 'exact' and tag(row) in ('Type.CInteger', 'Type.CFloat'),
         lambda row: row['request_count_for_key'])
    pick('accepted_exact_function', lambda row: ordinary(row) and accepted(row)
         and caller(row).get('compatibility') == 'exact' and tag(row) == 'Type.CFunction')
    pick('accepted_exact_typedef', lambda row: ordinary(row) and accepted(row)
         and caller(row).get('compatibility') == 'exact' and tag(row) == 'Type.CTypedef')
    pick('accepted_conditional_declaration', lambda row: ordinary(row) and accepted(row)
         and caller(row).get('compatibility') == 'conditional')
    pick('expected_enumerator_carrier_rejection', lambda row: purpose(row) == 'enum_carrier'
         and not accepted(row) and caller(row).get('enumerator_name') is not None)
    pick('expected_named_enum_carrier_rejection', lambda row: purpose(row) == 'enum_carrier'
         and not accepted(row) and caller(row).get('enumerator_name') is None)
    pick('accepted_enum_carrier', lambda row: purpose(row) == 'enum_carrier' and accepted(row))
    pick('enumerator_fit', lambda row: purpose(row) == 'enumerator_fit')
    pick('fam_extent', lambda row: purpose(row) == 'fam_extent')
    pick('c_operator', lambda row: purpose(row) == 'c_operator' and accepted(row))
    while len(chosen) < limit:
        before = len(chosen)
        pick('remaining_high_cost_key', lambda row: True)
        if len(chosen) == before:
            break
    return chosen[:limit], unavailable


def file_observation(path):
    path = pathlib.Path(path)
    stat = path.stat()
    return {'path': str(path), 'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns,
            'sha256': digest(path)}


def prepare(args):
    capture, output = pathlib.Path(args.capture).resolve(), pathlib.Path(args.out).resolve()
    assert 1 <= args.limit <= 12, 'representative limit must be between 1 and 12'
    assert not output.exists(), 'choose a fresh output directory'
    output.mkdir(parents=True)
    rows, unavailable = choose(read_capture(capture), args.module, args.limit)
    prepared, blocked = [], []
    for index, row in enumerate(rows, 1):
        key = row['key']
        try:
            original_argv = row['execution']['argv']
            compiler_argv = row['service']['compiler_argv']
            assert len(compiler_argv) == 1, 'compiler wrapper argv requires explicit review'
            compiler = resolve_driver(compiler_argv[0], row['context'].get('cwd') or '.')
            assert compiler, 'recorded compiler is not currently available'
            assert re.match(r'^(?:.+-)?(?:gcc|cc)(?:-[0-9.]+)?$', pathlib.Path(compiler_argv[0]).name), \
                'GCC-compatible driver identity needs review'
            assert not any(arg.startswith('@') for arg in original_argv), 'response file is not captured'
            assert not any(arg.startswith('-fdiagnostics-format=sarif') for arg in original_argv), \
                'SARIF timing output needs separate parsing'
            source_artifact = capture / row['source']['path']
            raw = source_artifact.read_bytes()
            assert hashlib.sha256(raw).hexdigest() == key, 'raw source artifact does not match key'
            old_source = row['execution']['source_path']
            assert original_argv.count(old_source) == 1, 'source argv position is ambiguous'
            assert '-c' in original_argv or '-fsyntax-only' in original_argv, 'recorded command is not compile-only'
            work = output / f'{index:02d}-{key}'
            work.mkdir()
            source = work / pathlib.Path(old_source).name
            source.write_bytes(raw)
            argv = [str(source) if arg == old_source else arg for arg in original_argv]
            remapped = [{'from': old_source, 'to': str(source), 'role': 'source'}]
            if '-o' in argv:
                at = argv.index('-o') + 1
                old_object = argv[at]
                argv[at] = str(work / pathlib.Path(old_object).name)
                remapped.append({'from': old_object, 'to': argv[at], 'role': 'object'})
            observed, wrapper_mappings = {}, []
            for include in row['context'].get('includes', []):
                if include.get('wrapper_path'):
                    name = include['wrapper_name']
                    assert pathlib.PurePosixPath(name).name == name, 'wrapper name is not a basename'
                    wrapper_artifact = capture / include['wrapper_path']
                    wrapper_raw = wrapper_artifact.read_bytes()
                    wrapper = work / name
                    wrapper.write_bytes(wrapper_raw)
                    wrapper_mappings.append({'name': name, 'artifact': str(wrapper_artifact),
                                             'prepared': str(wrapper), 'sha256': digest(wrapper)})
                    # Private probe wrappers are exactly one quoted include.
                    target = re.fullmatch(rb'#include "([^"\n]+)"\n', wrapper_raw)
                    assert target, 'wrapper contents require manual dependency reconstruction'
                    target_path = pathlib.Path(os.fsdecode(target.group(1)))
                    assert target_path.is_absolute(), 'wrapper backing include is not absolute'
                    assert target_path.is_file(), 'temporary wrapper backing header no longer exists: ' + str(target_path)
                    observed[str(target_path)] = file_observation(target_path)
                elif include.get('resolved'):
                    path = pathlib.Path(include['resolved'])
                    assert path.is_file(), 'recorded direct include is no longer available: ' + str(path)
                    observed[str(path)] = file_observation(path)
            # Relative/compiler-global include rules retain the captured cwd.
            cwd = row['context'].get('cwd')
            assert cwd and pathlib.Path(cwd).is_dir(), 'recorded cwd is unavailable'
            argv += DIAGNOSTIC_FLAGS
            prepared.append({
                'index': index, 'key': key, 'selection_reason': row['selection_reason'],
                'module_name': row['request'].get('module_name'),
                'purpose': row['request'].get('purpose'), 'caller': row['request'].get('caller'),
                'request_id': row['request_id'], 'execution_id': row['execution_id'],
                'context_id': row['request']['context_id'], 'context': row['context'],
                'observed_outcome': row['execution']['outcome'],
                'observed_exit_status': row['execution'].get('status'),
                'observed_runner_wall_ms': row['observed_runner_wall_ms'],
                'request_count_for_key': row['request_count_for_key'],
                'original_argv': original_argv, 'replay_argv': argv,
                'compiler_argv': compiler_argv, 'compiler_executable': file_observation(pathlib.Path(compiler).resolve()),
                'source_artifact': str(source_artifact), 'prepared_source': str(source),
                'path_remappings': remapped, 'wrappers': wrapper_mappings,
                'direct_external_inputs': list(observed.values()), 'cwd': cwd, 'work': str(work),
            })
        except (AssertionError, OSError) as error:
            blocked.append({'key': key, 'selection_reason': row['selection_reason'], 'reason': str(error)})
    plan = {'schema_version': 1, 'capture': str(capture), 'output': str(output),
            'target_module_preference': args.module, 'diagnostic_flags_added': DIAGNOSTIC_FLAGS,
            'gcc_documentation': GCC_DOC, 'entries': prepared, 'blocked': blocked,
            'unavailable_categories': unavailable,
            'limitations': [
                'Raw C and captured wrapper bytes are exact; temporary source/object argv paths are relocated.',
                'Ambient environment and transitive external header bytes were not snapshotted by the original capture.',
                'Direct headers and compiler executable are fingerprinted at preparation and checked again before execution.',
                'A wrapper whose absolute temporary backing header was deleted cannot be reconstructed from wrapper text alone.',
                'Timing reports perturb the replay, have coarse printed precision, and are not replacement baseline timings.',
                'GCC phase/detail rows can overlap: retain preprocessing and parsing separately, without summing parent and child rows.',
            ]}
    (output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(json.dumps({'prepared': len(prepared), 'blocked': blocked,
                      'unavailable_categories': unavailable, 'plan': str(output / 'plan.json'),
                      'compiler_invocations': 0}, indent=2))


def parse_gcc_report(text):
    number = r'([0-9]+(?:\.[0-9]+)?)'
    percent = r'(?:\s*\(\s*([0-9]+)%\))?'
    cell = number + percent
    memory = r'\s+([0-9]+(?:\.[0-9]+)?[kMGT]?)' + percent + r'\s*$'
    wall_row = re.compile(r'^\s*' + cell + memory)
    legacy_row = re.compile(r'^\s*' + cell + r'\s+' + cell + r'\s+' + cell + memory)
    subprocess_row = re.compile(r'^#\s+(.+?)\s+' + number + r'\s+' + number + r'\s*$', re.MULTILINE)
    passes, formats, unparsed_rows = [], [], []
    current_format = None
    for line in text.splitlines():
        if line.lstrip().startswith('Time variable'):
            columns = line.strip().split()[2:]
            if columns == ['wall', 'GGC']:
                current_format = 'wall_only'
            elif columns in (['usr', 'sys', 'wall', 'GGC'], ['user', 'system', 'wall', 'GGC']):
                current_format = 'user_system_wall'
            else:
                current_format = None
                unparsed_rows.append(line)
            if current_format and current_format not in formats:
                formats.append(current_format)
            continue
        if not current_format or ':' not in line:
            continue
        name, values = line.split(':', 1)
        name = name.strip()
        match = (wall_row if current_format == 'wall_only' else legacy_row).fullmatch(values)
        if not match:
            unparsed_rows.append(line)
            continue
        fields = match.groups()
        row = {'name': name, 'format': current_format}
        clocks = ['wall'] if current_format == 'wall_only' else ['user', 'system', 'wall']
        for index, clock in enumerate(clocks):
            row[clock + '_s'] = float(fields[index * 2])
            if fields[index * 2 + 1] is not None:
                row[clock + '_percent_reported'] = int(fields[index * 2 + 1])
        row['ggc_display'] = fields[len(clocks) * 2]
        passes.append(row)
        if name == 'TOTAL':
            current_format = None
    return {
        'formats': formats, 'passes': passes, 'unparsed_rows': unparsed_rows,
        'driver_subprocesses': [{'name': name, 'user_s': float(user), 'system_s': float(system)}
                               for name, user, system in subprocess_row.findall(text)],
    }


def summarize(args):
    """Reparse immutable saved stderr; this operation never invokes a compiler."""
    results_path = pathlib.Path(args.results).resolve()
    output = pathlib.Path(args.out).resolve()
    json_path, md_path = pathlib.Path(str(output) + '.json'), pathlib.Path(str(output) + '.md')
    assert not json_path.exists() and not md_path.exists(), 'summary output must be new'
    original_digest = digest(results_path)
    results = [json.loads(line) for line in results_path.read_text().splitlines() if line.strip()]
    stderr_dir_arg = getattr(args, 'stderr_dir', None)
    stderr_dir = pathlib.Path(stderr_dir_arg).resolve(strict=True) if stderr_dir_arg else None
    assert stderr_dir is None or stderr_dir.is_dir(), 'stderr relocation must name a directory'
    observations, errors = [], []
    grouped = collections.defaultdict(list)
    identities = set()
    for result in results:
        key, repeat = result['key'], result['repeat']
        assert isinstance(key, str) and re.fullmatch(r'[0-9a-f]{64}', key), 'invalid source key'
        assert type(repeat) is int and 1 <= repeat <= 5, 'invalid repeat number'
        assert (key, repeat) not in identities, 'duplicate source key/repeat'
        identities.add((key, repeat))
        assert result.get('source_sha256', key) == key, 'recorded source hash differs from key'
        assert isinstance(result['stderr'], str), 'invalid reported stderr path'
        stderr_path = ((stderr_dir / f'{key}-repeat-{repeat}.stderr') if stderr_dir
                       else pathlib.Path(result['stderr'])).resolve(strict=True)
        assert stderr_path.is_file(), 'stderr must be a regular file'
        assert stderr_dir is None or stderr_path.parent == stderr_dir, 'relocated stderr escapes directory'
        stderr = stderr_path.read_bytes()
        stderr_digest = hashlib.sha256(stderr).hexdigest()
        assert result.get('stderr_sha256', stderr_digest) == stderr_digest, 'recorded stderr hash mismatch'
        report = parse_gcc_report(stderr.decode(errors='replace'))
        identity = f"{result['key']}:repeat-{result['repeat']}"
        if report['unparsed_rows']:
            errors.append(identity + ': unparsed timing rows')
        totals = [row for row in report['passes'] if row['name'] == 'TOTAL']
        if len(totals) != 1:
            errors.append(identity + ': requires one compiler TOTAL row')
        metrics = {'external_wall_s': result['wall_ms'] / 1000,
                   'child_cpu_s': (result['child_user_ms'] + result['child_system_ms']) / 1000}
        for name, prefix in [('TOTAL', 'gcc_total'), ('phase parsing', 'parsing'),
                             ('preprocessing', 'preprocessing')]:
            matching = [row for row in report['passes'] if row['name'] == name]
            if len(matching) == 1:
                row = matching[0]
                metrics[prefix + '_wall_s'] = row['wall_s']
                if row.get('wall_percent_reported') is not None:
                    metrics[prefix + '_percent_reported'] = row['wall_percent_reported']
        observation = {key: value for key, value in result.items() if key != 'gcc_report'}
        observation.update({'stderr_reported_path': result['stderr'],
                            'stderr_read_path': str(stderr_path), 'stderr_sha256': stderr_digest,
                            'reparsed_gcc_report': report, 'metrics': metrics})
        observations.append(observation)
        grouped[(result['selection_reason'], result['key'])].append(observation)
    assert digest(results_path) == original_digest, 'results changed while summarizing'

    def summarize_metrics(items):
        collected = collections.defaultdict(list)
        for item in items:
            for name, value in item['metrics'].items():
                collected[name].append(value)
        return {name: {'samples': len(values), 'min': min(values),
                       'median': statistics.median(values), 'max': max(values)}
                for name, values in collected.items()}

    summary = {
        'schema_version': 1, 'results': str(results_path), 'results_sha256': original_digest,
        'stderr_dir_override': str(stderr_dir) if stderr_dir else None,
        'replays': len(results), 'source_keys': len({r['key'] for r in results}),
        'expected_success_matches': sum(r['expected_success_matches'] for r in results),
        'exit_status_matches': sum(r['exit_status_matches'] for r in results),
        'timeouts': sum(r['timed_out'] for r in results),
        'formats': dict(collections.Counter(fmt for row in observations
                                           for fmt in row['reparsed_gcc_report']['formats'])),
        'integrity_errors': errors, 'aggregate_metrics': summarize_metrics(observations),
        'groups': [{'selection_reason': name, 'key': key, 'replays': len(items),
                    'expected_outcome': items[0]['expected_outcome'],
                    'metrics': summarize_metrics(items)} for (name, key), items in grouped.items()],
        'observations': observations,
        'interpretation_limits': [
            'Diagnostic replays disable ccache; the standalone SSL pilot used ambient ccache.',
            'GCC16 wall-only pass reports provide no per-pass CPU time; driver -time CPU rows are separate.',
            'Parsing contains preprocessing work; these reported shares must not be added.',
            'Reported percentages use finer internal precision than the two-decimal printed seconds.',
            'Phase/detail rows overlap; median shares across these selected samples are not a workload-wide estimate.',
            'External elapsed time includes driver/OS overhead outside the compiler TOTAL and coarse printed timers.',
            'Results and stderr were only read; these new artifacts do not replace the original saved parser output.',
        ],
    }
    json_path.write_text(json.dumps(summary, indent=2) + '\n')
    lines = ['# GCC diagnostic replay analysis', '',
             f"Reparsed {len(results)} saved runs over {summary['source_keys']} exact-source keys; "
             f"{summary['exit_status_matches']}/{len(results)} exit statuses and "
             f"{summary['expected_success_matches']}/{len(results)} expected success/rejection outcomes match; "
             f"{summary['timeouts']} timeouts.", '',
             f"Parsing integrity: {'PASS' if not errors else 'FAILED: ' + '; '.join(errors)}. "
             f"Report formats: {summary['formats']}.", '',
             'Values below are medians of the saved repeats. Parsing and preprocessing percentages are GCC-reported shares of compiler wall time; preprocessing is included in parsing.', '',
             '| Representative source | Runs | External wall, s | GCC TOTAL, s | Parsing, % | Preprocessing, % |',
             '| --- | ---: | ---: | ---: | ---: | ---: |']
    for group in summary['groups']:
        metrics = group['metrics']
        def formatted(name, digits):
            item = metrics.get(name)
            return f"{item['median']:.{digits}f}" if item else 'unavailable'
        lines.append(f"| {group['selection_reason']} | {group['replays']} | "
                     f"{formatted('external_wall_s', 3)} | {formatted('gcc_total_wall_s', 2)} | "
                     f"{formatted('parsing_percent_reported', 0)} | {formatted('preprocessing_percent_reported', 0)} |")
    lines += ['', '## Interpretation limits', '']
    lines.extend('- ' + limit for limit in summary['interpretation_limits'])
    lines += ['', 'The full JSON preserves every parsed pass, driver subprocess CPU row, raw stderr hash, original result status and per-key source identity.', '']
    md_path.write_text('\n'.join(lines))
    print(json.dumps({key: summary[key] for key in ('replays', 'source_keys', 'formats',
                                                  'exit_status_matches', 'integrity_errors')}, indent=2))


class ReplayInterrupted(SystemExit):
    def __init__(self, signum):
        self.signum = signum
        super().__init__(128 + signum)


def kill_and_reap(child):
    """The session leader may exit before cleanup; surviving descendants still share its group."""
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return child.wait()


def invoke(argv, cwd, stdout, stderr, timeout):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic_ns()
    state = {'child': None, 'spawning': False, 'cleaning': False, 'signal': None}
    previous_handlers = {}

    def interrupted(signum, frame):
        state['signal'] = state['signal'] or signum
        # Popen can have started the child before returning its handle. Defer
        # raising until assignment so cleanup owns that process. Signals remain
        # unblocked in the child, and repeated signals cannot interrupt cleanup.
        if not state['spawning'] and not state['cleaning']:
            raise ReplayInterrupted(state['signal'])

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, interrupted)
        with open(stdout, 'wb') as out, open(stderr, 'wb') as err:
            state['spawning'] = True
            state['child'] = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=err,
                                              start_new_session=True)
            state['spawning'] = False
            if state['signal']:
                raise ReplayInterrupted(state['signal'])
            timed_out = False
            try:
                status = state['child'].wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                state['cleaning'] = True
                status = kill_and_reap(state['child'])
                state['child'] = None
            if state['signal']:
                raise ReplayInterrupted(state['signal'])
    except BaseException:
        state['cleaning'] = True
        if state['child'] is not None:
            kill_and_reap(state['child'])
            state['child'] = None
        raise
    finally:
        state['cleaning'] = True
        if state['signal'] and state['child'] is not None:
            kill_and_reap(state['child'])
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    if state['signal']:
        raise ReplayInterrupted(state['signal'])
    ended = time.monotonic_ns()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {'status': status, 'timed_out': timed_out, 'wall_ms': (ended-started)/1e6,
            'child_user_ms': (after.ru_utime-before.ru_utime)*1000,
            'child_system_ms': (after.ru_stime-before.ru_stime)*1000}


def run(args):
    assert args.execute, 'execution is opt-in; review plan.json then pass --execute'
    assert 1 <= args.repeats <= 5, 'repeats must be between 1 and 5'
    plan_path = pathlib.Path(args.plan).resolve()
    plan = json.loads(plan_path.read_text())
    output = plan_path.parent
    assert not (output / 'results.jsonl').exists(), 'this replay plan already has results'
    assert plan['entries'], 'no replayable entries'
    ccache_drivers = sorted({entry['compiler_executable']['path'] for entry in plan['entries']
                            if pathlib.Path(entry['compiler_executable']['path']).name == 'ccache'})
    environment = {
        'allowlist': {name: os.environ.get(name) for name in REPLAY_ENV_ALLOWLIST},
        'ccache_drivers': ccache_drivers,
        'ccache_bypass_required': bool(ccache_drivers),
        'interpretation': 'These are replay-time values. The capture did not snapshot its full ambient environment.',
    }
    (output / 'replay-environment.json').write_text(json.dumps(environment, indent=2) + '\n')
    assert not ccache_drivers or os.environ.get('CCACHE_DISABLE') == '1', \
        'ccache driver detected: diagnostic replay requires explicit CCACHE_DISABLE=1'
    for entry in plan['entries']:
        assert str(resolve_driver(entry['compiler_argv'][0], entry['cwd'])) == entry['compiler_executable']['path'], \
            'compiler argv resolves differently from preparation'
        assert digest(entry['prepared_source']) == entry['key'], 'prepared C source changed'
        for wrapper in entry['wrappers']:
            assert digest(wrapper['prepared']) == wrapper['sha256'], 'prepared wrapper changed'
        for observed in entry['direct_external_inputs'] + [entry['compiler_executable']]:
            assert digest(observed['path']) == observed['sha256'], 'external input changed: ' + observed['path']
    # Version queries happen only in the explicitly executed diagnostic replay.
    compilers = {}
    for entry in plan['entries']:
        compiler = entry['compiler_executable']['path']
        if compiler not in compilers:
            stem = output / f'compiler-version-{len(compilers) + 1}'
            stdout_path, stderr_path = pathlib.Path(str(stem) + '.stdout'), pathlib.Path(str(stem) + '.stderr')
            version = invoke(entry['compiler_argv'] + ['--version'], entry['cwd'],
                             stdout_path, stderr_path, 10)
            version_stdout = stdout_path.read_text(errors='replace')
            version_stderr = stderr_path.read_text(errors='replace')
            assert version['status'] == 0 and not version['timed_out'], 'cannot identify recorded compiler'
            assert re.search(r'gcc|Free Software Foundation', version_stdout, re.I), 'recorded driver is not GCC'
            compilers[compiler] = {'stdout': version_stdout, 'stderr': version_stderr}
    (output / 'compiler-versions.json').write_text(json.dumps(compilers, indent=2) + '\n')
    with (output / 'results.jsonl').open('w') as results:
        for repeat in range(1, args.repeats + 1):
            for entry in plan['entries']:
                print(f"replay {repeat}/{args.repeats} {entry['selection_reason']} {entry['key']}", flush=True)
                stem = pathlib.Path(entry['work']) / f'repeat-{repeat}'
                result = invoke(entry['replay_argv'], entry['cwd'], str(stem) + '.stdout',
                                str(stem) + '.stderr', args.timeout)
                expected_success = entry['observed_outcome'] == 'success'
                result.update({'key': entry['key'], 'repeat': repeat,
                               'selection_reason': entry['selection_reason'],
                               'source_sha256': digest(entry['prepared_source']),
                               'expected_outcome': entry['observed_outcome'],
                               'expected_success_matches': not result['timed_out'] and result['status'] >= 0
                                   and (result['status'] == 0) == expected_success,
                               'exit_status_matches': result['status'] == entry['observed_exit_status'],
                               'stdout': str(stem) + '.stdout', 'stderr': str(stem) + '.stderr'})
                result['gcc_report'] = parse_gcc_report(pathlib.Path(result['stderr']).read_text(errors='replace'))
                results.write(json.dumps(result) + '\n'); results.flush()
    print('diagnostic replay complete: ' + str(output / 'results.jsonl'), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare_parser = sub.add_parser('prepare', help='Write a reviewable plan; never runs a compiler')
    prepare_parser.add_argument('capture')
    prepare_parser.add_argument('--out', required=True)
    prepare_parser.add_argument('--module', default='titan.ssl')
    prepare_parser.add_argument('--limit', type=int, default=10)
    run_parser = sub.add_parser('run', help='Execute an already prepared diagnostic replay')
    run_parser.add_argument('plan')
    run_parser.add_argument('--execute', action='store_true')
    run_parser.add_argument('--repeats', type=int, default=3)
    run_parser.add_argument('--timeout', type=float, default=60)
    summary_parser = sub.add_parser('summarize', help='Reparse saved result stderr without any compiler execution')
    summary_parser.add_argument('results', help='Immutable saved results.jsonl')
    summary_parser.add_argument('--out', required=True, help='Fresh output path prefix for .json/.md')
    summary_parser.add_argument('--stderr-dir', help='Explicit relocated <key>-repeat-<N>.stderr directory')
    arguments = parser.parse_args()
    {'prepare': prepare, 'run': run, 'summarize': summarize}[arguments.command](arguments)
