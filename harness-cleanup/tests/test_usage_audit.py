"""사용 기록 모드의 스크립트를 임시 jsonl 표본으로 검증한다. 실제 대화 기록은 쓰지 않는다."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def skill_call(skill, ts, tool_id):
    return {"type": "assistant", "timestamp": ts, "sessionId": "abcdef1234", "message": {
        "model": "test-model", "content": [{"type": "tool_use", "id": tool_id, "name": "Skill", "input": {"skill": skill}}]}}


def user(text, ts):
    return {"type": "user", "timestamp": ts, "sessionId": "abcdef1234", "message": {"content": text}}


def tool_error(ts):
    return {"type": "user", "timestamp": ts, "sessionId": "abcdef1234", "message": {
        "content": [{"type": "tool_result", "is_error": True, "content": "실패"}]}}


class UsageAuditTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.projects = self.base / "projects"
        self.out = self.base / "out"

    def write_session(self, name, records):
        path = self.projects / "-repo" / f"{name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records) + "{깨진 줄\n")
        return path

    def run_script(self, script, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / script), *args], capture_output=True, text=True)

    def extract(self, *args):
        return self.run_script("extract_skill_usage.py", "--projects", str(self.projects), *args)

    def rows(self, done):
        return {line.split("\t")[0]: line.split("\t")[1:] for line in done.stdout.splitlines() if "\t" in line}

    def test_counts_only_user_and_assistant_records(self):
        call = skill_call("fos-skills:planning", "2026-10-10T00:00:00Z", "t1")
        blob = {"type": "api-request-blob", "sessionId": "abcdef1234", "message": call["message"]}
        self.write_session("abcdef1234", [call, blob, blob, user("그게 아니라 다시 해", "2026-10-10T00:01:00Z"), tool_error("2026-10-10T00:02:00Z")])
        done = self.extract("--skill", "planning")
        self.assertEqual(done.returncode, 0, done.stderr)
        # calls, main, with_correction, with_interrupt, tool_errors, reinvoked, friction
        self.assertEqual(self.rows(done)["planning"], ["1", "1", "1", "0", "1", "0", "4"])

    def test_skill_and_since_narrow_the_range(self):
        self.write_session("abcdef1234", [
            skill_call("planning", "2026-09-01T00:00:00Z", "t1"),
            skill_call("planning", "2026-10-05T00:00:00Z", "t2"),
            user("<command-name>/orch</command-name>", "2026-10-06T00:00:00Z"),
        ])
        rows = self.rows(self.extract("--since", "2026-10-01"))
        self.assertEqual(rows["planning"][0], "1")
        self.assertEqual(rows["orch"][0], "1")
        self.assertNotIn("orch", self.rows(self.extract("--skill", "planning")))

    def test_stdout_has_no_excerpt_and_samples_use_short_id(self):
        self.write_session("abcdef1234", [skill_call("planning", "2026-10-05T00:00:00Z", "t1"), user("비밀 문장 다시", "2026-10-05T00:01:00Z")])
        done = self.extract("--samples", "1")
        self.assertNotIn("비밀 문장", done.stdout)
        self.assertIn("abcdef12\t2026-10-05T00:00:00\tplanning\t3", done.stdout)
        self.assertNotIn("abcdef1234", done.stdout)

    def test_out_writes_redacted_excerpts_and_refuses_git_worktree(self):
        self.write_session("abcdef1234", [skill_call("planning", "2026-10-05T00:00:00Z", "t1"), user("token=ghp_abcdefghijklmnopqrstuvwxyz0123", "2026-10-05T00:01:00Z")])
        done = self.extract("--out", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        written = (self.out / "invocations.jsonl").read_text()
        self.assertIn("[가림]", written)
        self.assertNotIn("ghp_", written)

        repo = self.base / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        refused = self.extract("--out", str(repo / "usage"))
        self.assertEqual(refused.returncode, 2)

    def test_missing_projects_dir_is_an_error_not_zero_calls(self):
        done = self.run_script("extract_skill_usage.py", "--projects", str(self.base / "없음"))
        self.assertEqual(done.returncode, 2)

    def test_render_session_resolves_short_id_and_writes_only_to_out(self):
        self.write_session("abcdef1234", [
            user("첫 요청 password=hunter2", "2026-10-05T00:00:00Z"),
            skill_call("planning", "2026-10-05T00:01:00Z", "t1"),
            tool_error("2026-10-05T00:02:00Z"),
        ])
        target = self.out / "s.txt"
        done = self.run_script("render_session.py", "abcdef12", "--out", str(target), "--projects", str(self.projects),
                               "--from", "2026-10-05T00:01")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("TOOL", done.stdout)
        text = target.read_text()
        self.assertIn("TOOL: Skill", text)
        self.assertIn("TOOL_ERROR: 실패", text)
        self.assertNotIn("첫 요청", text)

    def test_render_session_masks_secrets(self):
        self.write_session("abcdef1234", [user("password=hunter2 그대로", "2026-10-05T00:00:00Z")])
        target = self.out / "s.txt"
        self.run_script("render_session.py", "abcdef12", "--out", str(target), "--projects", str(self.projects))
        self.assertNotIn("hunter2", target.read_text())

    def test_render_session_rejects_unknown_session(self):
        self.projects.mkdir(parents=True)
        done = self.run_script("render_session.py", "zzzz", "--out", str(self.out / "s.txt"), "--projects", str(self.projects))
        self.assertEqual(done.returncode, 2)

    def test_model_fit_signals_counts_skill_docs_but_not_readme(self):
        skill = self.base / "skills" / "demo"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: demo\ndescription: 데모\nmetadata:\n---\n**강조** 하위 에이전트\n")
        (skill / "README.md").write_text("**강조** **강조**\n")
        done = self.run_script("model_fit_signals.py", str(self.base / "skills"))
        self.assertEqual(done.returncode, 0, done.stderr)
        row = next(line for line in done.stdout.splitlines() if line.startswith("demo\t")).split("\t")
        self.assertEqual(row[3], "1")  # 굵은강조
        self.assertEqual(row[6], "1")  # 위임지시
        self.assertEqual(self.run_script("model_fit_signals.py").returncode, 2)


if __name__ == "__main__":
    unittest.main()
