# CHANGELOG: report

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 2.0.0 (2026-11-06)

- 호환성: 검사 스크립트를 `check-report.py` 에서 Node 24 의 `check-report.ts` 로 바꿨다. `node "$SKILL_DIR/scripts/check-report.ts"` 로 부른다
- 옵션, 출력, 종료 코드는 그대로다. 이 스킬을 쓰려면 Node 24 이상이 필요하다

## 1.x

- layouts.md 와 겹치는 구성 선택, 본문 규칙 문장을 지우고 재시도 횟수를 한 곳에만 적었다
- 내보내기 전용 원본의 한국어 검사기를 새 배치에서 찾아요.
- 새 스킬. `/report` 나 「HTML 로 시각화해서 설명해 줘」 로 부르면 있는 내용을 HTML 보고서 한 파일로 만들어 기본 브라우저로 띄운다
