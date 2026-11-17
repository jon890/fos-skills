# 단일 worker 선택 PR2 검증

검증일: 2026-11-17. 스펙은 [spec.md](spec.md), 설계는 [design.md](design.md) 다. 검증 커밋은 PR 본문의 완료 근거에 남긴다.

## 인수 조건

| 요구사항 | 실제 결과와 실행 근거 |
| --- | --- |
| REQ2, REQ9 | `lib-selection.spec.ts` 가 스펙의 worker 표와 실제 선택 표를 읽어 각 행을 대조한다. 단순 문서 수정과 새 문단·규칙 작성, 어려운 일의 행 기준을 문서 검토로 확인했다 |
| REQ3, REQ4 | 에이전트·모델·effort 하나만 다른 경우와 낮은 effort, 기본 effort 를 검사했다. 이유 없는 예외는 거절하고 이유가 있으면 출력과 JSONL 의 worker·이유가 같다. 정리용 기록을 다시 읽어도 보존된다 |
| REQ3, REQ5 | 비교 항목과 experiment 줄은 새 지시서에서 거절한다. `--lint-ack` 도 넘기지 못한다. active 지시서와 확인된 같은 지시서·설정의 이어하기는 통과한다 |
| REQ6 | agent-selection, spec-writing, SKILL·템플릿에서 한국어 문서를 Claude 에 맡기던 규칙과 설계 제공자 순환·후보 선택 순서를 제거했다. 한도 표의 대체 모델 값은 유지했다 |
| REQ7 | `review-spec.spec.ts` 가 Claude 구현이면 sol medium, Codex 구현이면 Sonnet medium 을 고르고 새 형식으로 지시서를 만드는 것을 확인한다. 보안 리뷰는 별도 고정 행이다 |
| REQ8 | 머지 뒤 코디네이터 담당. 「Fable 5.2 대조(2026-12-01 이후)」 항목을 만들고, 띄운 건수와 관계없이 evidence.md 표 1~3 으로 대조해 계속 쓸지 사용자에게 묻는다 |

## 실행 검증

- `node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts`: 통과. 실제 CLI 를 가짜 orca 와 실행해 새 형식, 거절, 예외 출력·영구 이력, 기존 실행 이어하기를 확인했다.
- `node scripts/run-tests.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/review-spec.spec.ts`: 통과. 새 지시서와 active 지시서, 양쪽 구현 제공자의 리뷰 생성 경계를 확인했다.
- `node scripts/run-tests.ts skills/orch/tests/lib-selection.spec.ts skills/orch/tests/resume-worker.spec.ts skills/orch/tests/takeover.spec.ts`: 통과. 기록 읽기 보완 뒤 재검증했다.
- `node scripts/run-tests.ts --tsc-only`: 통과.
- `claude plugin test .`: 115개 통과.
- `orch slot heavy --exclusive -- node scripts/run-tests.ts`: 310개 파일·타입 검사 중 308개 통과, 초기 문서 검사 2개 실패. 문서 표현과 명령 참조를 수정한 뒤 실패한 korean-style-check.spec.ts 와 doc-script-refs.spec.ts 를 재실행해 모두 통과했다. 마지막 코드 변경 뒤 관련 단위·재개 테스트와 tsc 도 통과했다.
- 기능 문서·계획 형식, 변경된 문서의 링크, 한국어 표기와 `git diff --check` 를 검사했다. 기존 문서의 ADR 링크 경고는 범위 밖으로 남긴다.

## 독립 검토와 문서 대조

공통 지시서가 요청한 읽기 전용 critic 이 설계·계획을 검토했다. 예외 기록 필드, 표의 열 형식, JSONL 단언을 계획에 보완했다.
별도의 읽기 전용 검증자가 스펙·설계·코드·문서를 대조하고 인수 조건 검사를 실행했다. 한도 표에 남은 한국어 문서 조건과 기록 읽기의 예외 정보 누락을 고쳤고 재검토에서 차단 발견이 없었다.

`agent-selection.md` 는 선택 값, `spec-writing.md` 는 지시서 작성법, `docs/data-schema.md` 는 기록 형식과 현재 설계 연결을 소유한다. 옛 orch-routing 설계는 최초 도입 기록으로 남기고 현재 선택 계약이 대체됐음을 명시했다. 관련 근거 문서의 Fable 링크도 현재 선택 표로 맞췄다.
공통화 후보 없음: 이번에 바뀐 선택 검사는 이미 lib/selection.ts 하나를 lint 와 launch 가 함께 쓰므로 새 공유 계약으로 옮길 중복이 없다.

## 남은 것

REQ8 보드 항목은 PR2 머지 때 코디네이터가 만든다. PR1 의 커밋 검사는 이 PR 의 변경 범위 밖이며, 기능 전체 완료는 해당 보드 항목까지 확인한 뒤 코디네이터가 판단한다.

## 리뷰 반영

- 사용자 결정 DECISION27 을 스펙에 더했다. Opus high 근거와 ultra 금지를 별도로 두지 않고 후보 밖 이유 하나로 다룬다. 관련 파싱과 타입을 제거하고 높은 effort 예외를 테스트했다.
