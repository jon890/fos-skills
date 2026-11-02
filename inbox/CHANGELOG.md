# CHANGELOG: inbox

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.0.1 (2026-11-02)

- 메신저 메시지의 text 가 `{"type":0,"text":…}` JSON 문자열로 오면 그 안의 글을 발췌와 본문에 쓴다. 원문 JSON 이 보이지 않는다

## 1.0.0 (2026-11-02)

- 두레이 업무 댓글 멘션, 담당·참조로 온 새 업무, 메신저 멘션을 공통 알림 모델로 모은다
- `inbox.ts` 의 board, fetch, list, context, reply, dismiss 명령. reply 는 `--yes` 없이 등록하지 않는다
- 답변 앞에 보낸 사람의 멘션을, 끝에 설정 `signature`(기본 AI 작성 표기)를 붙인다
- 저장소의 `.orch/config/notification.json` 필터로 보드마다 그 프로젝트의 알림만 보인다. 미분류는 `defaultBoard` 에 모은다
