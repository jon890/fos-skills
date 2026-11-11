# adapter 를 더할 때 바뀌는 곳

업무 알림함에 새 도구를 붙일 때 고치는 곳이다. 아래는 Slack 을 더하는 경우다.

1. `skills/inbox/scripts/adapters/slack.ts` 에 `lib/model.ts` 의 `Adapter` 동작을 구현한다. 받기는 내 멘션 검색이나 Socket Mode, 맥락은 스레드 답글, 답변은 스레드에 보내기다.
2. `skills/inbox/scripts/adapters/index.ts` 의 표에 `slack` 줄을 더한다.
3. 설정의 `adapters` 에 `{ "type": "slack" }` 을, 저장소 필터에 `"slack": { "channels": [...] }` 를 더한다.

보드, 요청문, `inbox.ts` 명령은 바뀌지 않는다. 보드의 머리말을 「Slack」 으로 바꾸려면 `extensions/work-board/hooks/register.js` 의 `inboxTag` 에 한 줄을 더한다.
