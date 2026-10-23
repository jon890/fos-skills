"""orch/README.md 의 스크립트 목록이 orch/scripts/ 의 실제 파일과 어긋나지 않는지 본다."""

import tempfile
import unittest
from pathlib import Path

ORCH = Path(__file__).resolve().parents[1]
SUFFIXES = {".py", ".sh"}


def missing_from_readme(readme, scripts_dir):
    """README 에 `scripts/<이름>` 으로 적히지 않은 스크립트 파일 이름을 정렬해 돌려준다."""
    text = Path(readme).read_text()
    names = sorted(p.name for p in Path(scripts_dir).iterdir() if p.is_file() and p.suffix in SUFFIXES)
    return [name for name in names if f"`scripts/{name}`" not in text]


class ReadmeScriptListTest(unittest.TestCase):
    def test_every_script_is_listed_in_readme(self):
        missing = missing_from_readme(ORCH / "README.md", ORCH / "scripts")
        self.assertEqual([], missing, f"orch/README.md 에 없는 스크립트: {missing}")

    def test_unlisted_script_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "README.md").write_text("- `scripts/a.py`: 첫째\n")
            (root / "scripts" / "a.py").write_text("")
            (root / "scripts" / "b.sh").write_text("")
            self.assertEqual(["b.sh"], missing_from_readme(root / "README.md", root / "scripts"))

    def test_name_that_only_starts_like_a_listed_one_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "README.md").write_text("- `scripts/ab.py`: 둘째\n")
            (root / "scripts" / "a.py").write_text("")
            (root / "scripts" / "ab.py").write_text("")
            self.assertEqual(["a.py"], missing_from_readme(root / "README.md", root / "scripts"))

    def test_empty_scripts_dir_and_non_script_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "README.md").write_text("")
            self.assertEqual([], missing_from_readme(root / "README.md", root / "scripts"))
            (root / "scripts" / "notes.txt").write_text("")
            (root / "scripts" / "__pycache__").mkdir()
            self.assertEqual([], missing_from_readme(root / "README.md", root / "scripts"))


if __name__ == "__main__":
    unittest.main()
