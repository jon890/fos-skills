"""스킬 문서가 `$SKILL_DIR/scripts/<이름>` 과 상대 링크, 새 꼴 `orch <묶음> <동작>` 으로 부르는 스크립트가 모두 있는지 검증한다.
문서가 orch 스크립트를 옛 진입점이나 파일 경로로 부르지 않는지도 본다(docs/features/orch-cli/spec.md 의 REQ8).

문서만 고치고 스크립트를 빠뜨리거나 이름을 바꾸면, 설치한 쪽은 그 단계에서 「파일이 없다」 로 멈춘다.
판정은 `skills/orch/scripts/doctor/orch-doctor.ts --skip-version` 이 소유한다. 이 테스트는 스킬마다 그것을 부른다.
"""

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCTOR = ROOT / "skills" / "orch" / "scripts" / "doctor" / "orch-doctor.ts"
ORCH_SCRIPTS = ROOT / "skills" / "orch" / "scripts"
# 기록이라 옛 꼴이 남는 곳. 기능 문서, 변경 이력, ADR
SKIP = ("docs/features/orch-cli/", "skills/orch/CHANGELOG.md", "docs/adr/")


class DocScriptRefsTest(unittest.TestCase):
    def test_every_skill_has_the_scripts_its_docs_call(self):
        skills = sorted(p.parent for pattern in ("skills/*/SKILL.md", "export-only-skills/*/SKILL.md") for p in ROOT.glob(pattern))
        self.assertTrue(skills)
        for skill in skills:
            with self.subTest(skill=skill.name):
                done = subprocess.run(
                    ["node", "--disable-warning=ExperimentalWarning", str(DOCTOR), "--skip-version", "--skill-dir", str(skill)],
                    capture_output=True, text=True,
                )
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)


    def test_docs_call_orch_by_new_form(self):
        # 진입 스크립트는 묶음 폴더(scripts/<묶음>/) 아래에 있다. lib, handlers 는 진입 스크립트가 아니다
        entries = {p.stem for p in ORCH_SCRIPTS.glob("*/*.ts") if p.parent.name not in ("lib", "handlers")}
        self.assertIn("merge_queue", entries)
        names = sorted(entries | {p.stem for p in ORCH_SCRIPTS.glob("*.py")}, key=len, reverse=True)
        joined = "|".join(re.escape(n) for n in names)
        old = re.compile(
            rf'"\$SKILL_DIR/bin/orch\.ts"\s+[a-z_-]+|(?:\$SKILL_DIR|\$\{{?ORCH_SCRIPTS\}}?)/(?:scripts/)?(?:[a-z]+/)?(?:{joined})\.(?:ts|py)\b'
        )
        # 요청문은 Markdown 이 아니라 경로 꼴이 다르다(코디네이터에게 보내는 글)
        prompt = re.compile(rf"skills/orch/scripts/(?:[a-z]+/)?(?:{joined})\.ts|\b(?:{joined})\.ts 답장")
        files = [ROOT / "README.md", *ROOT.glob("skills/**/*.md"), *ROOT.glob("export-only-skills/**/*.md"), *ROOT.glob("docs/**/*.md"), *ROOT.glob("extensions/**/*.md")]
        found = []
        for path in files:
            rel = path.relative_to(ROOT).as_posix()
            if rel.startswith(SKIP) or "/tests/" in rel:
                continue
            rows = path.read_text(encoding="utf-8").splitlines()
            for i, row in enumerate(rows):
                if "orch-compat" in row or (i > 0 and "orch-compat" in rows[i - 1]):
                    continue
                if old.search(row):
                    found.append(f"{rel}:{i + 1}: {row.strip()[:120]}")
        register = ROOT / "extensions" / "work-board" / "hooks" / "register.js"
        for i, row in enumerate(register.read_text(encoding="utf-8").splitlines()):
            if row.lstrip().startswith("'") and prompt.search(row):
                found.append(f"{register.relative_to(ROOT).as_posix()}:{i + 1}: {row.strip()[:120]}")
        self.assertEqual([], found, "orch 는 `orch <묶음> <동작>` 으로 부른다. 호환 설명이면 그 줄이나 윗줄에 orch-compat 를 둔다")


if __name__ == "__main__":
    unittest.main()
