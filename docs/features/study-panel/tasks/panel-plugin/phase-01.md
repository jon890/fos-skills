# Phase 01. 공부·피드백 패널

**Execution profile**: standard

## 목표

Orca 사이드바에서 일일 요약과 진행 중인 일을 보고, 후보에 대한 답을 fosbot에 보낸다.

**범위 외**: fosbot의 운영 요약, 대기열 소비, 자동화 등록과 실행.

## 컨텍스트

Orca worker-panel 템플릿을 사용한다. AI 비서 패널의 JSON 파일명과 CLI 호출 규칙을 따르고 공부·피드백 전용 경로에 쓴다.

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ6, REQ7

**근거 문서**: `docs/features/study-panel/spec.md`, `docs/features/study-panel/technical-design.md`

## 의도 메모

- CLI의 호출이 접수될 때까지 요청을 준비 폴더에 둔다.
- 화면과 worker 테스트는 운영 설정이 없는 격리 폴더에서 돌린다.

## 작업 항목

### 1. 요약 검증과 감시

버전 1 요약 검증, 마지막 정상 요약, 평일 경과 계산, 파일 감시를 구현한다.
### 2. 선택 전송과 잠금

선택 검증, 후보 잠금, 중복 방지와 대기열 전송을 구현한다. 가짜 CLI로 접수 전 미노출과 실패 복구를 확인한다. `extensions/study-feedback-panel/tests/panel-core.spec.ts`에 요약, 감시, 전송, 시간 경계 테스트를 둔다.
### 3. 화면과 테스트

세 탭과 진행 목록을 그리고 카드 전송, 이유, 실패를 표시한다. Orca 테스트에서 요청과 이벤트를 확인한다. Orca가 제공하는 모듈을 등록하고 `scripts/tests/runtime-policy.spec.ts`에서 사용 경로를 확인한다.
### 4. 설치 문서와 재설치

설치 README와 변경 이력 조각을 작성한다. 사용자 승인 후 이 작업 공간에서 설치와 코드만 바꾼 재설치를 확인한다.

## 검증

```bash
node scripts/run-tests.ts extensions/study-feedback-panel/tests
orca plugin test extensions/study-feedback-panel --json
orca plugin check extensions/study-feedback-panel --json
node scripts/run-tests.ts --tsc-only
node scripts/run-tests.ts scripts/tests/runtime-policy.spec.ts
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 요약과 가짜 시계 | Node 테스트에서 파일을 교체하고 삭제한 뒤 버전이 다른 파일과 깨진 파일을 넣는다 | 검증 결과와 마지막 정리 시각이 갱신되고 월요일 오전 경계에서 오래됨이 표시된다 | 임시 폴더와 Node | worker | 없음 | PR 전 |
| REQ2, REQ3, REQ4 | 공부, 피드백, 열린 PR과 저장소 집계 예제 | 플러그인 테스트에서 탭을 열고 진행 목록을 확인한다 | 후보와 출처, 묶음·집계, 진행과 PR 상태가 표시된다 | 가짜 호스트 | worker | 없음 | PR 전 |
| REQ5 | 가짜 시계와 CLI | 같은 후보를 동시에 보내고 파일 변경과 시간 경계를 검사한다 | 전송은 한 번만 이루어지고 새 변경 번호 또는 10분 경과 시 잠금이 풀린다 | 임시 폴더와 Node | worker | 없음 | PR 전 |
| REQ6 | 이유가 필요한 선택과 실패하는 CLI | 입력 오류, 대기열 쓰기 실패, 깨우기 실패를 실행한다 | 이유가 유효해야 전송되며 실패 시 최상위에 요청 파일이 남지 않는다 | 임시 폴더와 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ7 | 가짜 요약 경로와 플러그인 승인 | 작업 공간에서 설치하고 패널을 캡처한 뒤 코드만 바꿔 재설치한다 | 권한 확인 후 샘플이 보이고 동일 권한의 재설치에서 승인이 재사용된다 | 로컬 Orca | 코디네이터 | 없음 (설치 전 사용자 승인) | PR 전 |

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/study-feedback-panel/.gitattributes` | 신규 |
| `extensions/study-feedback-panel/.gitignore` | 신규 |
| `extensions/study-feedback-panel/README.md` | 신규 |
| `extensions/study-feedback-panel/CHANGELOG.md` | 신규 |
| `extensions/study-feedback-panel/changes/introduce-study-panel.minor.md` | 신규 |
| `extensions/study-feedback-panel/orca-plugin.json` | 신규 |
| `extensions/study-feedback-panel/tsconfig.json` | 신규 |
| `extensions/study-feedback-panel/src/panel.check.ts` | 신규 |
| `extensions/study-feedback-panel/src/panel.test.tsx` | 신규 |
| `extensions/study-feedback-panel/src/panel.tsx` | 신규 |
| `extensions/study-feedback-panel/src/protocol.ts` | 신규 |
| `extensions/study-feedback-panel/src/worker.test.ts` | 신규 |
| `extensions/study-feedback-panel/src/worker.ts` | 신규 |
| `extensions/study-feedback-panel/src/summary.ts` | 신규 |
| `extensions/study-feedback-panel/src/delivery.ts` | 신규 |
| `extensions/study-feedback-panel/src/state.ts` | 신규 |
| `extensions/study-feedback-panel/tests/panel-core.spec.ts` | 신규 |
| `extensions/study-feedback-panel/tests/fixtures.ts` | 신규 |
| `extensions/study-feedback-panel/src/choices.ts` | 신규 |
| `tsconfig.json` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
| `scripts/runtime-policy.ts` | 수정 |
| `scripts/tests/runtime-policy.spec.ts` | 수정 |
| `docs/features/study-panel/technical-design.md` | 수정 |
| `extensions/study-feedback-panel/images/sample-panel.png` | 신규 |
