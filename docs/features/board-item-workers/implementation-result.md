# 보드 항목 하위 worker PR1 개발 검증

스펙: [spec.md](spec.md), 설계: [design.md](design.md), 인수 검증 기록: [verification.md](verification.md).
구현은 하위 에이전트 없이 순서대로 진행했다. 독립 리뷰와 인수 검증은 코디네이터가 맡는다.

## 구현한 범위

| 요구사항 | 변경과 개발 검증 |
| --- | --- |
| REQ1 | 보드 잠금 안에서 worker 줄과 대표 칸을 함께 쓴다. `board-workers.spec.ts`에서 추가·재시도·끝남·옛 대표 보존·단계 지문 보존을 확인했다 |
| REQ2 | 리뷰·검증은 대상 PR, 명시한 항목, 브랜치로 찾는다. `board-attach.spec.ts`에서 done 항목 유지, PR 우선순위, head 브랜치 조회, 조회 실패의 새 항목, 현재 리뷰 이력 제외를 확인했다 |
| REQ3 | 후속은 같은 업무·브랜치의 항목에 붙인다. `launch-worker.spec.ts`에서 `BOARD-ATTACH attention follow` 출력과 원래 줄 보존을 확인했다 |
| REQ5 | 지시서 머리의 새 항목 요청과 검증 역할을 읽는다. `lib-spec.spec.ts`, `spec-lint.spec.ts`에서 본문 예시 제외와 새 항목·id 동시 지정 거절을 확인했다 |
| REQ7 | `core-board-workers.spec.ts`에서 보고·dispatch 끝남을, `board-sync.spec.ts`에서 줄 끝내기·대표 교체·리뷰가 구현 항목을 닫지 않기를 확인했다. `board-path-callers.spec.ts`에서 루프 전달을, `lib-movement.spec.ts`에서 살아 있는 리뷰의 멈춤 알림 억제를 확인했다 |
| REQ8 | 데이터 스키마, 보드·지시서 참조, 리뷰·검증 틀과 orch 진입점을 설계와 대조했다. 이번 범위는 worker 데이터와 판정이며 창과 동시 PR 단계는 PR2 계획에 남긴다 |

## 실제 보드 사본 확인

2026-11-13에 저장소의 실제 보드를 세션 임시 폴더로 복사했다. 임시 git 저장소와 별도 `ORCH_DIR`에서 실제 `launch-worker`와 보드 명령을 실행했고 Orca 시작 응답만 가짜로 주었다. 원본 보드는 쓰지 않았다.

- 사본의 기존 구현 항목에 테스트 대상 PR을 지정하고 리뷰를 띄웠다. 항목 수·단계·대표 칸은 그대로였고 `BOARD-ATTACH board-item-workers-attach review`가 나왔다.
- 같은 항목의 브랜치로 후속 워크트리를 준비하고 후속을 띄웠다. 항목 수는 그대로였고 구현·리뷰 줄 뒤에 후속 줄이 남았다. 대표 칸은 후속 워크트리가 됐고 `BOARD-ATTACH board-item-workers-attach follow`가 나왔다.
- 검사 스크립트와 실행 출력은 세션 임시 폴더의 `board-attach-smoke-j287ddiw/`에 있다. 자동 테스트와 같은 가짜 Orca 응답을 썼으므로 실제 Orca dispatch 의 수명 확인은 코디네이터의 인수 검증에 남긴다.

## 개발 검증

계획의 phase별 테스트와 타입 검사는 통과했다. 한국어 표기 검사는 변경 문서 전체에서 발견이 없었고, 의미 점검에서는 제목·본문 관계, 역할 설명, 구현 범위와 PR2 경계를 확인했다.
플러그인 검사는 `claude plugin test .`로 통과했다.

전체 개발 검증은 `orch slot heavy --exclusive -- node scripts/run-tests.ts`로 실행한다. 최종 결과는 PR 본문에 남긴다.

## 문서 대조와 다음 단계

worker 줄의 열쇠, 대표 칸, 역할, 끝남과 새 항목 요청을 스펙·설계·데이터 스키마·참조 문서 사이에서 대조했다. 서로 다른 규칙이나 공통 문서로 옮길 반복 계약은 발견하지 못했다.
계획 폴더는 인수 검증 뒤 지웠고 그 계획의 사례와 결과는 [verification.md](verification.md) 로 옮겼다.
스킬 개선 후보와 공부 후보는 없다.

독립 코드 리뷰와 인수 검증 뒤에는 리뷰 지적 반영 확인, 코디네이터의 실제 Orca 확인, 머지가 남는다. PR2의 동시 PR 단계와 창은 별도 계획을 따른다.

## 독립 검토 반영

[코드 리뷰](https://github.com/jon890/fos-skills/pull/490#pullrequestreview-5892541597)와 [인수 검증](https://github.com/jon890/fos-skills/pull/490#pullrequestreview-5892560440)은 차단 0건이었다. 코디네이터가 지정한 권장 사항을 반영했다.

- 리뷰·검증만 있는 항목은 완료나 끊김으로 모든 줄이 끝나면 닫고, 앞 틱에서 닫기를 놓친 경우도 복구한다.
- 옛 대표는 워크트리와 현재 Orca dispatch 를 함께 확인한다. 워크트리가 비었으면 옮길 줄을 만들지 않고, 살아 있음을 확인하지 못하면 끝난 줄로 남긴다.
- 검증 지시서의 대상 항목 선택지를 주석으로 구분하고, 대표 줄의 브랜치가 없으면 대표 브랜치 칸을 지운다. 명령은 명령 표 선언에 함께 둔다.

띄우기 이력이 없으면 옛 대표를 끝난 줄로 옮기는 동작은 의도된 것으로 유지했다.

## 반영 확인 리뷰 뒤 보완

[반영 확인 리뷰](https://github.com/jon890/fos-skills/pull/490#pullrequestreview-5892953012)의 차단 지적과 권장 사항을 코디네이터 지시에 따라 고쳤다.

- 빈 대표가 있는 구현 항목에 리뷰 줄만 남아도, 최초 띄우기 이력과 구현 PR·단계를 확인해 리뷰 완료가 구현 항목을 닫지 못하게 한다.
- Orca 조회 실패와 형식 오류는 모름으로 보고 옛 dispatch 를 작업 중으로 보존한다. 이력 없는 옛 대표를 끝난 줄로 옮기는 규칙은 유지한다.
- 다시 연 리뷰 항목은 지난 보고로 닫지 않는다. 새 종료가 생겼거나 상태 변경 뒤의 종료를 복구할 때만 닫는다. 마지막 줄이 이번에 끊긴 경우에는 코디네이터가 정한 기존 닫기 규칙을 유지한다.
- 같은 대표 워크트리의 재시도에서 브랜치를 읽지 못하면 기존 값을 둔다. 대표 워크트리가 바뀌었을 때만 모르는 브랜치를 지운다.

# 보드 항목 하위 worker PR2 개발 검증

인수 검증 기록: [verification.md](verification.md).
구현은 하위 에이전트 없이 phase 순서대로 진행했다. 독립 리뷰와 인수 검증은 코디네이터가 맡는다.

## 구현한 범위

| 요구사항 | 변경과 개발 검증 |
| --- | --- |
| REQ4 | `core/milestones.ts` 의 `prStages`, `eventKinds`, `advanceCommands`·`mergedCommands` 의 `kinds`·`remaining` 으로 PR 마다 묶음을 고른다. `lib/milestones` 순수 함수 테스트에서 묶음 고르기, 다른 묶음의 앞 단계 닫기, 배포 단계 보존, `done_after` 별 done 시점을 확인했다 |
| REQ4 | `registerBoard` 가 앞 PR 이 열린 마일스톤 항목에 새 브랜치 후속을 붙이면 두 단계를 더하고 줄에 `stages` 를 적는다. `board-attach.spec.ts` 에서 더하는 경우와 더하지 않는 경우(같은 워크트리·브랜치, 리뷰, 앞 PR 없음·머지됨, 옛 단계 항목, 단계 더하기 실패)를 확인했다 |
| REQ4 | 보드 맞추기·머지 마무리·릴리스 확인이 PR 마다 자기 묶음을 끝낸다. `board-sync.spec.ts`, `finish-pr.spec.ts`, `board-release.spec.ts`, `lib-board.spec.ts` 에서 뒤 PR 만 머지, 앞 PR 이 나중에 머지돼 done, 같은 틱 두 머지의 한 건 반영, 상태를 읽지 못한 PR, 배포 단계, 줄로 PR 잇기를 확인했다 |
| REQ6, REQ7 | 창이 작업 중·끝남·끊김 줄을 그린다. `live.test.ts`, `pane.test.ts` 에서 줄 만들기, 줄 글, 접힌·펼친 보기, 완료 항목, 「worker 없음」 감추기, 옛 항목 보존을 확인했다 |
| REQ8 | 창 동작 문서, orch 보드 문서, 데이터 스키마와 변경 이력 조각을 설계와 대조했다 |

## 실제 보드 사본 확인

2026-11-14 에 저장소의 실제 보드를 세션 임시 폴더로 복사하고, 임시 git 저장소와 별도 `ORCH_DIR`, 가짜 gh 로 실행했다. 원본 보드는 읽기만 했다.

- 구현 PR(7)이 열린 항목에 같은 업무 번호의 후속 지시서를 새 브랜치로 `registerBoard` 에 넘기자 단계가 둘 늘고(`3. PR (wb)`, `4. 머지 (wb)`) 후속 줄에 `stages` 가 적혔다
- 후속 PR(9)이 열리자 보드 맞추기가 그 PR 을 줄과 항목의 `pr`(`7, 9`)에 잇고 3번 단계만 끝냈다
- 후속 PR 만 머지되자 3·4번만 끝나고 항목은 doing, `pr` 은 7, `merged-pr` 은 9 였다
- 구현 PR 도 머지되자 1·2번이 끝나고 항목이 done 이 됐다
- 실제 Orca dispatch 수명과 창의 실제 모양은 코디네이터의 인수 검증에 남긴다

## 개발 검증

phase 마다 계획의 검증 명령을 돌려 통과했다. `claude plugin test .` 는 104건 통과했고, `orch slot heavy --exclusive` 로 돈 전체 테스트(`node scripts/run-tests.ts`, tsc 포함)는 301건이 통과했다. 한국어 표기 검사는 변경 문서에서 발견이 없었다.

## 결정

- 앞 PR 이 열린 때 단계를 더하는 규칙은 `stages` 가 있는 마일스톤 항목에만 쓴다. 옛 단계 항목은 단계 글의 PR 번호로 끝내는 규칙이라 사건 단계를 섞지 않는다
- `remaining`(마지막 PR 판정을 거짓으로 만드는 다른 PR)에는 열린 PR 에 더해 머지됐지만 아직 반영하지 않은 PR 과 상태를 읽지 못한 PR 도 센다. 같은 틱에 두 PR 이 머지돼도 번호가 작은 쪽이 마지막 PR 로 판정돼 항목을 먼저 닫지 않는다
- `finish-pr` 는 다른 PR 의 상태를 `gh pr view --json state` 로 읽고, 닫힌(CLOSED) PR 은 남은 PR 로 세지 않는다
- 줄로 항목을 찾는 `findBoardItems` 는 `BoardMatch` 에 선택 칸 `rows`(항목 id → 줄의 워크트리)를 더한다. 줄로 찾은 항목이 없으면 이 칸이 없어 기존 호출과 결과가 같다

## 문서 대조와 다음 단계

스펙·설계·데이터 스키마·창 동작 문서·orch 보드 문서가 같은 규칙(묶음 고르기, 마지막 PR 판정, 배포 단계, 줄 그리기)을 말한다. 공통 문서로 옮길 반복 계약은 발견하지 못했다.
계획 폴더는 인수 검증 뒤 지웠고 그 계획의 사례와 결과는 [verification.md](verification.md) 로 옮겼다.
스킬 개선 후보와 공부 후보는 없다.

## 독립 리뷰 반영

[코드 리뷰 5894110727](https://github.com/jon890/fos-skills/pull/491#pullrequestreview-5894110727)의 차단 2건을 고쳤다.

- 릴리스 확인(`board-release`)이 `pr` 에 반영하지 않은 다른 PR(열린 후속 PR 등)이 남은 항목은, 남은 PR 이 모두 이번 릴리스에 들기 전에는 끝내지 않는다. `--release` 와 `--pr` 두 경로의 회귀 테스트를 더했다
- 머지 마무리(`finish-pr`)가 줄의 브랜치로 찾은 항목은 먼저 그 PR 을 줄과 `pr` 에 잇고 그 줄의 묶음 단계로 끝낸다. 실제 보드 명령으로 후속 줄과 구현 줄 두 경우를 확인했다

[재확인 리뷰 5894432804](https://github.com/jon890/fos-skills/pull/491#pullrequestreview-5894432804)의 차단 2건도 고쳤다.

- 대표 브랜치로 찾은 항목도 같은 브랜치의 후속 줄이 있으면 그 줄을 `findBoardItems` 결과의 `rows` 에 담아, 머지 마무리가 PR 을 줄에 잇고 그 줄의 묶음으로 끝낸다
- 줄에 PR 을 잇지 못하면 항목의 단계와 `merged-pr` 을 건드리지 않고 실패로 끝낸다. 줄을 먼저 채우고 그다음 항목의 pr 에 더한다. 명령 실패를 주입한 테스트로 확인했다

[두 번째 반영 확인 리뷰 5894674972](https://github.com/jon890/fos-skills/pull/491#pullrequestreview-5894674972)의 차단 1건을 사용자 결정(2026-11-13)대로 고쳤다.

- 줄의 `pr` 과 항목 `pr` 필드를 따로 두 번 쓰면 한쪽만 저장된 채 실패해, 다시 돌려도 항목을 못 찾고 단계가 끝나지 않은 채 끝났다. 보드 명령 `worker-link` 하나(한 잠금, 한 번 저장)로 합쳤고 보드 맞추기, `finish-pr`, `linkBoardPr` 이 이 명령만 부른다. 실패하면 단계를 건드리지 않고 실패로 끝낸다
- `findBoardItems` 가 `pr` 필드나 줄의 `pr` 어느 쪽으로도 항목을 찾는다. 연결 실패 뒤 다시 돌리는 테스트로 확인했다

[구조 고침 확인 리뷰 5900107072](https://github.com/jon890/fos-skills/pull/491#pullrequestreview-5900107072)의 차단 1건도 고쳤다. `findBoardItems` 가 줄의 `pr` 로 항목을 찾을 때 구현·후속 줄만 보고, 대상 PR 을 담은 리뷰·검증 줄은 보지 않는다. 따로 생긴 리뷰 항목 때문에 머지 마무리가 구현 항목 반영을 건너뛰던 경우를 실제 보드 명령 테스트로 옮겼다.
