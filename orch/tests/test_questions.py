import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import questions


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


watch = load('watch-questions')
doctor = load('orch-doctor')


def message(mid='q', kind='question', **extra):
    return dict(id=mid, type=kind, run_id='r', to_handle='run:r',
                from_handle='dispatch:d', thread_id=mid, body='두 줄\n질문',
                created_at='2026-01-01T00:00:00Z', **extra)


class QuestionsTest(unittest.TestCase):
    def test_ack_does_not_resolve_and_coordinator_reply_does(self):
        q = message(read=1)
        follow = dict(q, id='follow', type='status', thread_id='q')
        other = dict(q, id='other', run_id='other', to_handle='run:other')
        self.assertEqual([q], questions.unanswered([q, follow, other], 'r'))
        reply = dict(follow, id='answer', from_handle='run:r', to_handle='dispatch:d')
        self.assertEqual([], questions.unanswered([q, reply], 'r'))
        e = message('e', 'escalation')
        self.assertEqual([e], questions.unanswered([e, reply], 'r'))
        self.assertEqual([], questions.unanswered([e, dict(reply, thread_id='e')], 'r'))

    def test_snapshot_uses_read_only_inbox_and_run(self):
        with patch.object(questions, 'orca', side_effect=[{'run': {'id': 'r'}},
                          {'messages': [message(read=1)]}, {'messages': [message(read=1)]},
                          {'messages': []}]) as cli:
            self.assertEqual(('r', [message(read=1)]), questions.snapshot())
        self.assertEqual([('run-current',),
                          ('check', '--run', 'r', '--all', '--types', 'question,escalation'),
                          ('check', '--run', 'r', '--peek', '--types', 'question,escalation'),
                          ('inbox', '--terminal', 'dispatch:d', '--limit', str(questions.REPLY_LIMIT))],
                         [call.args for call in cli.call_args_list])

    def test_invalid_snapshot_is_not_empty_success(self):
        for data in ({}, {'messages': None}, {'messages': [None]}):
            with patch.object(questions, 'orca', return_value=data), self.assertRaises(RuntimeError):
                questions.snapshot('r')

    def test_run_questions_match_replies_and_keep_old_unread(self):
        q = message(read=1)
        old = message('old')
        answer = dict(q, id='answer', from_handle='run:r', to_handle='dispatch:d')
        with patch.object(questions, 'orca', side_effect=[{'messages': [q]}, {'messages': [old]},
                          {'messages': [answer]}]) as cli:
            self.assertEqual(('r', [old]), questions.snapshot('r'))
            self.assertEqual(3, cli.call_count)  # one reply query per sender

    def test_full_reply_window_is_an_error_unless_all_candidates_answered(self):
        q = message()
        unrelated = dict(q, id='follow', type='status', to_handle='dispatch:d')
        rows = [unrelated] * questions.REPLY_LIMIT
        with patch.object(questions, 'orca', side_effect=[{'messages': [q]}, {'messages': []},
                          {'messages': rows}]), self.assertRaisesRegex(RuntimeError, '답변 기록 한도'):
            questions.snapshot('r')
        answer = dict(unrelated, id='answer', from_handle='run:r')
        with patch.object(questions, 'orca', side_effect=[{'messages': [q]}, {'messages': []},
                          {'messages': [answer, *rows[1:]]}]):
            self.assertEqual(('r', []), questions.snapshot('r'))

    def test_large_global_history_is_never_requested(self):
        # 30,000 messages exceed 40 MB; only scoped questions/replies reach the client.
        global_rows = [dict(message(str(i)), body='x' * 1500) for i in range(30000)]
        self.assertGreater(len(json.dumps(global_rows)), 40_000_000)
        q = message(read=1)
        answer = dict(q, id='answer', from_handle='run:r', to_handle='dispatch:d')

        def scoped(*args):
            if args[0] == 'inbox' and '--terminal' not in args:
                self.fail('global inbox requested')
            return {'messages': [answer] if args[0] == 'inbox' else [q]}

        with patch.object(questions, 'orca', side_effect=scoped):
            self.assertEqual(('r', []), questions.snapshot('r'))

    def test_full_question_history_warns_about_coverage(self):
        q = message()
        with patch.object(questions, 'orca', side_effect=[{'messages': [q] * questions.HISTORY_LIMIT},
                          {'messages': []}, {'messages': []}]), patch('sys.stderr') as err:
            self.assertEqual(('r', [q]), questions.snapshot('r'))
            self.assertIn('더 오래된 미답변', ''.join(c.args[0] for c in err.write.call_args_list))

    def test_restart_reminder_run_isolation_and_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state' / 'questions-seen.json'
            with patch.object(questions, 'snapshot', return_value=('r', [message()])):
                self.assertEqual(1, len(watch.poll('r', state, 1000, 600)[1]))
                self.assertEqual([], watch.poll('r', state, 1599, 600)[1])
                self.assertTrue(watch.poll('r', state, 1600, 600)[1][0].startswith('REMINDER q'))
            with patch.object(questions, 'snapshot', return_value=('other', [message()])):
                self.assertEqual(1, len(watch.poll('other', state, 1601, 600)[1]))
            with patch.object(questions, 'snapshot', return_value=('r', [])):
                self.assertEqual([], watch.poll('r', state, 2400, 600)[1])
            self.assertEqual({'r', 'other'}, set(json.loads(state.read_text())))

    def test_failed_query_preserves_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'seen.json'
            state.write_text('{"r":{"q":1000}}')
            with patch.object(questions, 'snapshot', side_effect=RuntimeError('offline')), self.assertRaises(RuntimeError):
                watch.poll('r', state, 1700, 600)
            self.assertEqual('{"r":{"q":1000}}', state.read_text())

    def test_doctor_warns_only_for_overdue_unanswered(self):
        start = 1767225600
        with patch.object(questions, 'snapshot', return_value=('r', [message()])):
            self.assertEqual(([], False), doctor.check_questions('r', start + 599))
            lines, code = doctor.check_questions('r', start + 600)
            self.assertEqual(1, code)
            self.assertIn('UNANSWERED q', lines[0])
        with patch.object(questions, 'snapshot', return_value=('r', [])):
            self.assertEqual(([], False), doctor.check_questions('r', start + 900))
        with patch.object(questions, 'snapshot', side_effect=RuntimeError('offline')):
            self.assertEqual(0, doctor.check_questions('r')[1])

    def test_orca_errors_and_timeout(self):
        for raw in ('[]', '{"ok":false,"error":"offline"}', '{"result":null}'):
            done = subprocess.CompletedProcess([], 0, raw, '')
            with patch.object(questions.subprocess, 'run', return_value=done), self.assertRaises(RuntimeError):
                questions.orca('inbox')
        done = subprocess.CompletedProcess([], 1, '', 'offline')
        with patch.object(questions.subprocess, 'run', return_value=done), self.assertRaises(RuntimeError):
            questions.orca('inbox')
        with patch.object(questions, 'snapshot', side_effect=subprocess.TimeoutExpired('orca', 30)):
            self.assertEqual(0, doctor.check_questions('r')[1])

    def test_once_and_timeout_do_not_destroy_state(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(watch.orch_paths, 'path', return_value=Path(tmp)):
            with patch.object(questions, 'snapshot', return_value=('r', [])):
                self.assertEqual(0, watch.main(['--run', 'r', '--once']))
            with patch.object(questions, 'snapshot', side_effect=subprocess.TimeoutExpired('orca', 30)):
                self.assertEqual(1, watch.main(['--run', 'r', '--once']))
            self.assertEqual({'r': {}}, json.loads((Path(tmp) / 'questions-seen.json').read_text()))

    def test_cli_invalid_intervals(self):
        for option in ('--interval', '--remind-after'):
            done = subprocess.run([sys.executable, str(SCRIPTS / 'watch-questions.py'), option, '0'], capture_output=True)
            self.assertEqual(2, done.returncode)

    def test_cli_restart_uses_orch_paths_and_resolved_questions_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = root / 'inbox.json'
            fixture.write_text(json.dumps({'result': {'messages': [message()]}}))
            cli = root / 'orca'
            cli.write_text('#!' + sys.executable + '\nimport os, sys, json\nfrom pathlib import Path\n'
                           'data = json.loads(Path(os.environ["QUESTION_FIXTURE"]).read_text())\n'
                           'rows = data["result"]["messages"]\n'
                           'data["result"]["messages"] = [m for m in rows if '
                           '(m["from_handle"] == "run:r") == ("inbox" in sys.argv)]\n'
                           'print(json.dumps(data))\n')
            cli.chmod(0o755)
            env = dict(os.environ, ORCA_CLI_COMMAND=str(cli), ORCH_DIR=str(root / 'orch'),
                       QUESTION_FIXTURE=str(fixture))
            cmd = [sys.executable, str(SCRIPTS / 'watch-questions.py'), '--run', 'r', '--once']
            first = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(0, first.returncode, first.stderr)
            self.assertIn('QUESTION q question', first.stdout)
            second = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual((0, ''), (second.returncode, second.stdout))
            state = root / 'orch/state/questions-seen.json'
            state.write_text('{"r":{"q":0}}')
            fixture.write_text(json.dumps({'result': {'messages': [message(), dict(
                message(), id='answer', type='status', from_handle='run:r', thread_id='q')]}}))
            third = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual((0, ''), (third.returncode, third.stdout))


if __name__ == '__main__':
    unittest.main()
