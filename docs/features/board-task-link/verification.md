# 보드 업무 링크 구현 검증 기록

- 상태: 구현과 로컬 실행 검증. 독립 코드·문서 검토는 코디네이터에게 넘긴다.
- 원본: [스펙](spec.md), [설계](design.md), [인수 검증 계획](tasks/task-link/verification-plan.md).
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

## 독립 검토와 문서 대조

독립 리뷰와 verify 는 코디네이터가 맡는다. 이 문서는 구현자의 실행 증거이며 독립 검토 통과를 뜻하지 않는다.
구현자는 데이터 스키마, orch 의 설정·보드 참조, work-board 동작 참조를 스펙과 대조했다.
ADR-031 의 core 값 판정·lib 외부 호출·보드 저장·창 표시 경계를 지켰고 core 경계 검사를 통과했다.
공통화 후보 없음: 업무 도구의 값 변환은 새 어댑터 모듈이 소유하고, 보드·창·루프는 그 결과만 사용한다. inbox 의 도구 호출과는 설정과 수명이 달라 합치지 않는다.

## 결정

설정 없는 저장소에서 루프 결과에 새 오류 칸을 더하지 않는다. 업무 주소 단계는 성공했을 때 앞 틱의 오류가 있는 경우에만 그 오류를 해제한다. 기존 틱 출력 기록 검사가 그대로 통과한다.
실패 기록은 파일에 남기고 보드 쓰기 시점에 번호를 다시 확인한다. 외부 업무 도구 호출은 보드 잠금 밖에서 끝낸다.

## 확인하지 못한 것과 후속 검증

- 사내 실제 dooray CLI 의 응답 맨 위 `id` 와 한글 프로젝트 코드 조회는 실행하지 않았다. 가짜 응답만 검증했으며 실제 CLI 버전이나 응답 형식을 확인했다고 주장하지 않는다.
- 코디네이터가 사내 환경에서 `dooray --json post get <프로젝트> <번호>` 를 읽기 전용으로 실행해 `id` 와 한글 코드 조회를 확인한다. 응답 본문은 공개 PR 에 옮기지 않고 CLI 버전과 칸 이름만 기록한다.
- 머지 후 새 번들을 설치하고 상주 루프를 다시 띄운 뒤에만 `board.task` 를 넣는다. 코디네이터가 실제 보드의 번호만 있는 항목에 주소가 채워지고 칩이 같은 업무를 여는지, 제목을 누르면 요청문이 채워지는지 확인한다.
- 후속 확인은 실제 Orca 코디네이터 세션과 사내 업무 도구가 있는 환경에서 한다. 독립 검증과 기록 보존이 끝날 때까지 계획서를 남긴다.
