"""스킬 문서의 rm -rf 예시가 빈 변수 방지 형식(${VAR:?})을 쓰는지 검증한다. 문서 텍스트만 읽는다."""

import re
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]

# rm -rf 뒤의 대상이 $ 로 시작하는지 본다. 따옴표는 한 번만 허용한다.
RM_TARGET = re.compile(r'\brm -rf\s+"?(\$[^\s"]*)')
# ${VAR:?} 로 시작하면 변수가 비었을 때 셸이 멈춘다.
GUARDED = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*:\?\}")


def unguarded_rm_targets(text):
    """코드 블록 안의 rm -rf 대상 중 ${VAR:?} 형식이 아닌 변수 대상을 (줄 번호, 줄) 목록으로 돌려준다."""
    found = []
    in_block = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.startswith("```"):
            in_block = not in_block
            continue
        if not in_block:
            continue
        for match in RM_TARGET.finditer(line):
            if not GUARDED.match(match.group(1)):
                found.append((number, line.strip()))
    return found


class RmGuardDocsTest(unittest.TestCase):
    def test_skill_docs_use_guarded_rm_targets(self):
        docs = [SKILL_DIR / "SKILL.md", *sorted((SKILL_DIR / "references").glob("*.md"))]
        violations = []
        for doc in docs:
            for number, line in unguarded_rm_targets(doc.read_text(encoding="utf-8")):
                violations.append(f"{doc.relative_to(SKILL_DIR)}:{number}: {line}")
        self.assertEqual([], violations)


class RmGuardCheckTest(unittest.TestCase):
    def test_flags_unguarded_variable_in_code_block(self):
        text = '```bash\nrm -rf "$DIR"\n```\n'
        self.assertEqual([(2, 'rm -rf "$DIR"')], unguarded_rm_targets(text))

    def test_flags_unguarded_home_and_path_suffix(self):
        text = '```bash\nrm -rf "$HOME/Library/Cache"\nrm -rf $RELEASE\n```\n'
        self.assertEqual(2, len(unguarded_rm_targets(text)))

    def test_accepts_guarded_variable(self):
        text = '```bash\nrm -rf "${DIR:?}"\nrm -rf "${HOME:?}/Library/Application Support/Cursor/snapshots"\n```\n'
        self.assertEqual([], unguarded_rm_targets(text))

    def test_accepts_literal_absolute_and_home_paths(self):
        text = "```bash\nrm -rf /Users/me/tmp/out\nrm -rf ~/.cache/foo\n```\n"
        self.assertEqual([], unguarded_rm_targets(text))

    def test_ignores_prose_outside_code_block(self):
        text = '본문에서 `rm -rf "$DIR"` 를 언급한다.\n'
        self.assertEqual([], unguarded_rm_targets(text))


if __name__ == "__main__":
    unittest.main()
