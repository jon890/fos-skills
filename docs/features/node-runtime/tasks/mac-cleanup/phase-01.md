# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

mac-cleanup 의 명령 열하나가 지키는 옵션, stdout, 쓰는 파일, 종료 코드를 `node:test` 로 먼저 고정한다. 이 커밋에서 새 테스트는 옛 Python 과 셸 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체와 옛 Python 테스트 삭제(phase-02), 부르는 문서와 정책 파일(phase-03).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `skills/mac-cleanup/tests/<명령>.spec.ts` 다. `tests/helpers.ts` 의 「명령 경계」 상수 한 곳만 구현을 가린다. phase-02 는 이 상수만 바꾼다.
- 이 스킬은 내보내지 않으므로 `modules/testkit/` 을 쓸 수 있다.
- **이 스킬은 디스크의 파일과 컨테이너 자원을 지우는 명령을 부른다.** 테스트는 임시 폴더, 임시 HOME, 임시 git 저장소와 `PATH` 맨 앞의 가짜 실행 파일(`docker`, `colima`, `gh`, `ps`, `lsof`, `du` 등)만 쓴다. 실제 홈 폴더, 캐시, Docker, 브랜치를 건드리지 않는다. 자식 프로세스의 `PATH` 는 가짜 폴더와, 필요한 실제 실행 파일(`git`, `du`)만 링크한 폴더로 한정한다.
- 대상 명령: `survey_system`, `survey_sessions`, `survey_git`, `survey_gradle`, `docker_images`, `docker_volumes`, `check_pr_branches`, `delete_branches`, `delete_sessions`, `delete_volumes`, `colima_trim`.

## 의도 메모

- 옛 Python 테스트 사례를 모두 명령 경계로 옮긴다. 순수 함수만 부르던 사례(`classify_*`, `parse_*`, `should_retry` 등)는 가짜 명령과 임시 폴더로 stdout 을 만들어 관측한다. 관측되지 않는 사례만 phase-02 의 `internals.spec.ts` 로 옮긴다.
- 문서의 `rm -rf` 변수 보호 검사(`test_rm_guard.py`)는 문서 텍스트만 읽는다. 구현과 무관하므로 phase-01 에서 `rm-guard.spec.ts` 로 옮기고 옛 파일은 phase-02 에서 지운다.
- Python 표준 라이브러리와 JS 가 다른 곳을 경계 사례로 둔다: `str.format` 의 `.1f` 반올림(정확히 반인 값은 짝수로), JSON 의 실수 표기(`1.0`), 거듭 준 옵션과 `nargs="+"` 옵션, 접두 줄임, `float` 인자 형식, `os.walk` 의 링크 처리, 심볼릭 링크 뒤 `..`, `datetime.fromisoformat` 입력 형식, 지역 시간대로 읽는 `time.mktime`.
- `survey_gradle.sh` 는 `find`, `sort`, `grep` 조합이라 읽기 전용이다. 출력 절의 순서와 문구를 고정한다.

## 작업 항목

### 1. `tests/helpers.ts`
임시 폴더, 가짜 실행 파일 폴더, 명령 실행(env, cwd, stdin), 임시 git 저장소, 「명령 경계」 상수.

### 2. 명령마다 `tests/<명령>.spec.ts`
옛 `test_*.py` 의 사례와 위 경계 사례.

## 검증

```bash
node --test skills/mac-cleanup/tests/*.spec.ts
python3 -m unittest discover -s skills/mac-cleanup/tests
```

종료 코드 0. 새 테스트와 옛 Python 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/mac-cleanup/tests/helpers.ts` | 신규 |
| `skills/mac-cleanup/tests/survey-system.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/survey-sessions.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/survey-git.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/survey-gradle.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/docker-images.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/docker-volumes.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/check-pr-branches.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/delete-branches.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/delete-sessions.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/delete-volumes.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/colima-trim.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/rm-guard.spec.ts` | 신규 |
