# CHANGELOG: browser

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.1.0 (2026-11-05)

- 설명에 `ego-browser` 스킬과의 경계를 더해 웹 작업이 이 스킬로 먼저 오게 했다

## 1.0.1 (2026-11-04)

- 새 스킬 배치에서도 함께 설치한 브라우저 도구를 찾아요.

## 1.0.0 (2026-11-03)

- 새 스킬. 「브라우저로」, 「콘솔에서」, 「CLI 나 API 로 안 되는 작업」 으로 부르면 browser-driver 로 웹 작업을 끝낸다
- CLI 와 공개 API 를 먼저 보고, 「사람이 할 일」 로 넘기기 전에 브라우저로 할 수 있는지 본다
- 작업마다 `BROWSER_EGO_SPACE` 로 공간을 열고 실패해도 `reset` 으로 닫는다. 로그인 화면에서 멈추고 되돌리기 어려운 버튼은 확인받는다
- 저장소의 `.claude/browser-overlay.md` 를 먼저 읽고, 새로 안 화면 순서와 함정을 작업 직후 더한다
- 하위 에이전트와 worker 에게 넘길 지시 문구를 `references/delegation.md` 에 둔다
