# CHANGELOG: presentation

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 2.0.0 (2026-11-06)

- 호환성: 검사 스크립트를 `check-deck.py` 에서 Node 24 의 `check-deck.ts` 로 바꿨다. `node "$SKILL_DIR/scripts/check-deck.ts"` 로 부른다
- 옵션, 출력, 종료 코드는 그대로다. 전역 금지어는 korean-check 검사기를 자식 프로세스로 불러 읽는다. 이 스킬을 쓰려면 Node 24 이상이 필요하다

## 1.x

- 혼자 읽는 HTML 보고서는 `report` 스킬이 설치돼 있으면 그쪽이 맡는다는 경계를 description 과 README 에 더했다
- 목표 줄을 더하고 관측 문장, 개수 표기, 끝의 참조 표를 지웠다
- 문서 감사 스킬 참조를 새 이름 `docs-audit` 로 맞췄어요.
- 검사 명령을 번들 경로로 불러 덱이 있는 디렉터리에서도 돈다
- 새 스킬 배치에서 한국어 검사기와 브라우저 도구를 찾아요.
- 문서 표현만 고쳤다. 동작은 바뀌지 않았다
- 개인 로컬에서 fos-skills 플러그인으로 올렸다. 설치하면 `presentation` 스킬이 뜬다
- 스킬 안의 절대경로 다섯을 번들 상대경로로 바꿨다
