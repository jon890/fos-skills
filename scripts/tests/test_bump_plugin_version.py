"""플러그인 version 자동 상향(`scripts/bump-plugin-version.py`)이 바뀐 스킬 CHANGELOG 로 등급을 정하고 두 파일을 고치는지 임시 git 저장소로 검증한다."""

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("bump_plugin_version", ROOT / "scripts" / "bump-plugin-version.py")
bumper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bumper)

MANIFEST = '{\n  "name": "demo",\n  "version": "1.4.0",\n  "skills": ["./orch"]\n}\n'
PLUGIN_LOG = "# CHANGELOG: demo 플러그인\n\n설명.\n\n## 1.4.0 (2026-11-01)\n\n- orch 5.15.0 (#280)\n"
SKILL_LOG = "# CHANGELOG: orch\n\n## 5.15.0 (2026-11-01)\n\n- 앞 변경\n"
SKILL_MD = '---\nname: orch\nmetadata:\n  version: "5.15.0"\n---\n'


class BumpPluginVersionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        self.write(".claude-plugin/plugin.json", MANIFEST)
        self.write(".claude-plugin/CHANGELOG.md", PLUGIN_LOG)
        self.write("skills/orch/CHANGELOG.md", SKILL_LOG)
        self.write("skills/orch/SKILL.md", SKILL_MD)
        self.base = self.commit("init")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def commit(self, subject):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", subject)
        return self.git("rev-parse", "HEAD")

    def run_bump(self, head):
        return bumper.run(self.base, head, "2026-11-02", root=self.root)

    def version(self):
        return json.loads((self.root / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]

    def changelog(self):
        return (self.root / ".claude-plugin/CHANGELOG.md").read_text(encoding="utf-8")

    def test_new_skill_version_is_minor_and_lists_skill_and_pr(self):
        self.write("skills/orch/CHANGELOG.md", SKILL_LOG.replace("## 5.15.0", "## 5.16.0 (2026-11-02)\n\n- 새 기능\n\n## 5.15.0"))
        head = self.commit("Merge pull request #286 from jon890/feat/x")
        self.assertEqual(self.run_bump(head), "1.5.0")
        self.assertEqual(self.version(), "1.5.0")
        self.assertIn("## 1.5.0 (2026-11-02)\n\n- orch 5.16.0 (#286)\n\n## 1.4.0", self.changelog())
        # 키 순서와 들여쓰기는 그대로다
        self.assertEqual((self.root / ".claude-plugin/plugin.json").read_text(encoding="utf-8"), MANIFEST.replace("1.4.0", "1.5.0"))

    def test_moving_a_changelog_does_not_replay_old_versions(self):
        self.git("mv", "skills/orch", "orch")
        head = self.commit("refactor: move skill")
        self.assertEqual(self.run_bump(head), "1.4.1")
        self.assertNotIn("orch 5.15.0 (#", self.changelog().split("## 1.4.0")[0])

    def test_compat_line_is_major(self):
        self.write("skills/orch/CHANGELOG.md", SKILL_LOG.replace("## 5.15.0", "## 6.0.0 (2026-11-02)\n\n- 호환성: 단계가 바뀐다\n\n## 5.15.0"))
        head = self.commit("feat(orch): 단계를 바꾼다 (#287)")
        self.assertEqual(self.run_bump(head), "2.0.0")
        self.assertIn("- orch 6.0.0 (#287)", self.changelog())

    def test_change_without_skill_version_is_patch_and_lists_places(self):
        self.write("docs/flow.md", "흐름\n")
        self.write("scripts/x.py", "print(1)\n")
        head = self.commit("docs: 흐름을 고친다 (#288)")
        self.assertEqual(self.run_bump(head), "1.4.1")
        self.assertIn("## 1.4.1 (2026-11-02)\n\n- 바뀐 곳: docs, scripts (#288)\n", self.changelog())

    def test_manual_version_change_is_skipped(self):
        self.write(".claude-plugin/plugin.json", MANIFEST.replace("1.4.0", "2.0.0"))
        self.write("docs/flow.md", "흐름\n")
        head = self.commit("chore: 직접 올린다")
        self.assertTrue(self.run_bump(head).startswith("skip:"))
        self.assertEqual(self.version(), "2.0.0")

    def test_only_plugin_changelog_is_skipped(self):
        self.write(".claude-plugin/CHANGELOG.md", PLUGIN_LOG + "\n")
        head = self.commit("chore: 플러그인 이력만")
        self.assertTrue(self.run_bump(head).startswith("skip:"))
        self.assertEqual(self.version(), "1.4.0")

    def test_zero_base_uses_parent(self):
        self.write("docs/a.md", "a\n")
        head = self.commit("docs: a")
        self.assertEqual(bumper.run(bumper.ZERO, head, "2026-11-02", root=self.root), "1.4.1")

    def test_fragment_raises_skill_and_plugin_minor_and_lists_new_skill_version(self):
        self.write("skills/orch/changes/add-queue.patch.md", "- 문구를 고쳤다\n")
        self.write("skills/orch/SKILL.md", SKILL_MD + "본문\n")
        head = self.commit("Merge pull request #290 from jon890/fix/x")
        self.assertEqual(self.run_bump(head), "1.5.0")
        self.assertIn("## 1.5.0 (2026-11-02)\n\n- orch 5.15.1 (#290)\n", self.changelog())
        self.assertIn('version: "5.15.1"', (self.root / "skills/orch/SKILL.md").read_text(encoding="utf-8"))
        self.assertIn("## 5.15.1 (2026-11-02)\n\n- 문구를 고쳤다", (self.root / "skills/orch/CHANGELOG.md").read_text(encoding="utf-8"))
        self.assertFalse((self.root / "skills/orch/changes").exists())

    def test_fragment_with_legacy_compat_line_keeps_major_and_lists_both(self):
        self.write("skills/orch/changes/a.minor.md", "- 새 기능\n")
        self.write("skills/plan/CHANGELOG.md", "# CHANGELOG: plan\n\n## 6.0.0 (2026-11-02)\n\n- 호환성: 단계가 바뀐다\n\n## 5.0.0 (2026-11-01)\n\n- 앞\n")
        head = self.commit("feat: 섞인 변경 (#291)")
        self.assertEqual(self.run_bump(head), "2.0.0")
        self.assertIn("- orch 5.16.0, plan 6.0.0", self.changelog())

    def test_fragment_processed_by_an_earlier_run_does_not_bump_again(self):
        self.write("skills/orch/changes/a.minor.md", "- 하나\n")
        head = self.commit("add fragment")
        self.git("rm", "-q", "skills/orch/changes/a.minor.md")
        self.commit("bot: processed")
        # 이번 push 범위는 조각 추가만 담고 조각은 이미 지워졌다
        self.assertTrue(self.run_bump(head).startswith("skip:"))

    def test_manual_plugin_version_still_applies_fragments(self):
        self.write(".claude-plugin/plugin.json", MANIFEST.replace("1.4.0", "2.0.0"))
        self.write("skills/orch/changes/a.minor.md", "- 하나\n")
        head = self.commit("chore: 직접 올린다")
        self.assertTrue(self.run_bump(head).startswith("skip:"))
        self.assertEqual(self.version(), "2.0.0")
        self.assertIn("## 5.16.0 (2026-11-02)", (self.root / "skills/orch/CHANGELOG.md").read_text(encoding="utf-8"))

    def test_two_fragments_bump_plugin_once_and_list_every_new_version(self):
        self.write("skills/orch/changes/a.minor.md", "- 하나\n")
        self.commit("feat: a (#293)")
        self.write("skills/orch/changes/b.patch.md", "- 둘\n")
        head = self.commit("fix: b (#294)")
        self.assertEqual(self.run_bump(head), "1.5.0")
        self.assertIn("- orch 5.16.0, orch 5.16.1 (#293 #294)", self.changelog().replace("(#294 #293)", "(#293 #294)"))
        self.assertEqual(self.changelog().count("## 1.5.0"), 1)

    def test_cli_runs_end_to_end_on_a_merge_commit(self):
        self.git("checkout", "-q", "-b", "feature")
        self.write("skills/orch/changes/a.minor.md", "- 하나\n")
        self.commit("feat: a")
        self.git("checkout", "-q", "main")
        self.git("merge", "-q", "--no-ff", "-m", "Merge pull request #295 from jon890/feature", "feature")
        head = self.git("rev-parse", "HEAD")
        # 스크립트는 자기 위치의 상위 폴더를 저장소로 쓰므로 임시 저장소에 복사해 돌린다(이 저장소의 파일을 건드리지 않는다)
        for name in ("bump-plugin-version.py", "skill_changes.py", "skill_paths.py"):
            (self.root / "scripts").mkdir(exist_ok=True)
            shutil.copy2(ROOT / "scripts" / name, self.root / "scripts" / name)
        out = subprocess.run(["python3", str(self.root / "scripts" / "bump-plugin-version.py"), "--base", self.base, "--head", head, "--date", "2026-11-04"],
                             cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "1.5.0")
        self.assertIn("## 1.5.0 (2026-11-04)\n\n- orch 5.16.0 (#295)", self.changelog())

    def test_bad_fragment_is_kept_and_plugin_falls_back_to_patch(self):
        self.write("skills/orch/changes/bad.md", "- 하나\n")
        self.write("docs/a.md", "a\n")
        head = self.commit("docs: a (#292)")
        self.assertEqual(self.run_bump(head), "1.4.1")
        self.assertTrue((self.root / "skills/orch/changes/bad.md").exists())

    def test_repository_manifest_and_changelog_agree(self):
        """저장소의 plugin.json version 이 X.Y.Z 이고 플러그인 CHANGELOG 의 첫 버전 절과 같다"""
        version = json.loads((ROOT / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        first = next(line for line in (ROOT / ".claude-plugin/CHANGELOG.md").read_text(encoding="utf-8").splitlines() if line.startswith("## "))
        self.assertTrue(first.startswith(f"## {version} ("), first)


if __name__ == "__main__":
    unittest.main()
