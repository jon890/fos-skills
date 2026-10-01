"""플러그인 매니페스트의 skills 배열이 루트의 스킬 디렉터리와 맞는지, 버전이 없는지 검증한다."""

import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / ".claude-plugin" / "plugin.json"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"


def skill_diff(array, root):
    """root 바로 아래에서 SKILL.md 를 가진 디렉터리와 array 를 비교해 (빠진 것, 남는 것) 을 돌려준다."""
    found = {f"./{child.name}" for child in Path(root).iterdir() if (child / "SKILL.md").is_file()}
    declared = set(array)
    return sorted(found - declared), sorted(declared - found)


def load(manifest):
    return json.loads(manifest.read_text(encoding="utf-8"))


class PluginManifestTest(unittest.TestCase):
    def test_array_matches_skill_directories(self):
        missing, extra = skill_diff(load(PLUGIN)["skills"], ROOT)
        self.assertEqual(([], []), (missing, extra), "배열에서 빠진 스킬과 디렉터리가 없는 항목이 있다")

    def test_array_is_sorted(self):
        skills = load(PLUGIN)["skills"]
        self.assertEqual(sorted(skills), skills)

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
