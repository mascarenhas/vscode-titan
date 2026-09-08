#!/usr/bin/env python3
"""Offline regression fixtures: no compiler or trace scan is performed."""
import pathlib
import runpy
import contextlib
import hashlib
import io
import json
import tempfile
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
MODULE = runpy.run_path(str(ROOT / 'replay-probes.py'), run_name='parser_fixture')
parse = MODULE['parse_gcc_report']


class TimingParserTest(unittest.TestCase):
    def fixture(self, name):
        return parse((ROOT / 'fixtures' / name).read_text())

    def test_actual_gcc16_wall_success_retains_wall_percent_and_never_invents_cpu(self):
        report = self.fixture('gcc16-wall-success.stderr')
        self.assertEqual(report['formats'], ['wall_only'])
        self.assertEqual(report['unparsed_rows'], [])
        rows = {row['name']: row for row in report['passes']}
        self.assertEqual(len(rows), 8)
        self.assertEqual(rows['phase parsing']['wall_s'], 0.10)
        self.assertEqual(rows['phase parsing']['wall_percent_reported'], 93)
        self.assertEqual(rows['preprocessing']['wall_percent_reported'], 49)
        self.assertEqual(rows['TOTAL']['wall_s'], 0.11)
        self.assertEqual(rows['TOTAL']['ggc_display'], '35M')
        self.assertTrue(all('user_s' not in row and 'system_s' not in row for row in rows.values()))
        self.assertEqual(report['driver_subprocesses'][0], {'name': 'cc1', 'user_s': 0.09, 'system_s': 0.02})

    def test_actual_rejection_diagnostics_do_not_hide_timing_report(self):
        report = self.fixture('gcc16-wall-rejection.stderr')
        self.assertEqual(report['unparsed_rows'], [])
        rows = {row['name']: row for row in report['passes']}
        self.assertEqual(rows['TOTAL']['wall_s'], 0.05)
        self.assertEqual(rows['preprocessing']['wall_percent_reported'], 57)
        self.assertEqual([row['name'] for row in report['driver_subprocesses']], ['cc1'])

    def test_legacy_three_timing_columns_do_not_confuse_ggc_with_wall(self):
        report = self.fixture('gcc-legacy-user-system-wall.stderr')
        self.assertEqual(report['formats'], ['user_system_wall'])
        self.assertEqual(report['unparsed_rows'], [])
        rows = {row['name']: row for row in report['passes']}
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows['TOTAL']['user_s'], 0.10)
        self.assertEqual(rows['TOTAL']['system_s'], 0.05)
        self.assertEqual(rows['TOTAL']['wall_s'], 0.15)
        self.assertEqual(rows['preprocessing']['wall_percent_reported'], 53)

    def test_unknown_format_and_malformed_rows_are_explicit(self):
        unknown = parse('Time variable ticks memory\n TOTAL : 12 35M\n')
        self.assertEqual(unknown['passes'], [])
        self.assertEqual(len(unknown['unparsed_rows']), 1)
        malformed = parse('Time variable wall GGC\n preprocessing : nonsense\n TOTAL : 0.11 35M\n')
        self.assertEqual(len(malformed['unparsed_rows']), 1)
        self.assertEqual(malformed['passes'][0]['name'], 'TOTAL')

    def test_cpu_diagnostics_outside_report_are_not_pass_rows(self):
        report = parse('source.c:1:2: warning: timing : 1.0 2.0 3.0\n# cc1 0.12 0.04\n')
        self.assertEqual(report['passes'], [])
        self.assertEqual(report['driver_subprocesses'][0]['user_s'], 0.12)


class RelocatedSummaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='replay-relocation-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.stderr_dir = self.root / 'relocated'
        self.stderr_dir.mkdir()
        self.key = 'a' * 64
        self.raw = (ROOT / 'fixtures/gcc16-wall-success.stderr').read_bytes()
        self.stderr = self.stderr_dir / f'{self.key}-repeat-1.stderr'
        self.stderr.write_bytes(self.raw)
        self.result = {'key': self.key, 'repeat': 1, 'source_sha256': self.key,
                       'stderr': '/unavailable/historical/repeat-1.stderr',
                       'selection_reason': 'fixture', 'wall_ms': 120,
                       'child_user_ms': 80, 'child_system_ms': 20, 'status': 0,
                       'expected_outcome': 'success', 'expected_success_matches': True,
                       'exit_status_matches': True, 'timed_out': False}
        self.results = self.root / 'results.jsonl'
        self.output = self.root / 'analysis'

    def summarize(self, records=None):
        self.results.write_text(''.join(json.dumps(row) + '\n' for row in (records or [self.result])))
        before = self.results.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            MODULE['summarize'](types.SimpleNamespace(results=str(self.results), out=str(self.output),
                                                    stderr_dir=str(self.stderr_dir)))
        self.assertEqual(self.results.read_bytes(), before)
        return json.loads(self.output.with_suffix('.json').read_text())

    def test_relocation_preserves_historical_and_actual_path_and_hash(self):
        report = self.summarize()
        self.assertEqual(report['integrity_errors'], [])
        observed = report['observations'][0]
        self.assertEqual(observed['stderr'], self.result['stderr'])
        self.assertEqual(observed['stderr_reported_path'], self.result['stderr'])
        self.assertEqual(observed['stderr_read_path'], str(self.stderr))
        self.assertEqual(observed['stderr_sha256'], hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(self.stderr.read_bytes(), self.raw)

    def test_missing_relocated_file_does_not_fall_back_to_historical_path(self):
        self.result['stderr'] = str(self.root / 'historical.stderr')
        pathlib.Path(self.result['stderr']).write_bytes(self.raw)
        self.stderr.unlink()
        with self.assertRaises(FileNotFoundError):
            self.summarize()

    def test_rejects_unsafe_identity_duplicate_and_wrong_hash(self):
        self.result['key'] = '../escape'
        with self.assertRaisesRegex(AssertionError, 'invalid source key'):
            self.summarize()
        self.result['key'] = self.key
        with self.assertRaisesRegex(AssertionError, 'duplicate'):
            self.summarize([self.result, self.result])
        self.result['stderr_sha256'] = '0' * 64
        with self.assertRaisesRegex(AssertionError, 'stderr hash mismatch'):
            self.summarize()

    def test_rejects_relocated_symlink_escape(self):
        outside = self.root / 'outside.stderr'
        outside.write_bytes(self.raw)
        self.stderr.unlink()
        self.stderr.symlink_to(outside)
        with self.assertRaisesRegex(AssertionError, 'escapes directory'):
            self.summarize()


if __name__ == '__main__':
    unittest.main()
