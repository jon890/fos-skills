# Phase 05. doctor 를 옮기고 문서의 명령을 node 로 바꾼다

**Execution profile**: deep

## 목표

`orch-doctor` 를 TypeScript 로 옮기고 Node 버전, 모르는 핸들러, 압축 뒤 복구를 본다.
이 plan 에서 옮긴 명령을 부르는 문서와 공통 지시서 틀을 `node "$SKILL_DIR/scripts/<명령>.ts"` 로 바꾸고, 핸들러 사용법 문서를 만든다.

**범위 외**: 머지와 정리 명령. 그 명령을 부르는 문서 줄은 `python3 ...py` 로 남는다. shim 이 아니라 원본 Python 이다.

## 컨텍스트

시작 조건: 이 plan 의 phase 04 가 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/orch-doctor.py` | `orch/scripts/orch-doctor.ts` | `orch/tests/test_orch_doctor.py` → `orch/tests/orch-doctor.spec.ts` |
| `orch/scripts/questions.py` | 지운다. `lib/questions.ts` 가 대신한다 | |
| `orch/tests/test_template_script_path.py` | | → `orch/tests/template-script-path.spec.ts` |
| `orch/tests/test_readme_script_list.py` | | → `orch/tests/readme-script-list.spec.ts`. `*.ts` 명령도 대조하고, shim 인 `.py` 는 대조에서 뺀다 |

`scripts/tests/test_doc_script_refs.py` 는 저장소 테스트라 Python 으로 남지만 doctor 를 `node` 로 부르게 고친다.
CI 의 `Python tests` job 은 이 테스트에서 node 를 부르게 되므로 `actions/setup-node@v4`(node-version `'22'`) 단계를 더한다. ubuntu 이미지의 기본 node 는 22.18 보다 낮을 수 있다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `orch-doctor.py` 에 둔다.

**근거 문서**: `docs/code-architecture.md` 의 「실행 규칙」 과 「orch 문서가 소유하는 것」, `docs/flow.md` 의 「이벤트 목록」 의 `session-resume` 줄과 「갈래」, `docs/data-schema.md`

## 의도 메모

- doctor 의 스크립트 판정은 `$SKILL_DIR/scripts/<이름>` 에서 `.py` 와 `.ts` 를 모두 읽는다. 한 PR 동안 두 꼴이 문서에 섞인다.
- 지시서 공통 틀의 설치 경로 풀이는 `python3 -c` 한 줄이다. worker 환경에 Python 이 없어도 돌게 `node -e` 로 바꾼다. 풀이 규칙(`CLAUDE_CONFIG_DIR`, `installed_plugins.json` 의 `installPath`)은 그대로다.
- 버전 등급: 명령 실행에 Node 가 필요해지고 hook 판정이 바뀌므로 major 다. `3.0.0` 으로 올린다.

## 작업 항목

### 1. `orch-doctor.ts`

원본 판정과 출력(`STALE`, `MISSING`, `SKIP-VERSION`, `UNANSWERED`, `SKIP-QUESTIONS`)을 옮기고 아래를 더한다.

| 줄 | 판정 |
| --- | --- |
| `NODE-TOO-OLD <버전>` | `process.versions.node` 가 22.18 보다 낮다. 종료 코드 1 |
| `UNKNOWN-HOOK <파일>` | `--repo` 를 주면 `lib/events.ts` 의 `unknownHandlers` 가 낸 파일마다 |
| `DEPRECATED-CONFIG <키>` | `--repo` 의 `config.json` 에 `lib/config.ts` 의 `DEPRECATED_KEYS` 가 있다 |

`--run` 을 주면 `session-resume` 이벤트를 낸다. 입력의 `loop_alive` 는 이 plan 에서는 늘 false 다(상주 루프는 다른 plan). `waiters` 는 `wait-important` 프로세스의 pid, `unanswered` 는 미답변 질문 id 다.

### 2. 문서

- `orch/SKILL.md`, `orch/references/*.md`, `orch/templates/spec-common.md`, `orch/README.md` 에서 이 plan 이 옮긴 명령의 `python3 "$SKILL_DIR/scripts/<이름>.py"` 를 `node "$SKILL_DIR/scripts/<이름>.ts"` 로 바꾼다. 대상은 `spec-line`, `spec-lint`, `make-worktree`, `worktree-deny`, `launch-worker`, `send-to-worker`, `nudge-worker`, `worker-ask`, `wait-important`, `triage-messages`, `watch-questions`, `orch-doctor` 다
- `orch/references/hooks.md` 를 새로 쓴다. 이벤트를 고르는 법, 핸들러 파일 예시 하나(`before-launch.ts` 가 동시 worker 상한을 넘으면 10 으로 끝나는 것), 실패 줄 읽는 법, 가드 shim 이 막는 호출. 입력 필드 표는 옮겨 적지 않고 `lib/events.ts` 머리 주석을 가리킨다
- `orch/references/waiting.md` 「질문 감시와 압축 뒤 복구」 에 `WATCH-ERROR` 줄을 받았을 때 할 일을 적는다
- `orch/README.md` 스크립트 목록에서 shim 은 「옛 경로. 다음 major 에서 지운다」 로 묶는다
- `orch/CHANGELOG.md` 에 이 plan 을 한 항목으로 적고 `SKILL.md` 의 `metadata.version` 을 `3.0.0` 으로 올린다. Node 22.18 이상이 필요하다는 것과 shim 을 적는다

### 3. 테스트

표의 테스트를 옮기고 원본을 지운다. `orch-doctor.spec.ts` 에 더할 사례: 낮은 버전을 흉내 낸 입력에서 `NODE-TOO-OLD`, `.orch/hooks/befor-merge.ts` 같은 오타 파일이 `UNKNOWN-HOOK`, 문서의 `.ts` 참조가 없는 파일이면 `MISSING`.
버전 판정 함수는 버전 문자열을 인자로 받게 두어 테스트가 실제 node 를 바꾸지 않게 한다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-doctor.spec.ts orch/tests/template-script-path.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
python3 scripts/run-orch-tests.py --jobs 4
claude plugin test .
node --disable-warning=ExperimentalWarning orch/scripts/orch-doctor.ts --skip-version
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/README.md orch/references/*.md orch/templates/spec-common.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-doctor.ts` | 신규 |
| `orch/scripts/orch-doctor.py` | 수정 |
| `orch/scripts/questions.py` | 삭제 |
| `orch/tests/orch-doctor.spec.ts` | 신규 |
| `orch/tests/template-script-path.spec.ts` | 신규 |
| `orch/tests/readme-script-list.spec.ts` | 신규 |
| `orch/tests/test_orch_doctor.py` | 삭제 |
| `orch/tests/test_template_script_path.py` | 삭제 |
| `orch/tests/test_readme_script_list.py` | 삭제 |
| `scripts/tests/test_doc_script_refs.py` | 수정 |
| `.github/workflows/ci.yml` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/README.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/references/hooks.md` | 신규 |
| `orch/references/*.md` | 수정 |
| `orch/templates/spec-common.md` | 수정 |
