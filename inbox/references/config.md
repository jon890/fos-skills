# 설정, 상태, 저장소 필터

알림함을 켜거나 저장소마다 볼 알림을 나눌 때 읽는다. 설계 근거는 `docs/features/work-inbox/spec.md` 가 소유한다.

## 사람 단위 설정

`${XDG_CONFIG_HOME:-~/.config}/fos-skills/inbox.json` 이다. 이 파일이 없으면 알림함이 꺼지고 `/board` 에 알림 상자가 없다.

```json
{
  "adapters": [
    { "type": "dooray", "messenger": true, "webUrl": "https://nhnent.dooray.com" }
  ],
  "intervalMinutes": 5,
  "days": 7,
  "signature": "🤖 이 메시지는 AI가 작성했고, 작성자가 검토했습니다.",
  "defaultBoard": "/Users/me/work/main-repo"
}
```

| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `adapters` | 없음(필수) | 켤 adapter 목록. `type` 이 `scripts/adapters/index.ts` 의 이름 하나다 |
| `intervalMinutes` | 5 | 업무 도구에서 다시 받는 주기. 보드는 1분마다 묻지만 이 주기가 지나야 받는다 |
| `days` | 7 | 이보다 오래된 알림은 보이지 않는다. 두레이 피드는 최근 2주만 준다 |
| `signature` | AI 작성 표기 | 답변 끝에 붙인다. 빈 문자열이면 붙이지 않는다 |
| `defaultBoard` | 없음 | 어느 저장소 필터에도 들지 않은 「미분류」 알림을 목록으로 보일 저장소의 주 checkout 경로. 없으면 미분류도 모든 보드에 목록으로 보인다 |

두레이 adapter 의 키:

| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `messenger` | true | false 면 메신저 멘션을 읽지 않는다 |
| `webUrl` | 없음 | 업무 링크 앞부분. 없으면 보드에서 링크 없이 보인다 |

두레이 adapter 는 dooray CLI 의 인증을 쓴다. `dooray stream list` 명령이 있는 버전이 필요하다. 없으면 보드에 「두레이 업무 확인 불가」 가 보인다.

## 저장소 필터

그 저장소의 `<orch 폴더>/config/notification.json` 이다. orch 폴더는 주 checkout 의 `.orch` 이고 `ORCH_DIR` 이 있으면 그 값이다.
`.orch/` 를 git 이 무시하는지 확인한다. 무시하지 않으면 사내 프로젝트 id 가 커밋된다.

```json
{
  "dooray": {
    "projects": ["4360962059627319964", "AI-스마트홈-AI"],
    "channels": ["스마트홈 개발", "4401522693560154783"]
  }
}
```

- adapter 이름 아래의 목록 값 가운데 하나가 알림의 범위와 같으면 그 저장소의 알림이다. 두레이 업무는 프로젝트 id 나 코드, 메신저는 대화방 id 나 제목과 맞춘다.
- 파일이 없는 저장소의 보드는 모든 알림을 보인다.
- 그 저장소에서 Claude Code 세션이 열리면 보드 훅이 필터 파일 경로를 상태 폴더의 목록에 적는다. 이 목록이 미분류 판정에 쓰인다.

## 상태

`${XDG_STATE_HOME:-~/.local/state}/fos-skills/inbox/` 다. 사내 메시지 발췌가 들어 있어 폴더는 0700, 파일은 0600 으로 만든다.
지워도 다음 받기에서 다시 만든다. 넘김 기록(`dismissed.json`)과 출처별 커서(`last-ok.json`)는 함께 사라져, 다음 받기가 `days` 기간 전체를 다시 읽는다.
파일마다 담는 것은 `scripts/lib/store.ts` 머리 주석이 소유한다.

## Slack adapter 를 더할 때

1. `scripts/adapters/slack.ts` 에 `lib/model.ts` 의 `Adapter` 다섯 동작을 구현한다. 받기는 내 멘션 검색이나 Socket Mode, 맥락은 스레드 답글, 답변은 스레드에 보내기다.
2. `scripts/adapters/index.ts` 의 표에 `slack` 줄을 더한다.
3. 설정의 `adapters` 에 `{ "type": "slack" }` 을, 저장소 필터에 `"slack": { "channels": [...] }` 를 더한다.

보드, 요청문, `inbox.ts` 명령은 바뀌지 않는다. 보드의 머리말을 「Slack」 으로 바꾸려면 `work-board/hooks/register.js` 의 `inboxTag` 에 한 줄을 더한다.
