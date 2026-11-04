"""check_facts.py 가 고유어 수사로 쓴 개수를 잡고, 개수가 아닌 표현은 잡지 않는지 검증한다.

스크립트는 import 할 때 sys.argv 를 읽으므로 하위 프로세스로 부른다.
"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_facts.py"

COUNTED = [
    "가장 큰 함정은 둘이다",
    "확인한 것은 셋이다",
    "서식은 D055, D056, D059, D075, D091, D103 여섯 가지다",
    "## 일곱 단계",
    "요청 구분은 다섯이다",
    "입력할 것은 세 항목이다",
    "상태 체크박스 다섯 개",
    "플러그인은 둘이다",
    "스킬 넷",
    "스킬은 둘, 검사는 셋이다",
    "대상은 스킬 넷.",
    "서식은 16개다",
    "검사 5개를 돌린다",
]
NOT_COUNTED = [
    "둘 다 맞다",
    "둘째 항목을 본다",
    "셋째 줄을 고친다",
    "하나씩 확인한다",
    "한 번 돌린다",
    "두 번 돌린다",
    "세 번째 단계다",
    "인터넷 연결을 확인한다",
    "표를 상위 불릿 아래에 둘 때는 들여쓴다",
    "업무가 둘 이상이면 목록으로 나눈다",
    "계정은 irteam 과 irteamsu 둘 다가 기본이다. 대상자는 특정한다",
    "본문과 미리보기를 둘 자리를 하나 정해 담는다.",
    "`SP` 는 payload 와 미리보기를 둘 실행별 임시 디렉터리다.",
    "여섯 달 뒤 이 코드를 처음 보는 사람이 무엇을 알아야 하는지로 판단한다.",
    "둘 다는 아니다",
    "셋 다를 확인한다",
    "일곱 번 돌린다",
    "세 번 돌린다",
]


class CheckFactsTest(unittest.TestCase):
    def count_section(self, sentence):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "CLAUDE.md").write_text(f"# 지침\n\n{sentence}\n")
            done = subprocess.run(
                [sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True
            )
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        section = done.stdout.split("## 개수 표기")[1].split("##")[0]
        return section

    def test_counted_sentences_are_reported(self):
        for sentence in COUNTED:
            with self.subTest(sentence=sentence):
                self.assertIn("CLAUDE.md:3", self.count_section(sentence))

    def test_non_count_expressions_are_not_reported(self):
        for sentence in NOT_COUNTED:
            with self.subTest(sentence=sentence):
                section = self.count_section(sentence)
                self.assertIn("없음", section)
                self.assertNotIn("CLAUDE.md:3", section)


if __name__ == "__main__":
    unittest.main()
