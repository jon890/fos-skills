"""collect_targets.py 의 스크립트 전용 범위 안내와 run_doc_snippets.py 의 --list, --block 을 검증한다."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def run(script, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *map(str, args)], capture_output=True, text=True
    )


class CollectTargetsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()

    def test_script_only_scope_reports_count(self):
        scope = self.root / ".claude/scripts"
        scope.mkdir(parents=True)
        (scope / "a.py").write_text("")
        (scope / "b.sh").write_text("")
        done = run("collect_targets.py", self.root, "--scope", ".claude/scripts")
        self.assertEqual(done.returncode, 2)
        self.assertIn("스크립트 2개", done.stderr)
        self.assertIn("script-audit.md", done.stderr)
        self.assertNotIn("저장소 루트를 확인한다", done.stderr)

    def test_empty_scope_keeps_root_hint(self):
        (self.root / "empty").mkdir()
        done = run("collect_targets.py", self.root, "--scope", "empty")
        self.assertEqual(done.returncode, 2)
        self.assertIn("저장소 루트를 확인한다", done.stderr)

    def test_markdown_scope_still_succeeds(self):
        (self.root / "CLAUDE.md").write_text("# 지침\n")
        done = run("collect_targets.py", self.root)
        self.assertEqual(done.returncode, 0)
        self.assertIn("CLAUDE.md", done.stdout)


class StrayDirsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        git = ["git", "-C", str(self.root)]
        subprocess.run([*git, "init", "-q"], check=True)
        live = self.root / "plugins/p/skills/live"
        live.mkdir(parents=True)
        (live / "SKILL.md").write_text("---\nname: live\n---\n")
        subprocess.run([*git, "add", "."], check=True)
        subprocess.run(
            [*git, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"],
            check=True,
        )

    def test_untracked_skill_dir_without_skill_md_warns_and_keeps_exit_code(self):
        stray = self.root / "plugins/p/skills/old/__pycache__"
        stray.mkdir(parents=True)
        (stray / "x.pyc").write_text("")
        done = run("collect_targets.py", self.root)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("plugins/p/skills/old", done.stderr)
        self.assertTrue(stray.exists())

    def test_tracked_skill_dirs_do_not_warn(self):
        done = run("collect_targets.py", self.root)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("경고", done.stderr)

    def test_tracked_dir_without_skill_md_does_not_warn(self):
        shared = self.root / "plugins/p/skills/_shared"
        shared.mkdir()
        (shared / "notes.txt").write_text("x")
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        done = run("collect_targets.py", self.root)
        self.assertNotIn("경고", done.stderr)

    def test_non_git_directory_does_not_warn(self):
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        plain = Path(other.name).resolve()
        (plain / "skills/old").mkdir(parents=True)
        (plain / "CLAUDE.md").write_text("# 지침\n")
        done = run("collect_targets.py", plain)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("경고", done.stderr)


DOC = """# 문서

안전한 블록이다.

```bash
echo SAFE_MARK > "$MARK_FILE"
```

위험한 블록이다.

```bash
gh pr merge 1
```

```bash
git push origin main
```
"""


class RunDocSnippetsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.doc = self.dir / "doc.md"
        self.doc.write_text(DOC, encoding="utf-8")

    def test_list_marks_risky_and_not_safe(self):
        done = run("run_doc_snippets.py", self.doc, "--list")
        self.assertEqual(done.returncode, 0)
        lines = done.stdout.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertNotIn("[위험", lines[0])
        self.assertIn("[위험: gh]", lines[1])
        self.assertIn("[위험: git push", lines[2])

    def test_list_does_not_execute(self):
        marker = self.dir / "executed"
        self.doc.write_text(f"```bash\ntouch {marker}\n```\n", encoding="utf-8")
        done = run("run_doc_snippets.py", self.doc, "--list")
        self.assertEqual(done.returncode, 0)
        self.assertFalse(marker.exists())

    def test_block_runs_only_that_block(self):
        marker = self.dir / "mark"
        self.doc.write_text(
            f"```bash\ntouch {marker}\n```\n\n```bash\necho SECOND\n```\n", encoding="utf-8"
        )
        done = run("run_doc_snippets.py", self.doc, "--block", 2)
        self.assertEqual(done.returncode, 0)
        self.assertIn("SECOND", done.stdout)
        self.assertFalse(marker.exists())

    def test_block_out_of_range(self):
        self.assertEqual(run("run_doc_snippets.py", self.doc, "--block", 9).returncode, 3)
        self.assertEqual(run("run_doc_snippets.py", self.doc, "--block").returncode, 2)

    def test_positional_usage_unchanged(self):
        done = run("run_doc_snippets.py", self.doc, "안전한 블록이다.")
        self.assertEqual(done.returncode, 0)
        self.assertIn("추출한 블록", done.stdout)


if __name__ == "__main__":
    unittest.main()
