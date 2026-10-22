# work-board

저장소의 작업 현황을 Claude Code 창으로 본다. 코디네이터(에이전트)가 상태를 갱신하고, 사람은 `/board` 로 본다.

- 창: `/board`. 결정 필요, 진행 중, 대기, 완료 순으로 묶는다. `d` 로 완료를 펼친다
- 오늘 시작: 창의 `오늘 시작`(`s`) 이나 `/board-start`. 코디네이터에게 「board 를 오늘 기준으로 갱신하고 완료를 비우기, 현재 저장소의 워크트리·세션·브랜치 정리, orchestration 감시 확인, 막힌 것과 정할 것 보고」 요청을 보낸다
- 상태 줄: 프롬프트 아래에 개수 요약이 5초마다 갱신된다. 파일이 없는 저장소에서는 나오지 않는다
- 파일: git 루트의 `.omc/board.json` (예전 위치 `.omc/handoffs/board.json` 도 읽는다)
- 항목: 제목, 담당·PR, 하위 항목(details), 다음 할 일(next), 워크트리(worktree)
- 워커: `orca orchestration worker-list` 를 15초마다 읽어 항목의 worktree 와 같은 이름의 워커 상태를 붙인다. 이 저장소에서 돌지만 어느 항목에도 없는 워커는 「항목에 없는 워커」 로 모은다
- 단계 줄: 번호로 시작하는 줄이다(「1 …」, 「1. …」, 「1) …」). 앞의 「✓」 나 「[x]」 는 끝낸 단계, 「[ ]」, 「▶」, 「◇」 는 끝나지 않은 단계다. 번호로 시작하지 않는 참고 줄은 세지 않는다
- 진행률: 하위 항목(details)의 단계 줄을 세고, details 에 단계가 없으면 다음 할 일(next)의 줄을 센다. 단계가 없으면 그리지 않는다. `progress` 필드(「7/10」)가 있으면 그 값이 우선한다. 단계로 나타낼 수 없을 때만 쓴다
- 단계 끝내기: `board.py step <id> <n>` 이 진행률을 세는 줄에서 n 번 단계를 끝낸다. 「[ ]」 는 「[x]」 로 바꾸고 그 밖의 줄은 앞에 「✓ 」 를 붙인다(`--undo` 로 되돌린다). `set --progress auto` 는 `progress` 값을 지워 단계 수로 세게 한다
- 갱신: `python3 "$BOARD_BIN" set <id> doing --title "..." --next "..."`. `$BOARD_BIN` 은 이 디렉터리의 `bin/board.py` 다

## 설치와 갱신

fos-skills 플러그인의 구성 요소로 함께 실린다. `plugin.json` 의 `hooks` 배열이 `work-board/hooks/hooks.json` 을 가리킨다.
갱신은 다른 스킬과 같다. main 에 머지한 뒤 `claude plugin update fos-skills@fos-skills` 와 `/reload-plugins` 를 한다.
고치는 동안은 저장소 루트의 README 「고치는 동안」 대로 작업 트리를 `--plugin-dir` 로 싣는다.
테스트는 저장소 루트에서 `claude plugin test .` 로 돈다.

옮겨 온 배경과 기존 `~/.claude/mods/work-board` 를 끄는 순서는 [ADR-006](../docs/adr/006-work-board-in-plugin.md) 이 소유한다.
