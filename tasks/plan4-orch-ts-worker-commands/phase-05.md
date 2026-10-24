# Phase 05. doctor 를 옮기고 문서의 명령을 node 로 바꾼다

**Execution profile**: deep

## 목표

`orch-doctor` 를 TypeScript 로 옮기고 모르는 핸들러, 옛 설정 칸, 압축 뒤 복구를 본다.
이 plan 에서 옮긴 명령을 부르는 문서, 공통 지시서 틀, hook 의 거부 이유를 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/<명령>.ts"` 꼴로 바꾸고, 핸들러 사용법 문서를 만든다.

**범위 외**: 머지와 정리 명령. 그 명령을 부르는 문서 줄은 `python3 ...py` 로 남는다. shim 이 아니라 원본 Python 이다. shim 의 공통 처리(`orch/scripts/ts_shim.py`)는 고치지 않는다.

## 컨텍스트

시작 조건: 이 plan 의 phase 04 가 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/orch-doctor.py` | `orch/scripts/orch-doctor.ts` | `orch/tests/test_orch_doctor.py` → `orch/tests/orch-doctor.spec.ts` |
| `orch/scripts/questions.py` | 지운다. `lib/questions.ts` 가 대신한다 | |
| `orch/tests/test_template_script_path.py` | | → `orch/tests/template-script-path.spec.ts` |
| `orch/tests/test_readme_script_list.py` | | → `orch/tests/readme-script-list.spec.ts` |

`orch-doctor.py` 는 shim 으로 바꾸되 `ts_shim.exec_ts(__file__, deprecated=False)` 로 부른다. SKILL.md 가 doctor 를 이 경로로 부르는 공식 진입점이라 `DEPRECATED` 줄을 내지 않는다.
Node 버전 판정은 이 진입점이 한다. `ts_shim.exec_ts` 가 `node --version` 이 22.18 보다 낮으면 exec 하지 않고 stdout 에 `NODE-TOO-OLD <버전> 22.18 이상이 필요하다` 를 내고 127 로 끝난다.
`.ts` 안에서는 판정하지 않는다. 22.18 보다 낮은 node 는 `.ts` 를 읽지 못해 `ERR_UNKNOWN_FILE_EXTENSION` 으로 죽고 그 줄에 닿지 못한다.

`scripts/tests/test_doc_script_refs.py` 는 스킬마다 `python3 orch/scripts/orch-doctor.py --skip-version` 을 부른다. 이 경로가 그대로 진입점이라 고치지 않는다. CI 의 `Python tests` job 에는 이미 node 22 단계가 있다.

`fire` 의 시그니처는 `fire(event, input, ctx: { repo, base: string, run: string | null, cwd?, out? })` 이다(`lib/events.ts`).
`session-resume` 의 ctx 는 `repo` 가 `--repo`(없으면 작업 디렉터리의 `mainCheckout`), `base` 가 `defaultBase(repo)`(null 이면 `""`), `run` 이 `--run` 이다.
`orch/references/waiting.md` 의 `orch-doctor.py --run "$RUN_ID"` 처럼 `--run` 만 준 호출은 작업 디렉터리의 `mainCheckout` 을 저장소로 본다.

**근거 문서**: `docs/code-architecture.md` 의 「실행 규칙」 과 「orch 문서가 소유하는 것」, `docs/flow.md` 의 「이벤트 목록」 의 `session-resume` 줄과 「갈래」, `docs/data-schema.md`

## 의도 메모

- doctor 의 스크립트 판정은 `$SKILL_DIR/scripts/<이름>` 에서 `.py` 와 `.ts` 를 모두 읽는다. 원본 정규식 `REF` 가 확장자를 가리지 않으므로 그대로 옮긴다. 한 PR 동안 두 꼴이 문서에 섞인다.
- 지시서 공통 틀의 설치 경로 풀이는 `python3 -c` 한 줄이다. worker 환경에 Python 이 없어도 돌게 `node -e` 로 바꾼다. 풀이 규칙(`CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`, `installed_plugins.json` 의 `installPath`, user scope 우선)은 그대로다.
- shim 이 node 로 exec 하므로 옛 `.py` 경로로 띄운 감시도 ps 명령줄이 `node ... <이름>.ts` 가 된다. `.py` 이름을 찾는 ps 패턴은 아무것도 찾지 못해 감시를 두 번 띄우게 된다. 그래서 패턴을 확장자 없는 이름으로 바꾼다.
- 다음 major 에서 shim 을 지울 때 `orch-doctor.py` 는 버전 확인 진입점이라 함께 지울 수 없다. 그때 진입점을 어떻게 둘지는 그 plan 이 정한다.
- 버전 등급: 명령 실행에 Node 가 필요해지고 hook 판정이 바뀌므로 major 다. `3.0.0` 으로 올린다.

## 작업 항목

### 1. `orch-doctor.ts`

원본 판정과 출력(`OK-VERSION`, `STALE`, `MISSING`, `OK-SCRIPTS`, `SKIP-VERSION`, `UNANSWERED`, `SKIP-QUESTIONS`), 종료 코드를 옮기고 아래를 더한다.

| 항목 | 값 |
| --- | --- |
| `--repo DIR` | 새 옵션. 기본값은 작업 디렉터리의 `mainCheckout` |
| `UNKNOWN-HOOK <파일>` | `lib/events.ts` 의 `unknownHandlers(repo)` 가 낸 파일마다 한 줄. 경고라 종료 코드를 바꾸지 않는다(0) |
| `DEPRECATED-CONFIG <절>.<키> → hooks/<이벤트>.ts` | `repo` 의 `config.json` 에 `lib/config.ts` 의 `DEPRECATED_KEYS` 가 든 키마다 한 줄. 경고라 종료 코드를 바꾸지 않는다(0). `loadConfig` 가 `ConfigError` 를 던지면 그 이유를 stderr 에 내고 이 판정만 건너뛴다 |
| `waiters` | `ps -axo pid=,command=` 를 읽어 명령줄이 `watch-questions\|wait-important\|orchestration check` 에 맞고 `--run` 의 Run id 가 낱말로 든 행의 pid. doctor 자신의 pid 는 뺀다. `PS` 환경 변수로 ps 실행 파일을 바꾼다(`wait-important` 와 같다) |
| `unanswered` | 질문 조회가 낸 미답변 질문 id 전부. 조회하지 못했거나 `--skip-questions` 면 빈 목록 |
| `loop_alive` | 이 plan 에서는 늘 false 다. 상주 루프는 다른 plan 이다 |

`--run` 을 주면 위 값으로 `session-resume` 이벤트를 낸다. 핸들러 실패는 `HOOK-FAIL` 줄만 남기고 종료 코드를 바꾸지 않는다.

### 2. 명령 경로 바꾸기

바꿀 이름은 `spec-line`, `spec-lint`, `make-worktree`, `worktree-deny`, `launch-worker`, `send-to-worker`, `nudge-worker`, `worker-ask`, `wait-important`, `triage-messages`, `watch-questions` 다.

| 대상 | 바꾸기 |
| --- | --- |
| `orch/SKILL.md`, `orch/references/*.md`, `orch/README.md` 의 호출 | `python3 "$SKILL_DIR/scripts/<이름>.py"` → `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/<이름>.ts"`. `docs/code-architecture.md` 「실행 규칙」 의 「실행」 줄과 같은 꼴이다 |
| 같은 문서의 산문 이름 | `wait-important.py` 처럼 이름만 적은 곳은 확장자 없는 이름(`wait-important`)으로 쓴다 |
| doctor 호출 | 바꾸지 않는다. `orch/SKILL.md` 와 `orch/references/waiting.md` 는 `python3 "$SKILL_DIR/scripts/orch-doctor.py"` 로 둔다. 그 진입점이 Node 버전을 본다 |
| `orch/hooks/block-worker-terminal-send.ts` 의 `REASON` | `send-to-worker.py` 호출을 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/send-to-worker.ts"` 로, `nudge-worker.py` 를 `nudge-worker` 로 |
| `orch/hooks/require-spec-line.ts` 의 `REASON` | `spec-line.py`, `launch-worker.py` 를 확장자 없는 이름으로, `"$(python3 \"$SKILL_DIR/scripts/spec-line.py\" ...)"` 를 `"$(node --disable-warning=ExperimentalWarning \"$SKILL_DIR/scripts/spec-line.ts\" ...)"` 로. 판정은 바꾸지 않는다 |
| `orch/references/waiting.md` 의 압축 뒤 복구 ps 줄 | `grep -E "watch-questions.py\|wait-important.py\|orchestration check"` → `grep -E "watch-questions\|wait-important\|orchestration check"`. doctor 의 `waiters` 와 같은 패턴이다 |

`orch/templates/spec-common.md` 의 ask 블록은 아래 꼴로 바꾼다. JS 안에는 작은따옴표와 `<` 를 쓰지 않는다. 셸의 작은따옴표 인용이 끊기고, `test_bash_blocks_have_no_input_redirect_from_placeholder` 가 `<` 를 입력 리다이렉션으로 본다.

```bash
ORCH_SCRIPTS=$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";const e=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"].sort((a,b)=>(a.scope!=="user")-(b.scope!=="user"))[0];console.log(e.installPath+"/orch/scripts")') && node --disable-warning=ExperimentalWarning "$ORCH_SCRIPTS/worker-ask.ts" --from "$FROM" --question "$QUESTION"
```

같은 절의 산문 `worker-ask.py` 는 `worker-ask` 로 쓴다.

### 3. 문서

- `docs/code-architecture.md` 「실행 규칙」 의 「Node 버전」 줄을 고친다: 22.18 이상. 옛 `.py` 진입점의 `ts_shim.py` 가 `node --version` 을 보고 낮으면 exec 하지 않고 `NODE-TOO-OLD` 줄과 종료 코드 127 로 끝난다. SKILL.md 는 doctor 를 그 진입점(`orch-doctor.py`)으로 부른다. `.ts` 안에서 판정하지 않는 이유(낮은 node 는 `.ts` 를 읽지 못한다)를 함께 적는다
- `orch/references/hooks.md` 를 새로 쓴다. 이벤트를 고르는 법, 핸들러 파일 예시 하나(`before-launch.ts` 가 동시 worker 상한을 넘으면 10 으로 끝나는 것), 실패 줄 읽는 법, 가드 shim 이 막는 호출. 입력 필드 표는 옮겨 적지 않고 `lib/events.ts` 머리 주석과 `docs/data-schema.md` 를 가리킨다
- `orch/references/waiting.md` 「질문 감시와 압축 뒤 복구」 의 「조회 실패와 기록 한도 도달은 stderr 로 알리고」 를 고친다. 조회 실패는 stdout 의 `WATCH-ERROR` 줄이고, 조회 범위 안내는 stderr 다. `WATCH-ERROR` 를 받았을 때 할 일(같은 실패가 이어지면 doctor 로 질문 상태를 본다)을 적는다
- `orch/README.md` 스크립트 목록에 옮긴 `.ts` 명령을 `scripts/<이름>.ts` 로 적고, shim 인 `.py` 는 「옛 경로. 다음 major 에서 지운다」 로 묶는다. `orch-doctor.py` 는 진입점이라 따로 적는다. 지운 `scripts/questions.py` 줄은 뺀다
- `orch/CHANGELOG.md` 에 이 plan 을 `3.0.0` 한 항목으로 적고 `orch/SKILL.md` 의 `metadata.version` 을 `3.0.0` 으로 올린다. 호환성 안내에 아래를 모두 적는다
  - 옛 `.py` 경로는 PATH 에 node 22.18 이상이 있어야 돈다. 없으면 127 이다
  - stdout 에 `WATCH-ERROR`, `HOOK-FAIL`, `[hook ...]` 줄이 새로 섞인다
  - 옮긴 명령의 ps 명령줄이 `python3 ... .py` 에서 `node ... .ts` 로 바뀐다. `.py` 이름으로 프로세스를 찾는 도구는 확장자 없는 이름으로 찾는다
  - `watch-questions` 는 `ORCA_CLI_COMMAND` 를 읽지 않는다. 가짜 orca 는 `ORCA` 로 넣는다

### 4. 테스트

표의 테스트를 옮기고 원본을 지운다.

| 테스트 | 사례 |
| --- | --- |
| `orch-doctor.spec.ts` | `UNANSWERED`(가짜 orca 의 질문이 600초 이상 미답변이면 줄과 종료 코드 1, 599초면 없음), `SKIP-QUESTIONS`(질문 조회 실패면 줄과 종료 코드 0), `.orch/hooks/befor-merge.ts` 같은 오타 파일이 `UNKNOWN-HOOK` 이고 종료 코드 0, `config.json` 의 `queue.before` 가 `DEPRECATED-CONFIG` 이고 종료 코드 0, 문서의 `.ts` 참조가 없는 파일이면 `MISSING`, `--run` 과 가짜 `PS` 로 `.orch/hooks/session-resume.ts` 가 받은 `waiters` 에 `node .../wait-important.ts --run <id>` 행의 pid 가 있다 |
| `template-script-path.spec.ts` | 원본 사례를 모두 옮긴다. 경로 풀이 명령을 찾는 정규식은 원본 `ORCH_SCRIPTS=\$\((python3 -c '.*?')\) &&` 를 `ORCH_SCRIPTS=\$\((node -e '.*?')\) &&` 로 바꾼다 |
| `readme-script-list.spec.ts` | `orch/scripts/` 바로 아래의 `.py`, `.sh`, `.ts` 파일이 README 에 `` `scripts/<이름>` `` 으로 있어야 한다. 같은 폴더에 같은 이름의 `.ts` 가 있는 `.py` 는 shim 으로 보고 대조에서 뺀다. 원본 사례와 「shim 은 빠진다」, 「`.ts` 가 빠지면 알린다」 사례 |
| `orch/tests/test_ts_shim.py` | doctor 진입점 사례 하나를 더한다: PATH 앞의 가짜 node 가 `v22.17.0` 을 내면 `python3 orch/scripts/orch-doctor.py --skip-version --skip-questions` 가 127, stdout 에 `NODE-TOO-OLD`, stderr 에 `DEPRECATED` 가 없다. 버전 문자열 판정(`node_too_old`) 사례는 이 파일에 이미 있다 |
| `coordinator-hooks.spec.ts` | 거부 이유 문구를 단언하는 사례가 있으면 새 문구에 맞춘다 |

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-doctor.spec.ts orch/tests/template-script-path.spec.ts orch/tests/readme-script-list.spec.ts orch/tests/coordinator-hooks.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_ts_shim.py
python3 -m unittest discover -s scripts/tests
python3 scripts/run-orch-tests.py --jobs 4
claude plugin test .
out=$(node --disable-warning=ExperimentalWarning orch/scripts/orch-doctor.ts --skip-version --skip-questions) && printf '%s\n' "$out" | grep -q '^OK-SCRIPTS '
out=$(python3 orch/scripts/orch-doctor.py --skip-version --skip-questions) && printf '%s\n' "$out" | grep -q '^OK-SCRIPTS '
! git grep -nE 'python3 \\?"\$(SKILL_DIR/scripts|ORCH_SCRIPTS)/(spec-line|spec-lint|make-worktree|worktree-deny|launch-worker|send-to-worker|nudge-worker|worker-ask|wait-important|triage-messages|watch-questions)\.py' -- orch/SKILL.md orch/references orch/templates orch/README.md orch/hooks
! git grep -nE 'watch-questions\.py|wait-important\.py' -- orch/references/waiting.md
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/README.md orch/CHANGELOG.md orch/references/*.md orch/templates/spec-common.md docs/code-architecture.md
```

doctor 를 부르는 줄은 종료 코드 0 이고 `OK-SCRIPTS` 줄이 있어야 통과한다. `--skip-questions` 를 주어 지금 Orca 의 질문 상태와 무관하게 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-doctor.ts` | 신규 |
| `orch/scripts/orch-doctor.py` | 수정 |
| `orch/scripts/questions.py` | 삭제 |
| `orch/hooks/block-worker-terminal-send.ts` | 수정 |
| `orch/hooks/require-spec-line.ts` | 수정 |
| `orch/tests/orch-doctor.spec.ts` | 신규 |
| `orch/tests/template-script-path.spec.ts` | 신규 |
| `orch/tests/readme-script-list.spec.ts` | 신규 |
| `orch/tests/test_orch_doctor.py` | 삭제 |
| `orch/tests/test_template_script_path.py` | 삭제 |
| `orch/tests/test_readme_script_list.py` | 삭제 |
| `orch/tests/test_ts_shim.py` | 수정 |
| `orch/tests/coordinator-hooks.spec.ts` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/README.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/references/hooks.md` | 신규 |
| `orch/references/*.md` | 수정 |
| `orch/templates/spec-common.md` | 수정 |
| `docs/code-architecture.md` | 수정 |

## 구현 중 정한 것

- doctor 의 `waiters` 는 `wait-important` 와 `watch-questions` 의 pid 다. 그 자식인 `orchestration check --wait` 은 대기 하나를 둘로 세므로 빼고, 셸(`sh`, `bash`, `zsh`, `dash`, `fish`) 행과 doctor 자신도 뺀다. `docs/data-schema.md` 의 `session-resume` 줄이 이 정의를 소유한다.
