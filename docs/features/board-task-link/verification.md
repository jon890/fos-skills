# 보드 업무 링크 구현 검증 기록

- 상태: 구현은 PR #486 과 후속 #489(칩을 제목 윗줄에 둠)로 main 에 머지됐다. 머지 뒤 실제 환경 확인은 아래 「머지 뒤 실제 환경 확인」 에 있다.
- 원본: [스펙](spec.md), [설계](design.md). 인수 검증 계획은 아래 표와 절로 옮기고 계획 폴더는 지웠다.
- 환경: macOS, Node 24.22.1, Claude Code 2.1.323. 임시 저장소·가짜 Orca·가짜 GitHub·가짜 업무 도구로 실행했다.
- 실행 형태: worker 한 명이 phase 순서대로 구현했다. 하위 worker 와 Claude Teams 는 쓰지 않았다.

## 요구사항별 실행 근거

명령은 저장소 루트에서 `node scripts/run-tests.ts` 뒤에 아래 테스트 경로를 붙여 실행한다. 창 검증은 `claude plugin test .` 이다.

| 요구사항 | 경계와 테스트 | 기대값과 관측 결과 |
| --- | --- | --- |
| REQ1 | `extensions/work-board/tests/board-task-ref.spec.ts`, `skills/orch/tests/board-edit.spec.ts` | 상태 없이 번호·주소를 넣고 고치고 지운다. 기본 프로젝트를 붙이고 틀린 주소는 저장하지 않는다. 통과 |
| REQ2 | `extensions/work-board/tests/pane.test.ts`, `extensions/work-board/tests/task-tool.spec.ts` | 표시·칩·제목 순서, 번호만 있는 흐린 글자, 주소만 있는 링크, 결정·완료 줄, 제목 버튼 동작을 확인했다. 창 테스트 95개 통과 |
| REQ3 | `skills/orch/tests/core-task-adapters.spec.ts`, `lib-task-adapters.spec.ts`, `core-config-schema.spec.ts`, `config-schema-readers.spec.ts`, `orch-config.spec.ts` | 두 어댑터 설정, 빠진 값과 모르는 키 거절, 번호와 주소 변환, CLI 오류·없는 id·시간 제한을 확인했다. 통과 |
| REQ4 | `skills/orch/tests/launch-worker.spec.ts` | 새 항목·기존 항목·다시 열기·중간 과정에서 같은 줄의 번호와 주소만 저장했다. 앞 빈 줄과 목록 기호를 받으며 업무 도구를 부르지 않았다. 통과 |
| REQ5 | `skills/orch/tests/board-sync.spec.ts`, `completion-watch.spec.ts`, `lib-board.spec.ts`, `orch-loop.spec.ts` | PR 제목이 루프에서 보드 맞추기로 전달되고, 두 연결 경로가 한글 프로젝트 번호도 저장했다. PR 이 이미 있는 항목은 유지했다. 통과 |
| REQ6 | `skills/orch/tests/loop-task-links.spec.ts`, `orch-loop.spec.ts` | 주소 채우기, 처음 한 번의 실패 로그, 30분 간격, 프로세스 재시작, 설정 없음, 완료 제외, 시간 예산을 확인했다. 통과 |
| REQ7 | 보드 쓰기와 REQ4·REQ5·REQ6 테스트 | 사람이 넣은 번호·주소를 유지했다. 주소를 만드는 사이 번호가 바뀌거나 항목이 사라지면 쓰지 않고 실패로 기록하지 않았다. 통과 |
| REQ8 | `skills/orch/tests/config-docs.spec.ts`, `scripts/tests/doc-script-refs.spec.ts` 와 변경 문서 대조 | 새 설정·칸·명령·상태 파일과 설치 후 루프 재시작 안내를 대조했다. 옛 명령 표기를 고친 뒤 통과 |
| REQ9 | `skills/orch/tests/launch-worker.spec.ts` | 새 제목에 번호를 붙이지 않고 번호 칸으로 먼저 찾았다. 번호 칸이 빈 옛 제목만 검색하고 기존 제목은 유지했다. 통과 |

## 문서 대조

아래 표의 실행 결과는 구현자의 로컬 실행 증거다. 독립 리뷰는 PR 에서 받았다.
구현자는 데이터 스키마, orch 의 설정·보드 참조, work-board 동작 참조를 스펙과 대조했다.
[ADR-031](../../adr/031-board-task-adapter.md) 의 core 값 판정·lib 외부 호출·보드 저장·창 표시 경계를 지켰고 core 경계 검사를 통과했다.
공통화 후보 없음: 업무 도구의 값 변환은 새 어댑터 모듈이 소유하고, 보드·창·루프는 그 결과만 사용한다. inbox 의 도구 호출과는 설정과 수명이 달라 합치지 않는다.

## 결정

설정 없는 저장소에서 루프 결과에 새 오류 칸을 더하지 않는다. 업무 주소 단계는 성공했을 때 앞 틱의 오류가 있는 경우에만 그 오류를 해제한다. 기존 틱 출력 기록 검사가 그대로 통과한다.
실패 기록은 파일에 남기고 보드 쓰기 시점에 번호를 다시 확인한다. 외부 업무 도구 호출은 보드 잠금 밖에서 끝낸다.

## 머지 뒤 실제 환경 확인

2026-11-14 에 사내 환경에서 확인했다. 응답 본문과 사내 주소는 공개 저장소라 옮기지 않는다.

| 항목 | 확인한 것 | 근거 |
| --- | --- | --- |
| 실제 dooray CLI 응답 꼴 | dooray CLI 0.33.0 실측(2026-11-14). `dooray --json post get AI-스마트홈-AI 458` 이 맨 위 `id`(19자리 postId)와 `project.code`(한글 프로젝트 코드)를 냈다. 설계의 「응답의 `id` 로 주소를 만든다」 와 한글 프로젝트 코드 조회가 실제 응답과 맞다 | 읽기 전용 실행, CLI 버전과 칸 이름만 기록 |
| 주소 자동 채우기 | ai-analysis 저장소(`board.task` = dooray, 기본 프로젝트 설정)의 상주 루프가 업무 번호만 있던 항목 셋의 주소를 만들었다. 항목의 `task` 칸에 `/project/tasks/<postId>` 꼴 주소가 생겼고 `task-links.json` 의 실패 기록은 비어 있다 | 그 저장소 `.orch/state/loop.log` 의 `TASK-LINK qa-attention-429 AI-스마트홈-AI/429`, `TASK-LINK 305-ai-audit AI-스마트홈-AI/305`, `TASK-LINK admin-list-pattern AI-스마트홈-AI/432` |
| 창의 칩 | 사용자가 실제 창에서 칩이 좁은 폭에 눌리는 것을 보고 #489 로 칩을 제목 윗줄로 옮겼다 | PR #489 |

## 확인하지 못한 것

- 칩을 눌렀을 때 같은 두레이 업무가 열리는지, 제목을 눌렀을 때 요청문이 채워지는지는 실제 코디네이터 세션에서 확인한 기록이 없다. 창 테스트(pane.test.ts)로만 확인했다.
- 채워진 주소(`/project/tasks/<postId>`)가 같은 업무를 연다는 것도 브라우저로 열어 본 기록이 없다. postId 는 `post get` 응답의 `id` 라서 같은 업무일 가능성이 높지만 확인한 것은 아니다.
