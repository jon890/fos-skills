# `board.ts` 잠금과 새 동작 인수 검증 계획

이 PR 은 `board.ts` 쪽만 만든다. 스펙의 인수 조건 가운데 `orch board` 명령으로 관측하는 것(한 줄 출력, 워크트리에서 부르기)은 뒤 PR 이 맡고, 여기서는 그 명령이 부를 `board.ts` 호출로 같은 규칙을 관측한다.

준비: 임시 폴더에 `board.json` 을 만들고 아래 함수로 부른다. 모든 호출에 `--file <임시 보드>` 를 붙인다. 「바이트가 같다」 는 부르기 전후의 `shasum` 이 같은 것이다.

```bash
BOARD="$PWD/extensions/work-board/bin/board.ts"
b() { node --disable-warning=ExperimentalWarning "$BOARD" "$@"; }
```

명령을 변수에 담아 부르지 않는다. zsh 는 따옴표 없는 변수를 낱말로 나누지 않아 명령을 찾지 못한다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ3 | 단계가 `1. 구현`, `2. 리뷰`, `3. 머지` 인 항목 `a` | `b step a 9 --exact` | 종료 코드 1, stderr 에 「9 번 단계가 없다. 있는 번호: 1 2 3」, 보드 바이트가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ3 | `2. 리뷰` 줄이 둘인 항목 | `b step a 2 --exact` 와 `b step-edit a 2 '2. 다시'` | 둘 다 종료 코드 1, 보드 바이트가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ4 | 9번 줄이 끝나지 않은 항목과 끝난 항목 | `b step-edit a 9 '9. 머지 확인'` | 그 줄 글만 바뀌고 끝냄 값이 그대로다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ4 | 같은 항목 | `b step-edit a 9 '10. 머지'` | 종료 코드 1, 보드 바이트가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ4 | `9. 머지 (#1455 merge)` 줄이 있는 항목 | `b step-edit a 9 '9. 머지 확인'` | 종료 코드 1, 꼬리표가 남아 있다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ4 | 단계가 `next` 에만 있는 항목 | `b step-edit a 1 '1. 새 글'` | `next` 의 줄이 바뀐다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ4 | 줄이 하나 남은 `decide` 항목 | `b step a 1 --exact` | stdout JSON 이 `status` `done`, `was` `decide` 다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ5 | 단계가 1~9번인 `doing` 항목 | `b step-add a '리뷰 반영'`, 이어서 `b step-add a '9. 중복'` | 첫 호출이 `10. 리뷰 반영` 을 끝나지 않은 줄로 더하고 JSON 의 `number` 가 10 이다. 둘째는 종료 코드 1 이다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ5 | 단계가 `next` 에만 있는 항목, `done` 항목, `progress` 가 `2/5` 인 항목 | 각각 `b step-add <id> '글'` | `next` 에 더해진다. `done` 은 종료 코드 1. `progress` 항목은 종료 코드 0 이고 stderr 에 알림 한 줄 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ6 | 단계가 있는 항목 | `b step-add a '저장소 주소 변경 PR' --event '1455 merge'`, `b step-add a '둘째' --event '#1456 merge'`, `b step-add a '셋째' --event '1455 build'` | 앞 둘은 `N. 글 (#1455 merge)`, `N. 둘째 (#1456 merge)` 를 더한다. 셋째는 종료 코드 1 이고 보드 바이트가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ6 | 위에서 더한 `(#1455 merge)` 줄 | `b step-edit a <번호> '<번호>. 주소 변경' --event '1460 merge'` | 꼬리표가 겹치지 않고 `(#1460 merge)` 하나로 바뀐다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ7 | 항목 `a` 만 있는 보드 | `b set nope doing --exact` | 종료 코드 1, stderr 「항목이 없다」, 항목이 생기지 않는다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ7 | 단계 줄이 없는 항목 | `b set a doing --exact` 와 `b set a doing` | 둘 다 종료 코드 1 이고 stderr 가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ8 | 항목 `a` | `b set a wait --exact`, `b step a 1 --exact`, `b step-add a '글'` 의 stdout | 각각 JSON 한 줄이고 `id`, `status`, `was`, `progress`, `rev`, `lines` 가 있다. `step` 과 `step-add` 는 `number` 가 있다. 같은 호출을 `--exact` 없이 부르면(`set`, `step`) stdout 이 비어 있다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ9 | 단계 3개 중 1개를 끝내고 참고 줄이 하나 있는 항목 | `b view a` | JSON 의 `progress` 가 `[1, 3]`, 참고 줄의 `number` 가 `null`, 보드 바이트가 같다. 없는 id 는 종료 코드 1 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ11 | 빈 보드 | 서로 다른 id 로 `b set <id> wait` 12개를 함께 띄운다(`&` 와 `wait`) | 모두 종료 코드 0, 보드에 12개 항목이 모두 있고 잠금 파일이 없다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ11 | `touch <보드>.lock` 으로 만든 새 잠금 파일 | `time b set a wait`(환경 변수 없이) | 5초쯤 뒤 종료 코드 1, stderr 에 잠금 파일 경로, 보드 바이트가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ11 | 40초 전 시각으로 옮긴 잠금 파일(`touch -t` 나 `utimes`) | `b set a wait` | 종료 코드 0, 항목이 생기고 잠금 파일이 없다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ11 | 단계가 둘인 항목 `a` | `b view a` 로 `rev` 를 읽는다. `b detail-edit a 1 '1. 바꾼 글'` 뒤 `b set a --detail '1. 구현' --detail '2. 리뷰' --if-rev <읽어 둔 rev>` | 통째 저장이 종료 코드 1 이고 「1. 바꾼 글」 이 남아 있다. 지금 `rev` 로 다시 부르면 종료 코드 0 이다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ3 | `9.머지`(번호 뒤 공백 없음) 줄과 `1. 구현` 줄이 있는 항목 | `b step a 9 --exact` | 종료 코드 1, stderr 에 「9 번 단계가 없다. 있는 번호: 1」. 그 줄은 단계 줄이 아니다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ4 | 사람이 직접 쓴 `2. [merge] 머지` 줄이 있는 항목 | `b step-edit a 2 '2. 머지'`, 이어서 `b step-edit a 2 '2. [merge] develop 머지'` | 첫 호출은 종료 코드 1 이고 줄이 그대로다. 둘째는 종료 코드 0 이다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ6 | 단계가 있는 항목 | `b step-add a '넷째' --event '0 merge'` | 종료 코드 1, 보드 바이트가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ6 | `stages` 가 `pr=1,merge=2` 인 항목 | `b step-add a '확인' --event '1455 merge'` | 종료 코드 0, 줄이 더해지고 stderr 에 `stages` 단계가 저절로 끝나지 않게 된다는 한 줄이 나온다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ8 | 항목 `a` | `b mark a 1 --exact`, `b set a wait --event '1 merge'`, `b step a 1 --if-rev x` | 모두 종료 코드 2 이고 stderr 가 「사용법: board.ts」 로 시작한다. 보드 바이트가 같다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ11 | 다른 표지의 새 잠금 파일이 있는 빈 보드 | `BOARD_LOCK_WAIT_MS=3000 b set y wait &` 로 띄우고, 1초 뒤 보드 파일에 항목 `x` 를 직접 쓴 다음 잠금 파일을 지우고 `wait` 한다 | 종료 코드 0 이고 보드에 `x` 와 `y` 가 모두 있다(읽기가 잠금 안에서 일어난다) | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ13 | 이 PR 의 브랜치 | `git diff --exit-code origin/main -- extensions/work-board/tests/board.spec.ts` 와 `node scripts/run-tests.ts extensions/work-board/tests/board.spec.ts` | 차이가 없고 테스트가 통과한다 | 로컬 작업 트리 | worker | 없음 | PR 전 |
| REQ13 | 이 PR 의 브랜치 | `node scripts/run-tests.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/board-release.spec.ts skills/orch/tests/goal-progress.spec.ts skills/orch/tests/lib-board.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/launch-worker.spec.ts` 와 `node skills/orch/tests/fixtures/golden-run.ts` | orch 테스트와 고정 입력 기록을 고치지 않은 채 통과한다 | 로컬 작업 트리 | worker | 없음 | PR 전 |
| REQ13 | 항목 `a` 가 있는 보드 | `b set a wait --s pr=1,merge=2 --o me` | 종료 코드 0 이고 `stages`, `owner` 가 들어간다(새 옵션이 줄임 꼴을 모호하게 만들지 않았다) | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ13 | 새 동작으로 고친 보드와 `set` 으로 고친 보드 | 두 파일의 꼴을 본다 | 둘 다 들여쓰기 한 칸이고 끝 줄바꿈이 없다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
