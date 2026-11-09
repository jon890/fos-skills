# CHANGELOG: plan

## 7.0.1 (2026-11-09)

- `check_feature` 가 `RULE-<도메인>-<번호>` 처럼 하이픈으로 이은 RULE ID 도 받는다.
- 앞 phase 의 glob 이 덮는 신규 파일은 「이미 존재한다」 대신 「앞 phase 의 glob <패턴> 이 이미 덮는다」 로 알린다.
- `adr-docs` 가 같은 이름 제목이 둘 이상인 문서로 가는 앵커 링크(`#제목`, `#제목-1`)에 stderr 경고(AMBIGUOUS_ANCHOR)를 낸다. 종료 코드는 그대로다.

## 7.0.0 (2026-11-06)

- 호환성: 스크립트 일곱을 Node 24 의 `.ts` 로 바꿨다(`verify_task`, `check_feature`, `run_doc_checks`, `overlay_paths`, `overlay_values`, `plan_number`, `plan_numbers`)
- `plan_number.sh` 는 `plan_number.ts` 가 됐다. `node "$SKILL_DIR/scripts/verify_task.ts" …` 처럼 확장자만 바꿔 부른다. Node 24 이상이 필요하다
- 옵션, 출력, 종료 코드는 그대로다. 저장소의 스펙 13개와 계획 폴더 16개(뒤튼 phase 포함)에서 옛 구현과 같은 결과를 확인했다
- 옛 `python3 …/verify_task.py` 와 `bash …/plan_number.sh` 호출(허용 규칙과 오버레이 포함)은 새 이름으로 바꿔야 한다

## 6.x

- 호환성: `scripts/check_adr_layout.py` 를 지웠다. ADR 위치와 링크는 `node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" check` 로 본다
- `adr-docs.ts` 가 링크·앵커, 링크 없는 ADR 번호, 색인, 번호 중복, 대체된 ADR 위치를 검사하고 `write-index` 로 두 표 색인을 만든다
- 오버레이 값 「ADR 폴더」, 「ADR 색인 생성」 을 더했다. 「ADR 대체 배치」 는 `adr-docs.ts --flat` 으로 넘긴다
- 모노레포 안내와 주석이 옮긴 `plan_precheck.ts`, `static_check.ts` 의 새 이름을 가리킨다

## 5.x

- 호환성: planning 을 plan 으로 바꾸고, 새 기능은 기술 설계와 기능 폴더 아래 계획을 연결했다
- 인수 검증 계획 양식과 요구사항 연결 검사, 도메인 규칙 변경의 확정 상태 검사를 더했다
- `verify_task.py` 가 레포 설정의 PR 변경 파일 상한과 파일 길이 상한을 읽어 계획 단계에서 경고한다
- `run_doc_checks.py` 가 레포 설정의 「문서 검사 명령」 을 spec·technical-design 단계에서 실행한다
- ADR 을 남길 조건과 대체·이동 규약을 technical-design 의 `adr-rules.md` 로 옮겼다
- 세부 변경 이력은 git 에 남아 있다

## 4.x

- 이전 단계의 기능과 수정 이력은 git 기록에서 확인해요.

## 3.x

- 기능 스펙과 요구사항 ID 를 계획에 연결하고, 원격 검증 목록의 명령 칸 형식을 검사했다

## 2.x

- 이전 계획과 구현 절차를 제공했다. 진행 중인 작업은 호환 경로로 이어 간다.
