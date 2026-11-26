# /board 창을 세션을 시작한 저장소에 고정한다

확인: 2026-11-26

## 목표

`/board` 창은 Claude 를 띄운 폴더의 저장소(이하 시작 저장소)의 보드, 열린 PR, 업무 알림, 승인 대기를 보여 준다.
세션 도중 명령이 다른 저장소로 작업 폴더를 옮겨도 창이 다른 저장소의 것으로 바뀌지 않는다.

지금은 창이 세션의 현재 작업 폴더(`extensions/work-board/hooks/register.js` 의 `boardRoot`, `$.session.cwd()`)를 따라간다.
홈 저장소(`/Users/nhn`)에서 연 세션이 조사하려고 `cd /Users/nhn/projects/ai-analysis` 를 돌리자, 창이 ai-analysis 의 `.omc/board.json` 을 보여 줬다(사용자 보고 2026-11-26).
같은 저장소의 워크트리로 옮기는 경우는 지금도 주 checkout 의 보드로 묶인다(`git rev-parse --git-common-dir`).

## 범위

이번 범위:

- 창이 읽는 기준 저장소를 시작 저장소로 고정한다. 보드, 열린 PR 과 PR 링크, 업무 알림과 알림 숨기기, 승인 대기와 승인 누르기, 머지 큐 줄, 피드백 수가 모두 이 기준을 쓴다.
- `/clear`, 대화 압축, 플러그인 갱신(`/reload-plugins` 포함)으로 창 코드가 다시 시작해도 같은 기준을 쓴다.

범위 밖:

- 한 세션에서 다른 저장소의 보드로 바꾸는 명령이나 설정.
- 작업 폴더가 다른 저장소로 옮겨 갔다는 표시.
- `orch board`, `board.ts` 같은 명령줄 도구의 보드 파일 고르기. 이 도구들은 지금처럼 부른 폴더나 `--repo` 기준이다.
- worker 목록과 결정 필요 상자. 이미 작업 폴더가 아니라 코디네이터 터미널에 묶인 Run 을 읽는다.

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | 다른 저장소로 옮겨도 창은 시작 저장소를 보인다 | 저장소 A 에서 띄운 세션이 저장소 B 로 `cd` 한 뒤에도, 창의 보드 항목, 열린 PR, 알림, 승인 대기가 A 의 것이다. B 의 보드 파일은 읽지 않는다 |
| REQ2 | 같은 저장소의 워크트리는 지금처럼 주 checkout 기준이다 | A 의 워크트리에서 띄우거나 A 의 워크트리로 옮겨도 창은 A 주 checkout 의 보드를 보인다 |
| REQ3 | git 밖 폴더에서 띄운 세션은 그 폴더 기준이다 | git 저장소가 아닌 폴더 C 에서 띄운 세션은 C 의 `.omc/board.json` 을 읽고, 저장소 B 로 옮겨도 B 의 보드를 읽지 않는다 |
| REQ4 | 창 코드를 다시 읽어도 시작 저장소를 보인다 | 세션이 B 로 옮겨 간 상태에서 플러그인 갱신이나 `/reload-plugins` 로 창이 다시 로드돼도 A 의 보드를 보인다. 이 기능이 든 버전으로 세션 도중 처음 갱신되는 경우도 A 다 |
| REQ5 | `/clear` 와 대화 압축 뒤에도 시작 저장소를 보인다 | B 로 옮겨 간 뒤 `/clear` 를 하거나 대화가 압축돼도 창은 A 의 보드를 보인다 |
| REQ6 | 옮김을 화면에 따로 표시하지 않는다 | 다른 저장소로 옮겨도 창과 상태 줄에 새 문구나 경고가 생기지 않는다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 창이 따라갈 기준 | 시작 저장소에 고정한다 | 사용자 2026-11-26 | 다른 저장소로 잠깐 `cd` 한 것만으로 창이 바뀌는 것은 의도와 다르다 |
| DECISION2 | 고정할 범위 | 창 전체(보드, 열린 PR, 알림, 승인 대기)를 함께 고정한다 | 사용자 2026-11-26 | 보드 항목과 PR 이 서로 다른 저장소 것이 되지 않는다 |
| DECISION3 | 옮겨 갔을 때 표시 | 표시하지 않는다 | 사용자 2026-11-26 | 에이전트가 조사하느라 자주 옮겨 가서 표시가 자주 바뀌면 산만하다 |
| DECISION4 | 다른 저장소 보드로 바꾸는 방법 | 범위 밖. 그 저장소에서 띄운 세션에서 본다 | 사용자 2026-11-26 | 지금 요청이 없고 PR 이 작아진다 |
| DECISION5 | `/clear` 뒤의 기준 | Claude 를 처음 띄운 폴더를 유지한다. `/clear` 로 기준을 바꾸지 않는다 | 사용자 2026-11-26 | 「claude 를 실행한 폴더」 하나로 규칙이 단순해진다 |
| DECISION6 | 이 기능이 든 버전으로 처음 갱신될 때의 기준 | 그때의 작업 폴더가 아니라 Claude 를 띄운 폴더로 정한다 | 사용자 2026-11-26 | 지금 떠 있는 세션도 갱신만 되면 바로 맞는 보드를 보인다 |
| DECISION7 | 워크트리에서 띄운 세션 | 주 checkout 의 보드를 쓴다 | 작성자 | 지금 동작(`--git-common-dir`)과 orch 의 보드 위치 규칙(`docs/features/orch-board-cli/spec.md` REQ2)과 같다 |
| DECISION8 | git 밖 폴더에서 띄운 세션 | 띄운 폴더를 기준으로 고정한다 | 작성자 | 지금도 git 밖이면 작업 폴더를 쓴다. 고정만 더한다 |
| DECISION9 | 명령줄 도구의 보드 고르기 | 바꾸지 않는다 | 작성자 | 명령줄 도구는 부른 폴더와 `--repo` 로 대상을 정해서 같은 문제가 없다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: 창이 읽는 기준 폴더만 바꾸고, 보드 파일 위치 규칙(`skills/orch/scripts/lib/board-file.ts` 의 `boardPath`)은 그대로 쓴다.

## 기술 설계

- 시작 폴더는 `register.js` 의 `startFolder` 가 정한다. 처음 부를 때 세션 상태 `fos-skills/board-start` 를 읽고, 없으면 `$.session.root()` 로 정해 그 상태에 쓴다.
  - `$.session.root()` 는 Claude 를 띄운 폴더다. 셸의 `cd` 로는 옮겨 가지 않아서, 이 기능이 든 버전으로 세션 도중 처음 로드돼도 띄운 폴더를 준다(DECISION6).
  - 세션 상태는 창 코드를 다시 로드해도 남는다(REQ4). 그래서 `/cd` 나 워크트리 이동으로 root 가 옮겨 가도 처음 정한 값을 쓴다(DECISION5).
  - `/clear` 나 압축으로 세션 상태가 비어도 다시 `root()` 를 읽으므로 띄운 폴더가 나온다(REQ5).
  - `root()` 가 없는 host 는 `$.session.cwd()` 를 쓴다. 지금 동작과 같다.
- `boardRoot` 는 작업 폴더 대신 시작 폴더를 기준으로 `git rev-parse --git-common-dir` 를 불러 주 checkout 을 찾는다(REQ2, DECISION7). git 밖이면 시작 폴더 아래에서 보드 파일을 찾는다(REQ3, DECISION8).
- 창의 명령 실행 함수 `run` 은 모든 명령을 시작 폴더에서 돌린다. `github.ts` 의 열린 PR 과 저장소 주소 조회는 `--repo` 없이 작업 폴더를 쓰므로, 이것으로 PR 과 PR 링크가 보드와 같은 저장소가 된다(DECISION2). 알림, 알림 숨기기, 승인 대기와 승인 누르기, 머지 큐 줄, 피드백 수는 이미 `boardRoot` 를 `--repo` 로 넘기고, 그 값이 시작 폴더 기준이 된다.
- 보드 파일 위치 규칙(`board-file.ts`)과 명령줄 도구는 바꾸지 않는다(DECISION9). 옮김 표시는 더하지 않는다(REQ6, DECISION3).
- 함께 고친 것: 열린 PR 조회가 끝나기 전에 실제 상태 읽기가 `live` 를 새 객체로 바꾸면 PR 결과가 옛 객체에 들어가 버려졌다. 결과를 받은 뒤의 `live` 에 넣는다. 위 변경으로 명령 순서가 바뀌며 기존 PR 테스트에서 드러났다.

## 이 PR의 구현·검증 계획

1. `startFolder` 를 더하고 `boardRoot`, `run`, 보드 파일 찾기가 시작 폴더를 쓰게 한다. 상태 계약 `types/index.d.ts` 에 `board-start` 를 더한다.
2. 테스트: `extensions/work-board/tests/session-root.test.ts` 가 창을 그려 REQ1, REQ2, REQ3, REQ6 을 본다(띄운 폴더 `/a`, cd 한 폴더 `/b`). `session-root.spec.ts` 가 모듈을 새로 읽어 REQ4, REQ5, DECISION6 과 `root()` 가 없는 host 를 본다.
3. 동작 문서, README, 변경 이력 조각을 고친다.

로컬은 `claude plugin test .`, `node scripts/run-tests.ts extensions/work-board/tests`, `--tsc-only`, `claude plugin validate .` 를 돌리고 전체는 CI 가 돌린다.
