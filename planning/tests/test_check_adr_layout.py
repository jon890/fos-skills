import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check_adr_layout.py"


class CheckAdrLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "docs/adr").mkdir(parents=True)

    def write(self, name, text):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")

    def run_check(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.root,
                              text=True, capture_output=True)

    def test_accepted_partial_and_legacy_stay_in_root(self):
        self.write("docs/adr/001.md", "- **status**: `accepted`\n- **대체된 부분**: 일부\n")
        self.write("docs/adr/002.md", "# Legacy\n")
        self.write("docs/adr/superseded/003.md", "- **status**: `superseded`. explanation\n")
        self.assertEqual(self.run_check().returncode, 0)

    def test_superseded_root_with_trailing_explanation_is_violation(self):
        self.write("docs/adr/001.md", "- **status**: `superseded`. explanation\n")
        done = self.run_check()
        self.assertEqual(done.returncode, 1)
        self.assertIn("001.md: superseded ADR must be moved", done.stdout)

    def test_archive_rejects_accepted_and_missing_status_recursively(self):
        for status in ("- **status**: `accepted`", "# Legacy"):
            with self.subTest(status=status):
                self.write("docs/adr/superseded/nested/001.md", status)
                done = self.run_check()
                self.assertEqual(done.returncode, 1)
                self.assertIn("requires status superseded", done.stdout)

    def test_markdown_links_across_repo_and_reference_definitions(self):
        self.write("README.md", "[old](docs/adr/old.md#decision)\n")
        self.write("src/notes.md", "[old][adr]\n\n[adr]: ../docs/adr/missing.md \"title\"\n")
        self.write("docs/adr/current.md", "[old](superseded/missing.md)\n")
        done = self.run_check()
        self.assertEqual(done.returncode, 1)
        for expected in ("README.md:1:", "notes.md:3:", "current.md:1:"):
            self.assertIn(expected, done.stdout)

    def test_valid_encoded_links_queries_and_non_adr_links(self):
        self.write("docs/adr/superseded/old file.md", "- **status**: `superseded`\n")
        self.write("README.md", '[ok](<docs/adr/superseded/old%20file.md#decision>)\n'
                   '[ok](docs/adr/superseded/old%20file.md?raw=1)\n'
                   '[web](https://example.com/docs/adr/missing.md)\n'
                   '[root](/docs/adr/missing.md)\n[other](missing.md)\n[anchor](#missing)\n')
        done = self.run_check()
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_code_examples_do_not_count_as_status_or_links(self):
        self.write("docs/adr/current.md", "~~~md\n- **status**: `superseded`\n"
                   "[old](missing.md)\n~~~\n`[old](missing.md)`\n")
        self.assertEqual(self.run_check().returncode, 0)

    def test_custom_adr_path_and_explicit_repo_root(self):
        (self.root / "design/decisions").mkdir(parents=True)
        self.write("README.md", "[old](design/decisions/old.md)\n")
        done = self.run_check(str(self.root / "design/decisions"), "--repo-root", str(self.root))
        self.assertEqual(done.returncode, 1)
        self.assertIn("missing ADR link target", done.stdout)

    def test_absolute_adr_path_discovers_git_worktree_root(self):
        self.write(".git", "gitdir: unused\n")
        self.write("README.md", "[old](docs/adr/old.md)\n")
        done = subprocess.run([sys.executable, str(SCRIPT), str(self.root / "docs/adr")],
                              cwd=self.root.parent, capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn("README.md", done.stdout)

    def test_invalid_arguments_exit_two(self):
        for args in (("missing",), ("--unknown",), ("--repo-root", str(self.root / "docs/adr/superseded"))):
            with self.subTest(args=args):
                self.assertEqual(self.run_check(*args).returncode, 2)


if __name__ == "__main__":
    unittest.main()
