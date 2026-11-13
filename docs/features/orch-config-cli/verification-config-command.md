# 설정 조회와 변경 명령 검증 기록

완료: PR 전 인수 검증과 문서 대조. 독립 코드 리뷰 대기. 독립 코드 리뷰는 PR 생성 뒤 코디네이터가 별도 Claude worker에게 맡긴다.

- 기준: [기능 스펙](spec.md), [기술 설계](design.md).
- 구현 검증 커밋: `4f28c2891ece6753e37992e01bc0c513dd91876d`. 이후 변경은 이 기록과 완료한 계획 정리뿐이다.
- 환경: macOS, Node 24.22.1. 임시 git 저장소·워크트리·설정 파일과 가짜 외부 명령을 사용했다. 실제 공유 설정은 바꾸지 않았다.
- 실행 방식: 구현은 주 에이전트가 차례로 수행했다. 계획 critic과 문서 검토는 별도 native 하위 에이전트가 수행했다. Claude Teams는 사용하지 않았다.

## 요구사항별 증거

공개 명령 경계의 실행 명령은 `node --test skills/orch/tests/orch-config.spec.ts`다. 아래 사례는 해당 파일의 저장 내용·출력·종료 코드·파일 바이트 단언으로 확인했다.

| 요구사항 | 준비와 절차 | 기대값과 실제 결과 | 결과 |
| --- | --- | --- | --- |
| REQ1 | 임시 git 저장소와 연결된 워크트리에서 진입점으로 호출. 도움말·인자 부족·중복 경로·여러 경로 set/unset·별도 --repo 확인 | 네 동작 표시, 잘못된 인자는 2. 워크트리 사본 없이 주 checkout에 저장. 짝 값은 함께 변경 | 통과 |
| REQ2 | 파일 없음·없는 절·오타·옛 칸·잘못된 값·깨진 JSON·null 절의 show 호출 | 파일 생성 없이 JSON 출력. 기존 문제는 stderr. 깨진 JSON은 1, 명시한 null은 null로 출력 | 통과 |
| REQ3 | 있는 값·없는 키·모르는 키와 이름·다른 절의 오류를 둔 get 호출 | 값은 JSON 한 줄. 부재와 모르는 키를 구분. 다른 문제는 경고하며 값 출력 | 통과 |
| REQ4 | 문자열·음수·목록·중첩 객체·배치 값과 -- 뒤의 값을 set | --json으로 타입 구분. -1은 값 오류 1. 깨진 값 JSON은 원본 보존 | 통과 |
| REQ5 | 같은 오류 문구의 다른 값·기존 오타·다른 키 오류·짝 규칙 위반·한 경로만 틀린 배치 호출 | 바꾼 키와 관련 짝 오류는 거절. 기존 다른 문제는 경고. 숫자 문자열에는 --json 안내. 거절은 파일 바이트 보존 | 통과 |
| REQ6 | `config-docs.spec.ts`, `lib-config.spec.ts`, `core-config-schema.spec.ts` 실행 | finish/cleanup 키 누락 없음. pipeline 타입과 타이머 상한 일치. 검사표와 기존 읽기 방식 유지 | 통과 |
| REQ8 | 오타 절·키·중첩 마지막 키·없는 경로·옛 설정 칸을 unset | 빈 부모 정리. 없는 경로는 파일 수정 없이 0. 옛 칸과 그 절 삭제는 원본 보존하며 거절 | 통과 |
| REQ9 | 동시 set 자식 프로세스, 잠금 실패, 깨진 파일, ORCH_DIR, `migrate-orch-dir.spec.ts`의 두 이전 경로 실행 | 두 set 값 보존. 잠금 안 최신 값에 이전 적용. 이전과 겹친 set 값 보존. 잠금 실패와 깨진 파일은 원본 보존 | 통과 |
| REQ10 | 새 값·기존 값·없는 값의 set/unset 출력 비교 | CONFIG-SET/UNSET에 잠금 안에서 읽은 이전 값 또는 없음 표시 | 통과 |
| REQ11 | 살아 있는 PID의 loop.json, 오래된 생존 기록과 ps 대역, 루프 없음으로 키 변경 | tick_sec과 finish 키는 필요한 조건의 재시작 안내. digest_sec·같은 값·루프 없음은 안내 없음 | 통과 |
| REQ12 | `config-docs.spec.ts`, `spec-lint.spec.ts`, `scripts/tests/doc-script-refs.spec.ts` 실행 | 설정 변경 안내의 명령·참조 경로와 공통 규칙 검사 통과 | 통과 |
| REQ13 | 공통 지시서 틀의 no-config-edit 줄과 금지 명령 이름 확인 | worker가 orch config set/unset을 부르지 않고 코디네이터에게 요청하도록 기록 | 통과 |

추가 확인: 옛 위치가 남으면 네 명령이 기존 migrate 안내와 종료 코드 2로 거절한다. 검사표 의존이 없는 격리 번들에서 설정 명령은 설치 안내와 1을 내고, 루프 상태 명령은 zod 없이 실행된다. 프로토타입 속성을 경로로 읽지 않고 자유 이름의 자기 속성은 안전하게 저장한다.

## 전체 검증

- `claude plugin test .`: 97개 통과, 실패 없음.
- `orch slot heavy --exclusive -- node scripts/run-tests.ts`: 287개 통과(테스트 파일 실행과 tsc), 실패 없음. 812.6초.
- 계획 검사 `verify_task.ts --require-verification --audit`: 위반 없음. 구현 뒤 존재 조건 검사를 생략한다는 안내만 있다.
- 한국어 표기 검사: 변경 문서와 커밋 제목을 검사했다. 제목·PR 본문은 게시 직전 다시 검사한다.

## 독립 검토

- 계획 critic: APPROVE. worker 제한을 승인된 REQ13의 호출 금지로 보완한 뒤 재검토했다.
- 독립 문서 검토: PASS, 발견 없음. 검토 커밋은 위 구현 검증 커밋과 같다.
- 독립 코드 리뷰: 코디네이터가 PR 생성 뒤 별도 Claude worker에게 맡긴다. 아직 통과로 보지 않는다.

## 문서 대조와 공통 후보

| 문서 | 확인한 내용 | 결과 |
| --- | --- | --- |
| 기능 spec/design | 명령·값 검사·기존 오류 처리·잠금·이전·재시작 조건 | 정합 |
| data-schema와 overlay | 같은 pipeline 타입, 빠진 finish/cleanup 키, config.json.lock | 정합 |
| orch 안내와 공통 지시서 틀 | 설정 변경 명령과 worker 호출 금지 | 정합 |
| ADR-030과 orch-lib-layers design | config-schema.ts만 zod를 가져오는 예외 | PR1이 남긴 후보를 이번 PR에서 반영 |
| README와 설치 테스트 설명 | 개발 의존 설치와 npm 레지스트리 사용 가능성 | 문구 수정 |

공통화 후보 없음: 설정 편집은 이 기능의 core/lib 경계 안에 있고, 잠금은 기존 work-board의 withFileLock을 재사용한다. 새 공유 계약을 추출할 반복 규칙은 없다. 도메인 규칙 변경이나 새로운 ADR 결정은 없다.

## 계획 인수와 후속 검증

PR1의 deferred에서 설정 명령·잠금과 이전·재시작 알림·문서 안내·worker 금지, REQ6의 타입 문서, README 의존 설치와 설치 테스트 설명을 모두 인수했다. 이번 PR의 계획은 위 절차와 실제 결과를 이 문서에 옮긴 뒤 제거했다. 다른 PR의 계획은 계획 수명 규칙의 삭제 범위에 따라 그대로 둔다.

머지·배포 뒤 검증 없음: 저장소 파일을 읽고 바꾸는 CLI 기능이며 별도 서비스 배포나 원격 환경을 전제로 하지 않는다. 독립 코드 리뷰와 PR의 Tests 통과는 머지 전 조건이다.

스킬 개선 후보 없음. 공부 후보 없음.
