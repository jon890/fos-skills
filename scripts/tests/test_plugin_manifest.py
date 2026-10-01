"""내보내기 전용 원본을 제외한 스킬 디렉터리와 매니페스트를 대조하고 버전이 없는지 검증한다."""

import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / ".claude-plugin" / "plugin.json"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"
EXPORT_ONLY = set(json.loads((ROOT / "scripts" / "export-only-skills.json").read_text(encoding="utf-8")))


def skill_diff(array, root):
    """내보내기 전용 원본을 제외하고 array 와 비교해 (빠진 것, 남는 것) 을 돌려준다."""
    found = {f"./{child.name}" for child in Path(root).iterdir() if (child / "SKILL.md").is_file()}
    declared = set(array)
    expected = found - EXPORT_ONLY
    return sorted(expected - declared), sorted(declared - expected)


def load(manifest):
    return json.loads(manifest.read_text(encoding="utf-8"))


class PluginManifestTest(unittest.TestCase):
    def test_array_matches_skill_directories(self):
        missing, extra = skill_diff(load(PLUGIN)["skills"], ROOT)
        self.assertEqual(([], []), (missing, extra), "배열에서 빠진 스킬과 디렉터리가 없는 항목이 있다")

    def test_array_is_sorted(self):
        skills = load(PLUGIN)["skills"]
        self.assertEqual(sorted(skills), skills)

    def test_export_only_sources_are_present(self):
        for skill in EXPORT_ONLY:
            self.assertTrue((ROOT / skill / "SKILL.md").is_file(), skill)

    def test_export_only_sources_are_not_registered(self):
        self.assertTrue(EXPORT_ONLY.isdisjoint(load(PLUGIN)["skills"]))

    def test_export_only_sources_can_be_omitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("a", "content-preview", "korean-check"):
                (root / name).mkdir()
                (root / name / "SKILL.md").write_text("")
            self.assertEqual(([], []), skill_diff(["./a"], root))
            self.assertEqual((["./a"], []), skill_diff([], root))
            registered_export_source = ["./a", "./content-preview"]
            self.assertEqual(([], ["./content-preview"]), skill_diff(registered_export_source, root))

    def test_missing_skill_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("a", "b"):
                (root / name).mkdir()
                (root / name / "SKILL.md").write_text("")
            self.assertEqual((["./b"], []), skill_diff(["./a"], root))

    def test_unknown_skill_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("a", "b"):
                (root / name).mkdir()
                (root / name / "SKILL.md").write_text("")
            self.assertEqual(([], ["./c"]), skill_diff(["./a", "./b", "./c"], root))

    def test_no_version_key(self):
        marketplace = load(MARKETPLACE)
        self.assertNotIn("version", load(PLUGIN))
        self.assertNotIn("version", marketplace)
        self.assertNotIn("version", marketplace["plugins"][0])

    def test_name_and_source(self):
        marketplace = load(MARKETPLACE)
        self.assertEqual("fos-skills", marketplace["name"])
        self.assertEqual("fos-skills", marketplace["plugins"][0]["name"])
        self.assertEqual("fos-skills", load(PLUGIN)["name"])
        self.assertEqual("./", marketplace["plugins"][0]["source"])

    def test_author_name_present(self):
        self.assertTrue(load(PLUGIN)["author"]["name"])


if __name__ == "__main__":
    unittest.main()
