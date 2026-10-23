# Phase 05. Python 테스트 러너를 지우고 CI 와 문서를 TypeScript 명령에 맞춘다

**Execution profile**: standard

## 목표

orch 의 격리 테스트 러너를 지우고 `node --test` 하나로 orch 와 work-board 테스트를 돌린다.
문서가 부르는 남은 Python 명령을 `.ts` 로 바꾸고, 이 저장소의 구조 문서를 실제 배치에 맞춘다.

**범위 외**: 옛 `.py` shim 을 지우는 일. 다음 major 에서 한다.

## 컨텍스트

시작 조건: 이 plan 의 phase 04 가 커밋됐다. 이때 `orch/tests/` 와 `work-board/tests/` 에는 Python 테스트가 없다.

`scripts/run-orch-tests.py` 는 Python 테스트를 파일마다 다른 프로세스로 돌리던 러너다. `node --test` 는 파일마다 프로세스를 나누므로 필요 없다. 그 러너의 테스트 `scripts/tests/test_run_orch_tests.py` 도 지운다.
CI 의 `Python tests` job 은 `*/tests` 와 `tools/*/tests` 를 돌며 `python3 -m unittest discover` 를 부르고 `orch/tests` 만 건너뛴다. Python 테스트가 없는 폴더에서 unittest 는 「테스트를 하나도 돌리지 않았다」 로 실패 종료 코드(5)를 낸다. 그래서 `work-board/tests` 도 건너뛰게 해야 한다.
`Plugin tests` job 의 node 테스트 단계(`node --test --test-concurrency=4 "orch/tests/*.spec.ts"`)에 `"work-board/tests/*.spec.ts"` 를 더한다. job 이름은 바꾸지 않는다. 필수 체크 이름이다.

**근거 문서**: `docs/code-architecture.md` 의 「실행 규칙」 의 테스트 줄, `docs/adr/010-orch-typescript.md`

## 의도 메모

- `docs/code-architecture.md` 의 「orch 코어와 핸들러」 절 머리의 「구현 PR 이 모두 머지되기 전」 문장은 상주 루프 plan 이 끝날 때 지운다. 이 phase 에서는 그대로 둔다.

## 작업 항목

### 1. 러너와 그 테스트를 지운다

`scripts/run-orch-tests.py`, `scripts/tests/test_run_orch_tests.py` 를 지운다.

### 2. `.github/workflows/ci.yml`

- `Python tests` job 의 「Run isolated orch tests」 단계를 지운다
- 같은 job 의 순회에서 `orch/tests` 와 `work-board/tests` 를 건너뛴다. 건너뛰는 이유(Python 테스트가 없다)를 주석으로 단다
- `Plugin tests` job 의 node 테스트 단계에 `"work-board/tests/*.spec.ts"` 를 더한다

### 3. 문서

- `README.md` 「기여」, `.orch/overlay.md`, `orch/README.md` 의 테스트 명령을 `node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"` 로 바꾼다
- `orch/SKILL.md`, `orch/references/*.md`, `work-board/README.md` 에서 남은 `python3 "$SKILL_DIR/scripts/<이름>.py"` 와 `board.py` 호출을 `.ts` 로 바꾼다. `git grep -n "python3 .*orch/scripts\|scripts/[a-z_-]*\.py\|board\.py" -- orch work-board README.md` 로 남은 곳을 찾는다. CHANGELOG 의 지난 항목은 이력이라 고치지 않는다
- `orch/references/heavy-checks.md` 에 `heavy` 절 분류와 `wait_idle` 을 적는다. 기본값 표에서 자동 분류 설명을 지운다
- `docs/code-architecture.md` 의 「디렉터리 배치」 의 `work-board/` 줄, 「검증」 표, 「모듈 책임」 표를 실제 파일에 맞춘다
- `orch/CHANGELOG.md` 와 `work-board/CHANGELOG.md` 가 있으면 각각 이 plan 을 한 항목으로 적고 minor 를 올린다

### 4. 남은 Python 을 확인하는 검사

`orch/tests/readme-script-list.spec.ts` 에 사례를 더한다: `orch/scripts/` 의 `.py` 파일은 모두 shim 이다. shim 판정은 파일이 `os.execvp` 와 같은 이름의 `.ts` 를 가리키는지로 한다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
claude plugin test .
! test -e scripts/run-orch-tests.py
python3 korean-check/scripts/korean-style-check.py README.md orch/SKILL.md orch/README.md orch/references/*.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `scripts/run-orch-tests.py` | 삭제 |
| `scripts/tests/test_run_orch_tests.py` | 삭제 |
| `.github/workflows/ci.yml` | 수정 |
| `README.md` | 수정 |
| `.orch/overlay.md` | 수정 |
| `orch/README.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/references/*.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `work-board/README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/tests/readme-script-list.spec.ts` | 수정 |
