# Phase 01. 실행기 하나와 파일별 reporter

**Execution profile**: standard

## 목표

`scripts/run-tests.ts` 가 `tsc`, `node --test` 한 번, Python 묶음을 함께 돌고, `scripts/run-node-tests.ts` 와 같은 인자, 옵션, 요약 줄, 「결과: 」 끝 줄, 종료 코드를 낸다. 옛 실행기와 그 Python 테스트를 지운다.

**범위 외**: CI workflow, `.orch/overlay.md`, README, `docs/code-architecture.md`(phase 02). testkit(계획 testkit-core). 이 phase 의 테스트는 testkit 을 import 하지 않는다. 두 계획이 나란히 가기 때문이다.

## 컨텍스트

- 지금 실행기 `scripts/run-node-tests.ts` 의 계약: 인자는 파일이나 glob(`expand`, 파일 시스템), 옵션 `--concurrency`(기본 4), `--timeout`(기본 600), `--out`, `--background`, `--wait`, `--max-wait`(기본 540). 결과 폴더에 `summary.txt`, `runner.pid`, `runner.log`. 요약 줄 `통과 <파일> <초>s`, `실패 <파일> <초>s (<이유>) 로그: <로그>`. 끝 줄 `결과: 통과 P, 실패 F, 전체 T`. `--wait` 는 ` 실패 0,` 으로 판정한다. 종료 코드 0, 1, 2, 3 의 뜻은 그 파일 머리 주석에 있다. 이 계약을 지킨다(스펙 DECISION21). 끝 줄에는 `, 걸린 시간 Ss` 를 더한다(스펙 DECISION22).
- 옮길 테스트: `scripts/tests/test_run_node_tests.py` 의 여섯 사례(`test_group_signal_from_one_file_does_not_stop_the_rest`, `test_all_passing_exits_zero`, `test_per_file_timeout_kills_the_session_and_fails`, `test_background_then_wait_reads_the_end_line`, `test_wait_reports_a_runner_that_died_without_the_end_line`, `test_usage_errors`). 그룹 신호 사례는 바뀐다(아래 의도 메모).
- 설계의 「실행기」 절이 묶음 찾기, 인자, 단계, reporter, 대조, 무진행 감시, `tsc` 설치, 끝 줄, 종료 코드를 정한다. 이 phase 는 그 절을 그대로 구현한다.
- Node 24 의 파일 단위 사건: 파일 하나가 끝나면 nesting 0 이고 `name` 이 명령줄에 준 경로 그대로인 `test:complete` 가 온다. 파일 안의 최상위 테스트도 nesting 0 으로 오므로 이름이 넘긴 경로 목록에 든 것만 파일 사건이다. `details.passed`, `details.duration_ms`, 실패면 `details.error`(`failureType`, `exitCode`, `signal`)가 있다. 파일 사건의 실패는 assert 실패든 시간 초과든 `failureType: 'subtestsFailed'`, `exitCode: 1` 이고, 시간 초과는 하위 테스트 사건에만 `testTimeoutFailure` 로 온다. 파일별 `test:summary` 는 `process.exit`, 신호, import 실패로 끝난 파일에 오지 않는다(2026-11-05 실험).
- `NODE_TEST_CONTEXT` 를 물려받은 `node --test` 는 reporter 출력을 내지 않는다. 실행기가 테스트 안에서 불려도 동작하게 모든 자식 환경에서 지운다.

- 계획 testkit-core 와 나란히 간다. 그 계획이 먼저 머지되면 CI 의 node 테스트 줄과 `scripts/run-node-tests.ts` 의 `DEFAULT_PATTERNS` 에 `modules/testkit/tests/*.spec.ts`, `scripts/tests/*.spec.ts` 가 더해져 있다. 이 계획은 두 곳을 지우거나 바꾸므로 rebase 때 이 계획 쪽을 따른다. `tsconfig.json` 의 `modules/**/*.ts` 는 남긴다.

**요구사항**: REQ7, REQ10

**근거 문서**: `docs/features/test-speed/spec.md`(DECISION9, DECISION13~15, DECISION20~22), `docs/features/test-speed/design.md` 「실행기」, DECISION7~10, DECISION14

## 의도 메모

- 그룹 신호 격리를 두지 않는다(설계 DECISION14). 그래서 옛 사례 「그룹 신호를 보내는 파일이 섞여도 나머지가 돈다」 는 「그룹에 신호를 보내 node 단계가 끊기면, 보고가 없는 파일이 `실패 <파일> 0.0s (보고 없음)` 으로 세져 끝 줄이 실패 0 이 아니다」 로 바꿔 옮긴다.
- 파일마다의 시간 제한은 `--test-timeout`(테스트 하나)과 무진행 감시로 바뀐다. 옛 사례 「파일별 시간 초과가 세션을 끝내고 실패로 센다」 는 「테스트가 끝나지 않거나 stdio 를 쥔 손자를 남기면 `--timeout` 뒤 그 파일이 `시간 초과` 실패다」 로 옮긴다.
- `tsc` 상수는 `typescript@5.9.3`, `@types/node@24.19.2` 다. CI 의 지금 값(`@types/node@24`)은 범위라 로컬 캐시와 어긋날 수 있어 정확한 값으로 고정한다(설계 DECISION9).
- 테스트에서 실제 npm 설치를 하지 않는다. `FOS_TSC_DIR` 에 `node_modules/.bin/tsc` 가짜를 둔 폴더를 준다.

## 작업 항목

### 1. `scripts/run-tests-reporter.ts`

- 기본 내보내기 `async function* (source)`. 실행기가 넘긴 경로 목록을 환경 변수 `RUN_TESTS_FILES`(JSON 배열)에서 읽는다.
- `failureType === 'testTimeoutFailure'` 인 `test:fail` 을 파일별로 센다(중첩 깊이를 따지지 않는다). 열쇠는 하위 사건의 `data.file` 과 파일 사건의 `data.file` 을 모두 `realpathSync` 로 맞춘 값이다. 두 쪽이 심볼릭 링크 경유 경로(`/var/...`)와 실제 경로로 갈릴 수 있다.
- nesting 0 이고 `data.name` 이 목록에 든 `test:complete` 마다 `JSON.stringify({ file: data.name, passed, ms, failureType, exitCode, signal, timedOut })` 한 줄을 낸다. `timedOut` 은 그 파일에서 센 시간 초과가 있는지다. 그 밖의 사건은 버린다.
- 타입 제거가 지우는 문법만 쓴다.

### 2. `scripts/run-tests.ts`

- 머리 주석: 사용법, 옵션, 결과 폴더, 종료 코드(옛 실행기 머리 주석을 옮기고 고친다). 「왜 필요한가」 는 「두 언어와 tsc 를 명령 하나로 돈다. 묶음 목록과 TypeScript 버전의 원본이다」 로 바꾼다. TypeScript 를 저장소 밖 캐시 폴더에 설치하는 이유(저장소에 `package.json` 과 `node_modules` 를 두지 않는다, `docs/code-architecture.md` 「실행 규칙」 의 「의존」)를 적는다. 지금 CI 의 Type check 단계 주석과 같은 이유다.
- `parseArgs` 는 옛 것과 같은 옵션과 오류 문구를 쓴다.
- 묶음 찾기: 인자가 없으면 `git ls-files -z --cached --others --exclude-standard` 를 `existsSync` 로 다시 확인하고, `(^|/)tests/` 아래 `.spec.ts` 를 node 파일로, `tests/test_*.py` 를 가진 `tests` 폴더를 Python 묶음으로 고른다. git 이 실패하면 「git 저장소가 아니다」 와 2. 인자가 있으면 옛 `expand` 로 푼다. `test_*.py` 파일이면 그 폴더가, `test_*.py` 를 바로 가진 폴더면 그 폴더가 Python 묶음이다. 그 밖의 폴더는 그 아래 `*.spec.ts` 를 node 파일로 펼친다. 나머지 파일은 node 파일이다. `tsc` 는 인자가 없을 때만 돈다.
- 단계를 모두 `detached: true` 로 함께 띄우고 `running` 집합에 넣는다. SIGINT, SIGTERM 은 모든 그룹을 SIGKILL 하고 2 로 끝낸다(옛 `stop`).
- node 단계: `[process.execPath, '--test', '--test-concurrency=N', '--test-timeout=' + timeout*1000, '--test-reporter=' + reporter, '--test-reporter-destination=stdout', '--test-reporter=spec', '--test-reporter-destination=' + log, ...files]`. env 는 `NODE_TEST_CONTEXT` 를 지우고, `NODE_COMPILE_CACHE` 가 없으면 `${XDG_CACHE_HOME:-~/.cache}/fos-skills/node-compile-cache` 를 준다. env 에 `RUN_TESTS_FILES` 를 넣는다. stdout 을 줄 단위로 읽어 요약 줄을 낸다. 요약 줄의 `<파일>` 은 reporter 가 준 `file`(넘긴 경로)이다. 이유는 이 순서로 고른다. `signal` 이 있으면 `신호 S`, `timedOut` 이면 `시간 초과`, `failureType === 'subtestsFailed'` 면 `테스트 실패`, 그 밖은 `종료 코드 N`.
- 무진행 감시: 마지막 요약 줄(또는 시작)에서 `--timeout` 초가 지나면 그 그룹을 SIGKILL 하고 남은 파일을 `시간 초과` 로 센다.
- 대조: node 단계가 끝나면 보고가 없는 파일마다 `실패 <파일> 0.0s (보고 없음) 로그: <로그>`. 종료 코드가 0 이 아닌데 실패 줄이 하나도 없으면 `실패 node 단계 0.0s (종료 코드 N) 로그: <로그>`.
- Python 단계: `ceil(N/2)` 개씩 `python3 -m unittest discover -s <폴더>` 를 저장소 루트에서 띄운다. 묶음마다 `--timeout` 제한. 요약 줄의 이름 자리는 폴더다. `python3` 를 띄우지 못하면(`ENOENT`) 남은 묶음마다 `실패 <폴더> 0.0s (python3 가 없다)`.
- `tsc` 단계: 설계 「실행기」 의 설치 규칙(`FOS_TSC_DIR`, 기본 캐시 폴더, `<폴더>.tmp-<pid>` 에 설치, `rename`, 죽은 pid 의 임시 폴더 정리, `.bin/tsc` 로 설치됨 판정) 뒤 `<폴더>/node_modules/.bin/tsc -p tsconfig.json --typeRoots <폴더>/node_modules/@types`. npm 이 없거나 설치·검사가 실패하면 `실패 tsc <초>s (<이유>) 로그: <로그>`.
- 끝 줄 `결과: 통과 P, 실패 F, 전체 T, 걸린 시간 Ss`. `--background` 의 기다리기 안내는 `node scripts/run-tests.ts --wait "<폴더>"`. `wait` 함수는 옛 것을 옮긴다.

### 3. 지울 것

- `scripts/run-node-tests.ts`, `scripts/tests/test_run_node_tests.py`.

### 4. 이 phase 를 검증하는 `scripts/tests/run-tests.spec.ts`

- 요약 줄과 끝 줄은 정규식으로 단언한다(예: `/^실패 a\/tests\/bad\.spec\.ts [\d.]+s \(테스트 실패\)/m`). 걸린 시간 자리가 실행마다 바뀐다.

- 임시 git 저장소(내장 `spawnSync('git', ...)` 와 `GIT_CONFIG_GLOBAL=/dev/null`)에 `a/tests/ok.spec.ts`, `a/tests/bad.spec.ts`, `b/tests/test_ok.py`, git 이 무시하는 `ignored/tests/x.spec.ts` 를 둔다. `c/tests/test_gone.py` 는 커밋한 뒤 작업 트리에서 지운다. 실행기를 그 cwd 에서 `FOS_TSC_DIR=<가짜 tsc 폴더>` 로 돌린다. 요약 줄 셋(`통과 a/tests/ok.spec.ts`, `실패 a/tests/bad.spec.ts (테스트 실패)`, `통과 b/tests`)과 `통과 tsc`, 끝 줄 `결과: 통과 3, 실패 1, 전체 4, 걸린 시간 `, 종료 코드 1, `ignored` 와 `c/tests` 가 없는 것을 본다.
- 실패하는 Python 묶음(`d/tests/test_bad.py`)을 인자로 주면 `실패 d/tests` 와 1.
- `--test-timeout` 에 걸리는 테스트(`{ timeout: 100 }` 로 오래 기다림)가 든 파일은 `(시간 초과)` 실패다.
- 모두 통과면 0. 인자로 파일 하나를 주면 그것만 돌고 `tsc` 줄이 없다.
- `process.exit(3)` 하는 파일과 `process.kill(0, 'SIGTERM')` 하는 파일: 실패 0 이 아니고, 끊겨 보고가 없는 파일은 `(보고 없음)` 줄이다.
- `--timeout 2` 와 stdio 를 쥔 `sleep 30` 손자를 남기는 파일: 30초보다 훨씬 일찍 `시간 초과` 실패로 끝난다.
- python3 없음: macOS 는 `git` 과 `python3` 가 같은 `/usr/bin` 에 있어 PATH 에서 하나만 뺄 수 없다. 그래서 Python 묶음 폴더를 인자로 주고(git 이 필요 없다) PATH 를 `process.execPath` 의 폴더 하나로 둔다. Python 묶음이 `(python3 가 없다)` 실패다.
- 가짜 tsc 가 1 로 끝나면 `실패 tsc` 와 종료 코드 1. `FOS_TSC_DIR` 이 빈 폴더이고 PATH 에 npm 이 없으면 `실패 tsc` 줄의 이유가 npm 이 없다는 뜻이고 종료 코드 1. 이 사례는 인자 없이 돌아야 tsc 단계가 생겨 git 이 필요하다. PATH 는 `git` 의 심볼릭 링크 하나만 둔 임시 폴더로 둔다. `process.execPath` 의 폴더에는 npm 이 있어(버전 관리 도구 설치) 실제 네트워크 설치가 돌 수 있기 때문이다. 실행기는 node 를 `process.execPath` 로 띄우므로 PATH 에 node 가 없어도 된다.
- `--background` 뒤 `--wait` 가 끝 줄을 읽고 0, `--max-wait 1` 로 아직 안 끝난 폴더면 3, 실행기 pid 가 죽고 끝 줄이 없으면 2, 사용법 오류(모르는 옵션, 값 없는 옵션, `--concurrency 0`, `--wait <없는 폴더>`, 대상 없음)는 2. 인자 없이 git 밖(`GIT_CEILING_DIRECTORIES` 를 그 임시 폴더의 부모로 건 git 아닌 폴더)도 2.
- 부모 환경에 `NODE_TEST_CONTEXT=child-v8` 을 넣어 돌려도 요약 줄이 나온다.

## 검증

```bash
node --test scripts/tests/run-tests.spec.ts
node scripts/run-tests.ts scripts/tests/run-tests.spec.ts
npm install --no-save --no-audit --no-fund --prefix "$TMPDIR/tsc" typescript@5.9.3 @types/node@24.19.2 && "$TMPDIR/tsc/node_modules/.bin/tsc" -p tsconfig.json --typeRoots "$TMPDIR/tsc/node_modules/@types"
node scripts/run-tests.ts --bogus; test $? -eq 2
test ! -e scripts/run-node-tests.ts && test ! -e scripts/tests/test_run_node_tests.py
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `scripts/run-tests.ts` | 신규 |
| `scripts/run-tests-reporter.ts` | 신규 |
| `scripts/tests/run-tests.spec.ts` | 신규 |
| `scripts/run-node-tests.ts` | 삭제 |
| `scripts/tests/test_run_node_tests.py` | 삭제 |
