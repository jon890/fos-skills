"""FIFO, admission and command lifecycle regression tests."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/heavy-slot.py'
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location('heavy_slot', SCRIPT)
heavy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(heavy)


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.queue = heavy.Queue(self.tmp.name, 3)

    def rows(self, *rows):
        for pid, ticket, held, exclusive in rows:
            (Path(self.tmp.name) / f'{pid}.json').write_text(json.dumps(dict(
                pid=pid, ticket=ticket, held=held, exclusive=exclusive, slots=3)))

    def claim(self, pid):
        with patch.object(self.queue, 'entry', Path(self.tmp.name) / f'{pid}.json'), \
                patch.object(heavy.os, 'getpid', return_value=pid), patch.object(heavy, 'alive', return_value=True):
            return self.queue.claim()

    def test_fifo_uses_time_then_pid(self):
        self.rows((100, 5, False, False), (20, 1, False, False), (30, 2, False, False), (40, 3, False, False))
        self.assertFalse(self.claim(100))
        self.assertTrue(self.claim(20))

    def test_holder_does_not_count_as_waiter(self):
        self.rows((10, 1, True, False), (100, 2, False, False))
        self.assertTrue(self.claim(100))

    def test_exclusive_ahead_blocks_normal(self):
        self.rows((10, 1, False, True), (100, 2, False, False))
        self.assertFalse(self.claim(100))
        self.assertTrue(self.claim(10))
        self.assertFalse(self.claim(100))

    def test_exclusive_requires_every_slot(self):
        self.rows((10, 1, True, False), (100, 2, False, True))
        self.assertFalse(self.claim(100))
        (Path(self.tmp.name) / '10.json').unlink()
        self.assertTrue(self.claim(100))

    def test_dead_pid_is_reclaimed(self):
        self.rows((10, 1, True, True))
        with patch.object(heavy, 'alive', return_value=False):
            self.queue.register(False)
        self.assertTrue(self.queue.claim())
        self.queue.cleanup()
        self.assertEqual([], list(Path(self.tmp.name).glob('*.json')))

    def test_dead_partial_registration_is_reclaimed(self):
        entry = Path(self.tmp.name) / '10.json'
        entry.write_text('{')
        with patch.object(heavy, 'alive', return_value=False):
            self.queue.register(False)
        self.assertFalse(entry.exists())
        self.assertTrue(self.queue.claim())
        self.queue.cleanup()

    def test_same_ticket_uses_smaller_pid(self):
        self.rows((100, 1, False, True), (200, 1, False, False))
        self.assertFalse(self.claim(200))
        self.assertTrue(self.claim(100))

    def test_missing_self_fails_closed(self):
        with self.assertRaises(StopIteration):
            self.queue.claim()

    def test_payload_quotes_do_not_hide_waiters(self):
        # Registration never parses a payload as shell syntax.
        self.rows((10, 1, False, True), (100, 2, False, False))
        self.assertFalse(self.claim(100))

    def test_classification(self):
        for cmd, expected in [
            (['pnpm', 'type-check'], 'light'),
            (['bash', '-c', 'cd /x && pnpm exec tsc -p tsconfig.json && pnpm exec oxlint src'], 'light'),
            (['pnpm', 'test', 'tests/unit/a.test.cjs'], 'light'),
            (['pnpm', 'test'], 'normal'), (['pnpm', 'build'], 'normal'),
            (['bash', 'scripts/local-ci.sh'], 'exclusive'), (['pnpm', 'verify'], 'exclusive'),
            (['pnpm', 'exec', 'vitest', 'run', 'tests/play-scenario-region.test.cjs'], 'normal'),
            (['node', 'tools/baseline-compare.ts'], 'normal'),
            (['node', 'tools/lab-enter-field.ts'], 'exclusive'),
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(expected, heavy.classify(cmd))

    def test_gate_failure_and_command_status_release_slot(self):
        gate = Path(self.tmp.name) / 'gate.sh'
        env = dict(os.environ, HEAVY_SLOT_DIR=self.tmp.name, MEM_GATE=str(gate))
        gate.write_text('exit 9\n')
        cmd = [sys.executable, str(SCRIPT), '--exclusive', '--', sys.executable, '-c', 'raise SystemExit(7)']
        self.assertEqual(9, subprocess.run(cmd, env=env).returncode)
        gate.write_text('exit 0\n')
        self.assertEqual(7, subprocess.run(cmd, env=env).returncode)
        self.assertEqual([], list(Path(self.tmp.name).glob('*.json')))

    def test_nested_call_skips_gate(self):
        env = dict(os.environ, HEAVY_SLOT_HELD='parent', MEM_GATE='/missing')
        self.assertEqual(7, subprocess.run([sys.executable, str(SCRIPT), '--', sys.executable, '-c', 'raise SystemExit(7)'], env=env).returncode)

    def test_signal_stops_child_before_releasing_slot(self):
        gate = Path(self.tmp.name) / 'gate.sh'
        gate.write_text('exit 0\n')
        marker = Path(self.tmp.name) / 'child'
        env = dict(os.environ, HEAVY_SLOT_DIR=self.tmp.name, MEM_GATE=str(gate))
        proc = subprocess.Popen([sys.executable, str(SCRIPT), '--exclusive', '--', sys.executable, '-c',
                                 f'from pathlib import Path; import os,time; Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(60)'], env=env)
        try:
            for _ in range(100):
                if marker.exists():
                    break
                time.sleep(.02)
            self.assertTrue(marker.exists())
            proc.terminate()
            self.assertEqual(143, proc.wait(timeout=5))
            self.assertFalse(heavy.alive(int(marker.read_text())))
            self.assertEqual([], list(Path(self.tmp.name).glob('*.json')))
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


class DefaultPathTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / 'repo'
        self.child = self.root / 'child'
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
                        GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@x',
                        GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@x')
        for key in ('HEAVY_SLOT_DIR', 'HEAVY_SLOT_HELD', 'ORCH_DIR'):
            self.env.pop(key, None)
        gate = self.root / 'gate.sh'
        gate.write_text('exit 0\n')
        self.env['MEM_GATE'] = str(gate)
        self.git('init', '-q', '-b', 'main', self.repo)
        self.git('-C', self.repo, 'commit', '-q', '--allow-empty', '-m', 'init')
        self.git('-C', self.repo, 'worktree', 'add', '-q', '-b', 'child', self.child)

    def git(self, *args):
        return subprocess.run(['git', *map(str, args)], env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def run_slot(self, **extra):
        return subprocess.run([sys.executable, str(SCRIPT), '--exclusive', '--', sys.executable, '-c', 'pass'],
                              env=dict(self.env, **extra), cwd=self.child, text=True, capture_output=True)

    def test_worktrees_share_main_checkout_queue_and_ignore_it(self):
        result = self.run_slot()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue((self.repo / '.orch/state/heavy-slot/queue.lock').exists())
        self.assertFalse((self.child / '.orch').exists())
        self.assertEqual('', self.git('-C', self.repo, 'status', '--porcelain'))
        self.assertEqual('', self.git('-C', self.child, 'status', '--porcelain'))

    def test_orch_dir_changes_the_default_queue_root(self):
        result = self.run_slot(ORCH_DIR='custom-orch')
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue((self.repo / 'custom-orch/state/heavy-slot/queue.lock').exists())
        self.assertEqual('', self.git('-C', self.repo, 'status', '--porcelain'))

    def test_explicit_slot_dir_overrides_orch_dir(self):
        shared = self.root / 'shared'
        result = self.run_slot(ORCH_DIR='unused', HEAVY_SLOT_DIR=str(shared))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue((shared / 'queue.lock').exists())
        self.assertFalse((self.repo / 'unused').exists())

    def test_default_refuses_unmigrated_state_but_explicit_queue_is_allowed(self):
        legacy = self.repo / '.omc/orch'
        legacy.mkdir(parents=True)
        (legacy / 'old.json').write_text('{}')
        result = self.run_slot()
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn('옮기기 전', result.stderr)
        self.assertFalse((self.repo / '.orch').exists())
        result = self.run_slot(HEAVY_SLOT_DIR=str(self.root / 'shared'))
        self.assertEqual(0, result.returncode, result.stderr)
