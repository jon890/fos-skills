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
        self.write("frontend/.claude/plan-overlay.md", LAYOUT.format(sub="frontend", prefix="fe-"))
        self.write("frontend/.claude/review-fix-overlay.md", "프론트")
        self.write("backend/.claude/plan-overlay.md", LAYOUT.format(sub="backend", prefix="be-"))
        self.write("backend/CLAUDE.md", "백엔드 지침")

    def run_main(self, *args, cwd=None, stdin=""):
        with patch.object(op.Path, "cwd", return_value=cwd or self.root), patch("sys.stdin", io.StringIO(stdin)), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            code = op.main(["overlay_paths.py", "--skill", "review-fix", *args])
        return code, json.loads(out.getvalue()) if out.getvalue() else None

    def test_renamed_skills_keep_old_overlay_values_at_same_scope(self):
        for name, old in [('plan', 'planning'), ('implementation', 'build-with-teams')]:
            with self.subTest(name=name):
                self.write(f'.claude/{name}-overlay.md', 'new root')
                self.write(f'backend/.claude/{old}-overlay.md', 'old local')
                paths = op.search_order(self.root, name, 'backend')
                self.assertLess(paths.index(f'backend/.claude/{old}-overlay.md'),
                                paths.index(f'.claude/{name}-overlay.md'))
                self.write(f'backend/.claude/{name}-overlay.md', 'new local')
                paths = op.search_order(self.root, name, 'backend')
                self.assertLess(paths.index(f'backend/.claude/{name}-overlay.md'),
                                paths.index(f'backend/.claude/{old}-overlay.md'))

    def test_docs_audit_overlay_fallback_matrix(self):
        for scope in (None, "backend"):
            for current, legacy in ((True, False), (False, True), (True, True), (False, False)):
                with self.subTest(scope=scope, current=current, legacy=legacy):
                    directory = f"{scope}/.claude" if scope else ".claude"
                    new = f"{directory}/docs-audit-overlay.md"
                    old = f"{directory}/docs-check-overlay.md"
                    for rel, exists in ((new, current), (old, legacy)):
                        (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
                        (self.root / rel).unlink(missing_ok=True)
                        if exists:
                            self.write(rel, "설정")
                    with contextlib.redirect_stderr(io.StringIO()) as err:
                        paths = op.search_order(self.root, "docs-audit", scope)
                    existing = [p for p in paths if not p.startswith("(없음)")]
                    self.assertEqual(new in existing, current)
                    self.assertEqual(old in existing, legacy and not current)
                    self.assertEqual(bool(err.getvalue()), legacy and not current)
                    if legacy and not current:
                        self.assertEqual(len(err.getvalue().splitlines()), 1)
                        self.assertIn(old, err.getvalue())
                    if current:
                        self.assertNotIn(old, paths)

    def test_docs_consolidate_uses_audit_fallback_only_without_own_overlay(self):
        for own, current, legacy in ((False, False, True), (False, True, True),
                                     (True, False, True), (True, True, True),
                                     (False, False, False)):
            with self.subTest(own=own, current=current, legacy=legacy):
                for name, exists in (("docs-consolidate", own), ("docs-audit", current), ("docs-check", legacy)):
                    rel = f".claude/{name}-overlay.md"
                    (self.root / rel).unlink(missing_ok=True)
                    if exists:
                        self.write(rel, "설정")
                result = subprocess.run(["python3", str(SCRIPT), "--skill", "docs-consolidate"],
                                        cwd=self.root, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0)
                existing = [p for p in json.loads(result.stdout)["search"]["."] if not p.startswith("(없음)")]
                self.assertEqual(".claude/docs-consolidate-overlay.md" in existing, own)
                self.assertEqual(".claude/docs-audit-overlay.md" in existing, current and not own)
                self.assertEqual(".claude/docs-check-overlay.md" in existing, legacy and not current and not own)
                self.assertEqual(bool(result.stderr), legacy and not current and not own)

    def test_docs_audit_cli_keeps_json_on_stdout_and_warning_on_stderr(self):
        self.write(".claude/docs-check-overlay.md", "설정")
        result = subprocess.run(["python3", str(SCRIPT), "--skill", "docs-audit"],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn(".claude/docs-check-overlay.md", json.loads(result.stdout)["search"]["."])
        self.assertEqual(len(result.stderr.splitlines()), 1)
        self.assertIn("docs-audit-overlay.md", result.stderr)
        self.assertIn("docs-audit 스킬 5.0.0", result.stderr)

    def test_docs_audit_legacy_subproject_precedes_current_root(self):
        self.write(".claude/docs-audit-overlay.md", "루트")
        self.write("backend/.claude/docs-check-overlay.md", "하위")
        with contextlib.redirect_stderr(io.StringIO()) as err:
            paths = op.search_order(self.root, "docs-audit", "backend")
        self.assertLess(paths.index("backend/.claude/docs-check-overlay.md"),
                        paths.index(".claude/docs-audit-overlay.md"))
        self.assertEqual(len(err.getvalue().splitlines()), 1)

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
