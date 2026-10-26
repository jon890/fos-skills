# work-board

저장소의 작업 현황을 Claude Code 창으로 본다. 코디네이터(에이전트)가 상태를 갱신하고, 사람은 `/board` 로 본다.

- 창: `/board`. 결정 필요, 진행 중, 대기, 완료 순으로 묶는다
- 접힌 보기: 항목마다 「표시 · 제목」 한 줄, 그 아래 막대 한 줄, 「▶ 지금 단계」 한 줄, worker 가 있으면 worker 한 줄만 보인다. 끝낸 단계는 「✓ n개」, 지금 단계 뒤에 남은 단계는 「남은 단계 n개」 로 접힌다. 수는 막대와 같은 값에서 낸다(진행률을 세는 쪽의 단계 줄, `progress` 가 있으면 그 값)
- 펼친 보기: `d` 를 누르면 담당·PR, details 와 next 의 모든 줄을 적힌 순서대로 보이고 완료 칸도 펼친다. 끝낸 줄은 취소선과 흐림, 지금 단계는 굵게, 남은 단계는 보통 글씨, 번호 없는 참고 줄은 흐리게 보인다. 다시 누르면 접힌다
- 단계 줄 모양: details 와 next 의 모든 줄이 같은 들여쓰기와 두 칸짜리 표시 칸(끝냄 「✓」, 지금 「▶」, 남음과 참고 줄은 빈칸)을 갖는다. `done` 값으로 표시를 정해 번호와 본문이 같은 열에서 시작하고, 줄바꿈된 뒷줄도 본문 열에서 시작한다
- 지금 단계: 진행률을 세는 쪽(아래 「진행률」)의 끝나지 않은 첫 단계 줄이다. 거기 없으면 다른 쪽의 끝나지 않은 첫 단계, 단계 줄이 하나도 없으면 첫 참고 줄을 쓴다. 단계가 모두 끝났으면 지금 단계는 없다
- 오늘 시작: 창의 `오늘 시작`(`s`) 이나 `/board-start`. 코디네이터에게 「board 를 오늘 기준으로 갱신하고 완료를 비우기, 현재 저장소의 워크트리·세션·브랜치 정리, orchestration 감시 확인, 막힌 것과 정할 것 보고」 요청을 보낸다
- 상태 줄: 프롬프트 아래에 개수 요약이 5초마다 갱신된다. 파일이 없는 저장소에서는 나오지 않는다
- 파일: git 루트의 `.omc/board.json` (예전 위치 `.omc/handoffs/board.json` 도 읽는다)
- 항목: 제목, 담당·PR, 하위 항목(details), 다음 할 일(next), 워크트리(worktree)
- 워커: `orca orchestration worker-list` 를 주기적으로 읽어 항목의 worktree 와 같은 이름의 워커 상태를 붙인다. 이 저장소에서 돌지만 어느 항목에도 없는 워커는 「항목에 없는 워커」 로 모은다
- 결정 필요: 현재 Run 의 `check --all` 과 `--peek` 에 `--types question,escalation` 을 붙여 질문 후보를 모으고, 살아 있는 발신자별 `inbox --terminal` 에서 코디네이터 답변 thread 를 확인한다. 질문의 dispatch 는 `payload.dispatchId`, 없으면 발신자 handle 의 `dispatch:` 접두사로 정하고, 둘 다 없으면 발신 터미널 handle 을 `worker-list` 의 `agentTerminalHandle` 과 대조한다. `dispatched` 인 worker 에 속하지 않는 질문은 후보에서 뺀다. 그 질문은 다른 경로로 처리됐고, 닫힌 dispatch 의 inbox 에는 답변이 남지 않아 답해도 줄지 않기 때문이다. `worker-list` 를 읽지 못하면 질문도 「확인 불가」 로 보인다. 답하면 다음 조회에서 줄고, ack 만 하면 남는다. 수동 `decide` 항목도 더한다. 전체 inbox 는 읽지 않는다
- 질문 조회 범위: Orca 의 `--all` 과 `--peek` 는 각각 100건까지 반환한다. 상한에 닿으면 「최근 질문 기준」 을 표시하며, 그 밖의 미답변은 빠질 수 있다. 발신자의 수신 기록은 200건까지 조회하고, 상한 때문에 답변 여부를 판단할 수 없으면 조회 오류를 표시한다
- 명령 출력 한도: Claude Code 2.1.309 의 `$.process.run` 은 stdout 과 stderr 를 각각 4MiB(4,194,304바이트)에서 자른다. 설치 실행 파일의 `Hat=4194304`, `Bat` 수집기와 `VQr` 반환값으로 확인했다. 보드는 `isStdoutTruncated` 를 검사해 잘린 JSON 대신 출력 한도 오류를 표시한다
- 단계 줄: 번호로 시작하는 줄이다(「1 …」, 「1. …」, 「1) …」). `done: true` 는 끝낸 단계, `done: false` 는 끝나지 않은 단계다. 번호로 시작하지 않는 참고 줄은 세지 않는다
- 진행률: 하위 항목(details)의 단계 줄을 세고, details 에 단계가 없으면 다음 할 일(next)의 줄을 센다. `progress` 필드(「7/10」)가 있으면 그 값이 우선한다. 단계로 나타낼 수 없을 때만 쓴다
- 진행률 표시: 창 맨 위에 진행 중 항목들의 끝낸 단계 합 / 전체 단계 합을 전체 막대로 그린다. 완료가 아닌 항목마다 제목 바로 아래 줄에 막대를 그리고(제목 길이와 상관없이 같은 자리), 진행률이 없는 옛 항목은 「진행률 없음」 으로 보인다. `board.ts list` 도 항목마다 「n/m (p%)」 를 붙인다
- 진행률 필수: `board.ts set` 은 doing 항목에 단계 줄이나 `--progress N/M` 이 없으면 거절하고 보드를 고치지 않는다. `--next` 를 여러 번 주면 줄로 이어 단계 줄을 적을 수 있다
- 단계 끝내기: `board.ts step <id> <n>` 이 진행률을 세는 줄에서 n 번 단계를 끝낸다. `done` 값만 `true` 로 바꾼다(`--undo` 는 `false`). `set --progress auto` 는 `progress` 값을 지워 단계 수로 세게 한다. `board.ts steps <id>` 는 진행률을 세는 단계 줄을 JSON 으로 낸다. orch 의 `board-sync.ts` 가 이것으로 단계를 판정한다
- 갱신: `node --disable-warning=ExperimentalWarning "$BOARD_BIN" set <id> doing --title "..." --next "..."`. `$BOARD_BIN` 은 이 디렉터리의 `bin/board.ts` 다

## 저장 형식

`next` 와 `details` 는 줄마다 `text` 와 불리언 `done` 을 가진 객체의 목록이다. 번호 없는 참고 줄도 같은 형식으로 저장하지만 진행률에는 세지 않는다.

```json
{
  "id": "example",
  "status": "doing",
  "next": [{"text": "2. 리뷰", "done": false}],
  "details": [
    {"text": "1. 구현", "done": true},
    {"text": "2. 리뷰", "done": false},
    {"text": "참고: 배포는 별도", "done": false}
  ]
}
```

`set --next/--detail` 은 계속 글을 받는다. 입력 줄 앞의 `✓`, `[x]`, `[X]` 는 `done: true` 로 읽고, `[ ]`, `▶`, `◇` 는 `done: false` 로 읽는다. 표시는 `text` 에서 떼며 창이 체크 표시와 취소선을 그린다.

옛 `next` 문자열과 `details` 문자열 목록은 읽을 때 객체로 변환한다. 객체와 문자열을 섞은 파일도 읽는다. `list` 와 `steps` 는 파일을 고치지 않고, 다음 쓰기 명령에서 모든 항목을 새 형식으로 저장한다. `steps` 출력은 `[{"number": 1, "done": true, "text": "1. 구현"}]` 이며 `text` 에 완료 표시는 없다.

## 설치와 갱신

fos-skills 플러그인의 구성 요소로 함께 실린다. `plugin.json` 의 `hooks` 배열이 `work-board/hooks/hooks.json` 을 가리킨다.
갱신은 다른 스킬과 같다. main 에 머지한 뒤 `claude plugin update fos-skills@fos-skills` 와 `/reload-plugins` 를 한다.
고치는 동안은 저장소 루트의 README 「고치는 동안」 대로 작업 트리를 `--plugin-dir` 로 싣는다.
테스트는 저장소 루트에서 `claude plugin test .` 로 돈다.

옮겨 온 배경과 기존 `~/.claude/mods/work-board` 를 끄는 순서는 [ADR-006](../docs/adr/006-work-board-in-plugin.md) 이 소유한다.
