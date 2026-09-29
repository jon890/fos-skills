"""overlay_paths.py 가 references/monorepo.md 의 판정 순서를 따르는지 검증한다."""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "overlay_paths.py"
SPEC = importlib.util.spec_from_file_location("overlay_paths", SCRIPT)
op = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(op)

LAYOUT = "## 저장소 배치\n\n| 값 | 값 |\n| --- | --- |\n| docs 경로 | `{sub}/docs/` |\n| plan 접두사 | `{prefix}` |\n"


class OverlayPathsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True,
                       env={**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})
        self.write(".claude/review-fix-overlay.md", "루트")
        self.write("CLAUDE.md", "지침")

    def write(self, rel, text=""):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def monorepo(self):
        self.write("frontend/.claude/planning-overlay.md", LAYOUT.format(sub="frontend", prefix="fe-"))
        self.write("frontend/.claude/review-fix-overlay.md", "프론트")
        self.write("backend/.claude/planning-overlay.md", LAYOUT.format(sub="backend", prefix="be-"))
        self.write("backend/CLAUDE.md", "백엔드 지침")

    def run_main(self, *args, cwd=None, stdin=""):
        with patch.object(op.Path, "cwd", return_value=cwd or self.root), patch("sys.stdin", io.StringIO(stdin)), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            code = op.main(["overlay_paths.py", "--skill", "review-fix", *args])
        return code, json.loads(out.getvalue()) if out.getvalue() else None

    def test_single_repo_keeps_previous_order(self):
        code, result = self.run_main("src/app.ts")
        self.assertEqual(code, 0)
        self.assertFalse(result["monorepo"])
        self.assertEqual(result["search"]["."][:2], [".claude/review-fix-overlay.md", "CLAUDE.md"])

    def test_paths_in_one_subproject(self):
        self.monorepo()
        code, result = self.run_main("frontend/src/app.ts", "frontend/docs/flow.md")
        self.assertEqual((code, result["targets"], result["reason"]), (0, ["frontend"], "paths"))
        self.assertEqual(result["search"]["frontend"][:3],
                         ["frontend/.claude/review-fix-overlay.md", ".claude/review-fix-overlay.md", "CLAUDE.md"])

    def test_subproject_harness_file_comes_before_root_harness(self):
        self.monorepo()
        _, result = self.run_main("backend/src/App.java")
        self.assertEqual(result["search"]["backend"][:3], [".claude/review-fix-overlay.md", "backend/CLAUDE.md", "CLAUDE.md"])

    def test_paths_across_subprojects_return_both(self):
        self.monorepo()
        code, result = self.run_main("-", stdin="frontend/a.ts\nbackend/B.java\n")
        self.assertEqual((code, result["targets"]), (0, ["backend", "frontend"]))

    def test_root_path_is_undetermined(self):
        self.monorepo()
        code, result = self.run_main("frontend/a.ts", "README.md")
        self.assertEqual((code, result["targets"]), (1, []))

    def test_plan_prefix_selects_subproject(self):
        self.monorepo()
        code, result = self.run_main("--plan", "be-plan027-login")
        self.assertEqual((code, result["targets"], result["reason"]), (0, ["backend"], "plan"))

    def test_unprefixed_plan_does_not_match_prefixed_subproject(self):
        self.monorepo()
        code, _ = self.run_main("--plan", "plan027-login")
        self.assertEqual(code, 1)

    def test_user_choice_wins_and_must_exist(self):
        self.monorepo()
        code, result = self.run_main("--sub", "backend", "frontend/a.ts")
        self.assertEqual((code, result["targets"], result["reason"]), (0, ["backend"], "user"))
        code, _ = self.run_main("--sub", "infra")
        self.assertEqual(code, 2)

    def test_cwd_inside_subproject(self):
        self.monorepo()
        code, result = self.run_main(cwd=self.root / "frontend")
        self.assertEqual((code, result["targets"], result["reason"]), (0, ["frontend"], "cwd"))

    def test_directory_without_overlay_is_not_subproject(self):
        self.write("scripts/.claude/settings.json", "{}")
        code, result = self.run_main("scripts/x.sh")
        self.assertEqual((code, result["monorepo"]), (0, False))


if __name__ == "__main__":
    unittest.main()
