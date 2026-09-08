#!/usr/bin/env python3
"""Linux non-compiler process fixtures for replay interruption and timeout cleanup."""
import json
import os
import pathlib
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
MODULE = runpy.run_path(str(ROOT / 'replay-probes.py'), run_name='lifecycle_fixture')
DRIVER = r'''
import os,pathlib,runpy,signal,sys,time
root, marker, spawning = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3] == 'spawn'
module = runpy.run_path(str(root / 'replay-probes.py'), run_name='signal_driver')
if spawning:
    real_popen = module['subprocess'].Popen
    def inject_during_popen(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        os.kill(os.getpid(), signal.SIGTERM)
        return child
    module['subprocess'].Popen = inject_during_popen
module['invoke']([sys.executable, str(root / 'fixtures/replay-process-tree.py'), str(marker)],
                 str(marker.parent), str(marker) + '.stdout', str(marker) + '.stderr', 20)
'''


def running(pid):
    try:
        fields = pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()
        return fields[0] != 'Z'
    except FileNotFoundError:
        return False


class ReplayLifecycleTest(unittest.TestCase):
    def assert_stopped(self, identity):
        deadline = time.monotonic() + 3
        while any(running(pid) for pid in identity.values()) and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(any(running(pid) for pid in identity.values()), identity)

    def signal_fixture(self, during_spawn):
        with tempfile.TemporaryDirectory(prefix='replay-signal-') as directory:
            marker = pathlib.Path(directory) / 'ready.json'
            driver = subprocess.Popen([sys.executable, '-c', DRIVER, str(ROOT), str(marker),
                                       'spawn' if during_spawn else 'wait'],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            identity = None
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and driver.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.005)
                self.assertTrue(marker.exists(), 'fixture did not become ready')
                identity = json.loads(marker.read_text())
                if not during_spawn:
                    os.kill(driver.pid, signal.SIGTERM)
                stdout, stderr = driver.communicate(timeout=5)
                self.assertEqual(driver.returncode, 128 + signal.SIGTERM, (stdout, stderr))
                self.assert_stopped(identity)
            finally:
                if identity is None and marker.exists():
                    identity = json.loads(marker.read_text())
                if identity:
                    try:
                        os.killpg(identity['pid'], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if driver.poll() is None:
                    driver.kill()
                driver.communicate(timeout=5)

    def test_sigterm_kills_started_process_group(self):
        self.signal_fixture(False)

    def test_sigterm_during_popen_waits_for_handle_then_kills_group(self):
        self.signal_fixture(True)

    def test_timeout_kills_descendants_and_restores_signal_handlers(self):
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        with tempfile.TemporaryDirectory(prefix='replay-timeout-') as directory:
            marker = pathlib.Path(directory) / 'ready.json'
            try:
                result = MODULE['invoke']([sys.executable, str(ROOT / 'fixtures/replay-process-tree.py'), str(marker)],
                                           directory, str(marker) + '.stdout', str(marker) + '.stderr', 0.3)
                self.assertTrue(result['timed_out'])
                self.assertEqual(result['status'], -signal.SIGKILL)
                self.assert_stopped(json.loads(marker.read_text()))
                self.assertEqual(before, {sig: signal.getsignal(sig) for sig in before})
            finally:
                if marker.exists():
                    try:
                        os.killpg(json.loads(marker.read_text())['pid'], signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_exited_process_group_does_not_mask_cleanup(self):
        child = types.SimpleNamespace(pid=999999999, wait=mock.Mock(return_value=0))
        with mock.patch.object(MODULE['os'], 'killpg', side_effect=ProcessLookupError):
            self.assertEqual(MODULE['kill_and_reap'](child), 0)
        child.wait.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
