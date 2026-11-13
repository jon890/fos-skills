# 설정 명령 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 git 저장소와 worktree | `node --test skills/orch/tests/orch-config.spec.ts`: 도움말, 인자 부족, 배치 set/unset, worktree 와 --repo 호출 | 주 checkout 에만 저장하고 잘못된 인자는 2 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ2 | 파일 없음·오타·깨진 JSON | `node --test skills/orch/tests/orch-config.spec.ts`: show 전체와 절을 실행 | 파일 생성 없이 JSON 출력, 기존 문제는 경고, 깨진 JSON 은 1 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ3 | 존재·부재·모르는 경로 | `node --test skills/orch/tests/orch-config.spec.ts`: get 을 각 경로로 호출 | 한 줄 JSON, 없는 키와 모르는 이름을 구분 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ4 | 빈 파일과 숫자·목록·음수 | `node --test skills/orch/tests/orch-config.spec.ts`: 문자 set, --json set, -- 뒤 값을 호출 | 정한 타입으로 저장, 음수는 값 오류 1 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ5 | 기존 오류와 짝 규칙 오류 | `node --test skills/orch/tests/orch-config.spec.ts`: 정상 수정·잘못된 타입·같은 오류의 새 값·짝 위반을 실행 | 기존 다른 문제는 경고, 새 오류는 바이트 보존하며 거절 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ8 | 오타 키·빈 객체·옛 칸·없는 경로 | `node --test skills/orch/tests/orch-config.spec.ts`: unset 키와 절, 반복 unset | 오타 제거와 빈 객체 정리, 옛 칸 보존, no-op 은 쓰지 않음 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ9 | 잠금과 동시 자식 프로세스 | `node --test skills/orch/tests/orch-config.spec.ts`: 서로 다른 set 및 migrate 두 경로와 set 을 겹쳐 실행 | 최신 키를 모두 보존, 잠금 실패 1, 반쪽 파일 없음 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ10 | 옛 값과 새 값 | `node --test skills/orch/tests/orch-config.spec.ts`: set/unset 출력과 저장값 비교 | CONFIG-SET/UNSET 에 잠금 안에서 읽은 이전 값 표시 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ11 | 루프 살아 있음·오래된 생존 기록·없음 | `node --test skills/orch/tests/orch-config.spec.ts`: tick_sec, finish.run/specs_dir, digest_sec 수정 | alive/recheck 에만 조건에 맞는 재시작 안내 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ6 | 검사표와 문서 타입 표 | `node --test skills/orch/tests/config-docs.spec.ts`: config-docs 와 lib-config 테스트로 키와 타입 대조 | 누락한 finish/cleanup 키와 타입 일치 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ12 | 바뀐 안내 문서 | `node --test skills/orch/tests/config-docs.spec.ts`: config-docs 및 spec-lint 문서 검사 실행 | 직접 편집 안내 대신 config 명령 사용 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |
| REQ13 | 공통 지시서 틀 | `node --test skills/orch/tests/config-docs.spec.ts`: config-docs 로 no-config-edit 항목 확인 | worker 의 orch config set/unset 호출 금지 | 격리된 임시 폴더와 자식 프로세스 | worker | 없음 | PR 전 |

공통 확인: 옛 위치가 남으면 모든 명령은 기존 이전 안내로 거절한다. 의존을 읽지 못한 명령은 설치 안내와 1 을 내며 기존 루프 명령은 계속 돈다. 전체 검증은 `claude plugin test .` 와 `orch slot heavy --exclusive -- node scripts/run-tests.ts` 를 실행한다. 독립 코드·문서 검토는 PR 생성 뒤 코디네이터가 맡기는 Claude 리뷰로 확인한다. PR1 의 deferred 는 이 계획에서 모두 인수했다.
