"""remove-worktree.sh 가 경로를 쥔 프로세스를 기다리는지 실제 git 저장소와 가짜 lsof, ps, sleep 으로 본다."""

import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "remove-worktree.sh"
HOOK = "node /x/oh-my-claudecode/dist/hooks/session-end/worker.js --omc-session-end-worker {}"


def sh(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipUnless(shutil.which("zsh"), "zsh 없음")
class RemoveWorktreeWaitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
        os.environ.update({k: self.env[k] for k in self.env if k.startswith("GIT_")})
        origin, repo = self.tmp / "origin.git", self.tmp / "repo"
        sh("git", "init", "-q", "--bare", "-b", "main", str(origin))
        sh("git", "clone", "-q", str(origin), str(repo))
        sh("git", "-C", str(repo), "commit", "-q", "--allow-empty", "-m", "init")
        sh("git", "-C", str(repo), "push", "-q", "-u", "origin", "main")
        self.path = self.tmp / "wt"
        sh("git", "-C", str(repo), "worktree", "add", "-q", "-b", "feat", str(self.path), "origin/main")
        sh("git", "-C", str(self.path), "push", "-q", "-u", "origin", "feat")
        self.state = self.tmp / "state.json"
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        # 가짜 sleep 은 부를 때마다 시계를 1 올리고, gone 에 이른 프로세스를 지운다
        head = f'#!/usr/bin/env python3\nimport json\nst = json.load(open("{self.state}"))\n'
        fakes = {
            "orca": 'print(json.dumps({"result": {"terminals": st.get("terminals", [])}}))\n',
            "lsof": 'for q in st["procs"]:\n    print("p%s" % q["pid"]); print("n" + q["cwd"])\n',
            "ps": 'for q in st["procs"]:\n    print(q["pid"], q.get("ppid", 1), q["command"])\n',
            "sleep": textwrap.dedent(f"""\
                st["slept"] += 1
                st["procs"] = [q for q in st["procs"] if q.get("gone") is None or q["gone"] > st["slept"]]
                json.dump(st, open("{self.state}", "w"))
                """),
        }
        for name, body in fakes.items():
            (self.bin / name).write_text(head + body)
            (self.bin / name).chmod(0o755)

    def run_remove(self, procs, *args, hook_wait=None):
        self.state.write_text(json.dumps({"slept": 0, "procs": procs}))
        env = dict(self.env, PATH=f"{self.bin}:{os.environ['PATH']}")
        if hook_wait is not None:
            env["ORCH_HOOK_WAIT"] = str(hook_wait)
        done = subprocess.run(["zsh", str(SCRIPT), str(self.path), *args], capture_output=True, text=True, env=env)
        return done.returncode, done.stdout + done.stderr, json.loads(self.state.read_text())["slept"]

    def proc(self, pid, command, gone=None, ppid=1):
        return {"pid": pid, "cwd": str(self.path), "command": command, "gone": gone, "ppid": ppid}

    def test_waits_for_session_end_hook_and_removes(self):
        code, out, slept = self.run_remove([self.proc(41, HOOK, gone=3)])
        self.assertEqual(code, 0, out)
        self.assertIn("OMC session-end hook 41", out)
        self.assertEqual(slept, 3)
        self.assertFalse(self.path.exists())

    def test_hook_that_does_not_end_is_refused_after_hook_wait(self):
        code, out, slept = self.run_remove([self.proc(41, HOOK)], hook_wait=2)
        self.assertEqual(code, 1)
        self.assertIn("2초 기다림", out)
        self.assertIn("session-end hook 41 는 스스로 끝난다", out)
        self.assertEqual(slept, 2)
        self.assertTrue(self.path.exists())

    def test_other_holder_is_refused_without_waiting(self):
        code, out, slept = self.run_remove([self.proc(42, "node server.js", gone=1)])
        self.assertEqual(code, 1)
        self.assertIn("pid 42", out)
        self.assertNotIn("session-end", out)
        self.assertEqual(slept, 0)
        self.assertTrue(self.path.exists())

    def test_hook_beside_other_holder_does_not_extend_the_wait(self):
        code, out, slept = self.run_remove([self.proc(41, HOOK, gone=2), self.proc(42, "-/bin/zsh")])
        self.assertEqual(code, 1)
        self.assertEqual(slept, 0)
        self.assertIn("pid 41, 42", out)

    def test_hook_and_its_child_wait_for_hook_wait(self):
        # 대기 도중 hook 의 자식(42)이 생겨도 --wait 가 아니라 hook 대기 시간까지 기다린다
        procs = [self.proc(41, HOOK, gone=5), self.proc(42, "node child.js", gone=4, ppid=41)]
        code, out, slept = self.run_remove(procs, "--wait", "1", hook_wait=10)
        self.assertEqual(code, 0, out)
        self.assertEqual(slept, 5)
        self.assertFalse(self.path.exists())

    def test_unrelated_process_beside_hook_is_refused_after_wait(self):
        procs = [self.proc(41, HOOK, gone=5), self.proc(50, "node other.js", ppid=7)]
        code, out, slept = self.run_remove(procs, "--wait", "1", hook_wait=10)
        self.assertEqual(code, 1)
        self.assertEqual(slept, 1)
        self.assertIn("pid 41, 50", out)
        self.assertTrue(self.path.exists())

    def test_wait_option_waits_for_other_holder(self):
        code, out, slept = self.run_remove([self.proc(42, "node server.js", gone=2)], "--wait", "5")
        self.assertEqual(code, 0, out)
        self.assertEqual(slept, 2)
        self.assertFalse(self.path.exists())

    def test_wait_needs_an_integer(self):
        code, _, _ = self.run_remove([], "--wait", "soon")
        self.assertEqual(code, 2)
        self.assertTrue(self.path.exists())


if __name__ == "__main__":
    unittest.main()
