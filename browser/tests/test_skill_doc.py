"""browser 스킬 문서가 부르는 말, 소유 경계, 드라이버 경로를 잃지 않았는지 검증한다."""
import pathlib
import unittest

SKILL = pathlib.Path(__file__).resolve().parent.parent
TEXT = (SKILL / "SKILL.md").read_text(encoding="utf-8")
DESCRIPTION = " ".join(TEXT.split("description:", 1)[1].split("metadata:", 1)[0].split())


class SkillDocTest(unittest.TestCase):
    def test_description_has_trigger_phrases(self):
        for phrase in ("브라우저로", "콘솔에서", "웹 화면에서 확인", "화면으로 해야 하는 작업", "CLI 나 API 로 안 되는 작업"):
            self.assertIn(phrase, DESCRIPTION, phrase)

    def test_description_points_to_owners_instead_of_restating(self):
        self.assertIn("browser-driver help", DESCRIPTION)
        self.assertIn("tools/browser-driver/README.md", DESCRIPTION)
        self.assertIn("사람이 할 일", DESCRIPTION)

    def test_bundled_driver_path_resolves_from_skill_dir(self):
        """SKILL.md 의 `$SKILL_DIR/../tools/...` 후보가 저장소와 설치 캐시에서 실제 진입점을 가리키는지 본다."""
        self.assertIn('"$SKILL_DIR/../tools/browser-driver/browser_driver.py"', TEXT)
        self.assertTrue((SKILL.parent / "tools" / "browser-driver" / "browser_driver.py").is_file())

    def test_body_keeps_space_and_login_rules(self):
        for rule in ("BROWSER_EGO_SPACE", "BROWSER_EGO_PURPOSE=personal", "reset", "자격 증명을 넣지 않는다", ".claude/browser-overlay.md"):
            self.assertIn(rule, TEXT, rule)


if __name__ == "__main__":
    unittest.main()
