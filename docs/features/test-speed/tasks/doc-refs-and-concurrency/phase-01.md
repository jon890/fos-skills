# Phase 01. 문서 판정 격리와 동시 실행 조정

**Execution profile**: standard

## 목표

문서 검사의 실제 환경 의존과 반복 기동을 없애고 CPU에 맞춘 실행기 기본값을 정한다.

**범위 외**: PR9의 남은 느린 테스트와 대기 옵션 삭제.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ7, REQ8

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` PR8 절.
기존 `checkScripts`는 파일 시스템만 읽고 CLI가 부른다. `parseArgs`는 기본 동시 4를 소유한다. 공용 testkit의 임시 폴더와 가짜 run을 재사용한다.

## 의도 메모

전체 doctor를 가짜 환경으로 반복 기동하는 안보다 기존 문서 판정 함수만 호출하는 안을 고른다. CLI 동작은 기존 doctor 테스트로 유지한다. 독립 검토는 PR 뒤 코디네이터가 마련하며 자기 점검으로 대신하지 않는다.

## 작업 항목

### 1. `checkScripts`를 내보낸 뒤 기존 doctor와 문서 테스트를 그대로 실행하고 별도 커밋한다.
### 2. `scripts/tests/doc-script-refs.spec.ts`의 문서 테스트를 직접 호출로 옮긴다. 누락·복구와 외부 명령 금지를 확인한다. 측정 명령으로 전후 시간과 기동 수를 잰다.
### 3. 전체 실행을 동시 4·6·8·12로 순차 측정하고 load average를 남긴다. 선택한 기본값과 CPU 제한·명시 옵션 테스트를 넣고 README와 설계를 맞춘다.
### 4. 기본 전체 실행, 문서 검사, 한국어 검사를 수행하고 PR에 증거를 보존한다. 검증 후 이 계획 폴더만 제거한다.

## 검증

```bash
node scripts/run-tests.ts scripts/tests/doc-script-refs.spec.ts skills/orch/tests/orch-doctor.spec.ts
node scripts/run-tests.ts scripts/tests/run-tests.spec.ts
node scripts/run-tests.ts --concurrency 4
node scripts/run-tests.ts --concurrency 6
node scripts/run-tests.ts --concurrency 8
node scripts/run-tests.ts --concurrency 12
node scripts/run-tests.ts
```

각 명령은 실패 0을 기대한다. 전후 기동 수와 시간은 `node modules/testkit/measure.ts --before 기준커밋 --after 전환커밋 --runs 3 scripts/tests/doc-script-refs.spec.ts`로 잰다. 실제 커밋 값과 끝 줄은 PR에 적는다.

## 인수 검증 계획

환경은 Node 24 이상과 Python이 있는 동일 macOS 머신이며 독립 리뷰는 코디네이터가 마련한다. 구현 전 기존 doctor 판정을 확인하고 변경 후 아래를 PR 전에 실행한다.

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 실제 스킬 문서 | 대상 문서 테스트 실행 | 누락 없이 코드 0 | macOS, Node 24 이상 | 없음 | PR 전 |
| REQ1 | 임시 스킬에 없는 파일 참조 | 검사 후 파일을 만들고 재검사 | 코드 1과 정확한 진단, 복구 후 코드 0 | 같은 환경 | 없음 | PR 전 |
| REQ2 | 기존 doctor 테스트 | 전환 전후 실행 | CLI 인자·출력·종료 유지 | 같은 환경 | 없음 | PR 전 |
| REQ1 | 실패하는 외부 명령 주입 | 실제 문서 함수 검사 | 외부 명령 없이 동일 판정 | Orca 세션 내부 | 없음 | PR 전 |
| REQ7 | 사용 가능한 CPU와 명시 옵션 | 실행기 테스트와 기본 전체 실행 | CPU 이하 기본값, 옵션 우선, 요약 유지 | 같은 머신과 CI | 없음 | PR 전 |
| REQ8 | 사용 가능한 CPU와 명시 옵션 | 실행기 테스트와 기본 전체 실행 | CPU 이하 기본값, 옵션 우선, 요약 유지 | 같은 머신과 CI | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/doctor/orch-doctor.ts` | 수정 |
| `skills/orch/changes/doc-script-check.patch.md` | 신규 |
| `scripts/tests/doc-script-refs.spec.ts` | 수정 |
| `scripts/run-tests.ts` | 수정 |
| `scripts/tests/run-tests.spec.ts` | 수정 |
| `docs/features/test-speed/design.md` | 수정 |
| `README.md` | 수정 |
