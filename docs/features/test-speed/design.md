# 테스트: node 테스트 묶음의 시간을 줄인다: 기술 설계

스펙: [spec.md](spec.md). PR 순서는 스펙 DECISION5 와 DECISION10 이 정한다. 이 설계는 PR 마다 고칠 곳과 지킬 조건을 정하고, 뒤 PR 은 그 PR 을 띄울 때 해당 절을 보강한다.

| PR | 내용 | 시점 |
| --- | --- | --- |
| PR1 | 같은 git 조회 기억(#336) | 머지됨 |
| PR2 | testkit 첫 판(`modules/testkit`)과 기존 fixtures 이전, 내보내는 폴더의 import 검사 | orch-cli PR3 앞 |
| PR3 | 실행기 하나(`scripts/run-tests.ts`), CI job 하나, 로컬 검증 문서 | orch-cli PR3 앞, PR2 뒤 |
| PR4~ | 파일 묶음마다 가짜 재사용, 템플릿 저장소, 함수 주입 전환(merge-queue, orch-loop 계열, cleanup-sweep 계열, launch-worker 와 나머지) | orch-cli PR3 뒤 |
| 마지막 | 대기 옵션 정리와 2분 목표 확인 | 실행기 전체가 600초 아래로 내려온 뒤 |

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 각 PR 은 테스트가 보는 동작을 바꾸지 않는다. 스크립트 수정(PR1)은 기존 테스트를 그대로 두고, 테스트 수정(뒤 PR)은 지운 프로세스 테스트와 같은 판정을 보는 함수 테스트를 같은 PR 에 남긴다 |
| REQ2 | PR1 의 기억은 git 이 같은 답을 낼 조건이 그대로일 때만 꺼낸다(「PR1: 기억을 다시 확인하는 조건」). 기존 테스트 파일은 케이스를 더하기만 하고, 기존 케이스를 고치지 않은 채 통과시킨다 |
| REQ3 | 측정은 「측정 방법」 절의 두 가지로 같은 머신에서 전후를 번갈아 잰다. 하나는 사본 그대로 돌린 실제 걸린 시간(wall-clock, 시작부터 끝까지 흐른 시간. CPU 시간 합계와 다르다)이고, 다른 하나는 preload 로 센 기동 수다. 결과는 PR 본문에 적는다 |
| REQ4 | 원인을 하나씩 줄이고, 마지막 PR 에서 부하가 낮을 때 실행기를 옵션 없이 돌려 끝 줄의 실제 걸린 시간을 잰다(「실행기」) |
| REQ5 | PR2 가 `modules/testkit` 에 도우미 다섯과 그 테스트를 두고, `skills/orch/tests/fixtures/fake-bin.ts` 와 `cleanup-sweep.ts` 의 `makeRepo` 를 testkit 위로 옮긴다(「testkit 의 모듈」) |
| REQ6 | testkit 의 가짜 실행 파일은 본문에 경로를 넣지 않아 내용이 종류마다 하나이고, 프로세스마다 원본 하나를 만들어 하드 링크로 건다(「가짜 실행 파일」) |
| REQ7 | PR3 의 실행기가 묶음을 git 파일 목록에서 찾아 `tsc`, `node --test` 한 번, Python 묶음을 함께 돌고 지금 실행기의 출력 계약을 지킨다(「실행기」) |
| REQ8 | PR3 이 CI 를 job 하나로 합치고 `.orch/overlay.md`, README 가 같은 명령을 적게 한다(「CI 와 로컬 검증」) |
| REQ9 | PR2 가 내보내는 폴더 밖으로 나가는 상대 import 를 찾는 node 테스트를 둔다(「내보내기 경계 검사」) |
| REQ10 | 실행기의 `tsc` 단계가 CI 와 같은 TypeScript 버전과 `tsconfig.json` 을 쓰고, CI 는 그 단계만 쓴다(「실행기」 의 `tsc` 단계) |

## 책임과 경계

- PR1(같은 git 조회 반복): `skills/orch/scripts/lib/git.ts` 의 `mainCheckout` 과 `skills/orch/scripts/lib/paths.ts` 의 `ensureIgnored` 가 자기 결과를 프로세스 안에서 기억한다. 부르는 쪽(orch 명령과 lib 모듈)은 바꾸지 않는다. 기억은 두 함수의 모듈 변수가 소유한다. 다시 확인하는 데 쓰는 `.git` 찾기 함수 하나만 git.ts 가 내보내 paths.ts 와 함께 쓴다.
- 이미 있는 캐시는 그대로 둔다. `lib/gh.ts` 의 `contexts` 는 `mainCheckout` 과 origin 주소를 60초 묶어 기억하고, `lib/gh-budget.ts` 의 `roots` 는 `[repo, ORCH_DIR]` 열쇠로 `orchDir` 을 기억한다. 두 캐시가 놓친 호출이 이제 기억에 걸릴 뿐이고, gh.ts 의 60초는 origin 주소 때문에 남긴다.
- 가짜 실행 파일 재사용(DECISION6), 테스트 준비 git, 함수 주입 전환(DECISION4), 실행기 제거(DECISION1)는 테스트 쪽(`skills/orch/tests/`, `scripts/run-node-tests.ts`, README)만 바꾼다. 스크립트의 출력 계약은 건드리지 않는다.
- 자식 프로세스에 결과를 넘기지 않는다. 틱과 정리처럼 orch 명령이 다른 orch 명령을 띄우면 자식은 처음 한 번 다시 묻는다.
- testkit(`modules/testkit`)은 테스트 준비만 소유한다. 내장 모듈만 import 하고 저장소의 다른 폴더를 import 하지 않는다. 의존 방향은 테스트 → testkit 한쪽이다. 스크립트(운영 코드)는 testkit 을 import 하지 않는다.
- 저장소 배치의 원본은 `docs/code-architecture.md` 「디렉터리 배치」 표다. PR2 가 `modules/` 행(여러 영역의 코드가 함께 쓰는 공용 모듈. 스킬이 아니다)을 더한다. 소유 경계의 분리 신호(쓰는 사람, 배포 환경, 데이터 생명주기, 운영 코드의 역참조)는 하나도 걸리지 않는다. 쓰는 사람은 이 저장소의 테스트이고, 배포는 플러그인 설치본의 루트 복사에 함께 실리며, 데이터가 없다.
- orch 에만 맞는 것은 orch fixtures 에 남는다. `ORCH_GH_CACHE=0`, 가짜 gh, orca 의 상태 꼴, `ORCA_TERMINAL_HANDLE` 지우기가 여기 든다. fixtures 는 testkit 을 감싸는 얇은 층이 된다.
- 실행기(`scripts/run-tests.ts`)는 저장소의 검증 명령을 소유한다. 묶음 찾기, 단계 실행, 요약과 끝 줄, 대기 옵션이 여기 든다. testkit 을 import 하지 않는다. 실행기는 테스트를 돌리는 쪽이고 testkit 은 테스트 안에서 쓰는 쪽이다.
- CI workflow 는 실행기를 부르기만 한다. TypeScript 버전, 묶음 목록, `NODE_COMPILE_CACHE` 같은 값은 실행기가 갖는다.
- 내보내기 경계 검사는 `scripts/export-to-team.sh` 의 `SHARED_SKILLS`, `SHARED_TOOLS` 를 읽기만 하고 그 스크립트를 바꾸지 않는다.

## 인터페이스와 데이터

### PR1: 무엇을 기억하나

- 실측(orch-loop.spec.ts, 11/04): 같은 git 조회 5,177회 가운데 대부분이 git 밖 임시 폴더에서 실패한 답이다. orch 테스트 24개 파일이 `GIT_CEILING_DIRECTORIES` 를 걸고 git 밖 폴더를 `--repo` 로 준다. 그래서 실패한 답도 기억해야 테스트 시간이 준다.
- `mainCheckout(repo)` 의 열쇠는 `real(repo)` 와 git 탐색에 닿는 환경 변수(`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`)의 묶음이다. 값은 돌려준 경로와 그 답이 git 이 찾은 저장소에서 왔는지(찾음), 받은 폴더를 그대로 돌려준 것인지(못 찾음)다. 못 찾음에는 git 밖, 없는 폴더, bare 저장소, git 실패가 들어간다.
- `ensureIgnored(repo)` 의 열쇠는 주 checkout, 루트(`orchDir(repo)`), 같은 환경 변수의 묶음이다. 결과는 무시됨(`check-ignore` 가 0, exclude 에 같은 줄이 있음, 줄을 방금 더함)과 저장소 아님(`rev-parse --git-dir` 실패) 두 가지를 기억한다. `--git-path` 실패는 기억하지 않는다.
- 기억이 있으면 git 을 띄우지 않고 기억이 없을 때와 같은 값을 돌려준다. `ensureIgnored` 는 두 경우 모두 null 이다.

### PR1: 기억을 다시 확인하는 조건

- 찾음: 꺼낼 때 열쇠의 폴더와 돌려줄 주 checkout 이 둘 다 `existsSync` 로 있어야 쓴다. 워크트리를 지웠거나 주 checkout 을 옮겼으면 다시 묻는다. 기억이 없을 때 git 이 실패해 받은 폴더를 돌려주는 경우와 같게 하려는 것이다.
- 못 찾음, 저장소 아님: `GIT_DIR` 이 없고 그 폴더와 모든 조상에 `.git`(파일이나 폴더)이 없을 때만 기억하고, 꺼낼 때도 같은 조건을 다시 본다. `.git` 이 생기면(`git init`, `git worktree add`, `clone`) 다시 묻는다. 조상까지 보는 것은 하위 폴더를 물은 뒤 상위 폴더를 저장소로 만드는 경우 때문이다. 탐색은 `GIT_CEILING_DIRECTORIES` 를 보지 않아 기억을 덜 쓸 뿐 틀린 값을 내지 않는다.
- bare 저장소는 다시 확인하지 않아도 된다. 폴더나 조상이 bare 저장소가 되어도 `mainCheckout` 의 답은 받은 폴더 그대로다(`--show-toplevel` 이 실패한다). `ensureIgnored` 의 저장소 아님은 예외다. 그 폴더가 bare 가 되면 기억이 없을 때는 bare 의 `info/exclude` 에 줄을 쓴다. 같은 프로세스에서 이미 물은 폴더를 bare 로 만드는 흐름이 orch 명령에 없어 다루지 않는다.
- 무시됨: 주 checkout 이 있으면 쓴다. 같은 프로세스 안에서 `.gitignore` 가 바뀌거나 누가 무시 줄을 지우면 그 프로세스가 끝날 때까지 다시 더하지 않는다(「실패와 일관성」).

### testkit 의 모듈

파일마다 하나의 도우미 묶음이다. 테스트는 `../../../modules/testkit/<파일>.ts` 처럼 상대 경로로 import 한다. 이름은 구현에서 바뀔 수 있고, 꼴과 규칙은 아래가 정한다.

| 파일 | 내보내는 것 | 규칙 |
| --- | --- | --- |
| `temp.ts` | `tempDir(prefix, t?)` | `realpathSync(mkdtempSync(...))` 를 돌려준다. 만든 폴더는 모듈 수준 목록에 모은다. 모듈을 처음 평가할 때(테스트 파일 최상위 import, 루트 문맥) 루트 `after` 하나와 `process.on('exit')` 를 걸어 목록을 한꺼번에 지운다. `t`(TestContext)를 주면 그 테스트의 `t.after` 에서 바로 지운다. `beforeEach`, `before` 안에서 부른 `after` 는 그 훅이 끝나자마자 돌아(2026-11-05 실험: 테스트 본문보다 먼저 정리됨) 쓰지 않는다. `TESTKIT_KEEP=1` 이면 지우지 않고 경로를 stderr 에 한 줄 낸다(스펙 DECISION18). `node:test` 를 import 하는 testkit 파일은 이것 하나다 |
| `git.ts` | `gitEnv(base)`, `git(cwd, ...args)`, `templateRepo(opts)`, `copyRepo(dest, source)` | `gitEnv` 는 `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, 작성자와 커미터 이름·메일을 더한 사본을 돌려준다. `GIT_CEILING_DIRECTORIES` 는 인자로 받을 때만 건다. `git` 은 종료 코드가 0 이 아니면 stderr 를 담아 throw 하고 stdout 을 trim 해 돌려준다. `templateRepo` 는 bare origin 과 첫 커밋을 push 한 clone 한 벌을 프로세스마다 처음 한 번만 만든다. 템플릿은 `temp.ts` 의 프로세스 단위 목록(루트 정리)에 두고, 테스트 단위 정리에 넣지 않는다. 기본 브랜치는 `main` 이다. `copyRepo` 는 `cpSync` 로 두 폴더를 복사하고 origin 주소만 바꾼다(`fixtures/cleanup-sweep.ts` 의 `makeRepo` 와 같은 방법) |
| `fake-bin.ts` | `fakeBin(dir, name, rules, opts)`, `linkBin(dir, name, body)`, 규칙 꼴 `FakeRule` | 아래 「가짜 실행 파일」 |
| `command.ts` | `runCommand(argv, opts)`, `runCommandAsync(argv, opts)` | `opts` 는 cwd, env, input, timeoutMs 다. 자식 환경에서 `NODE_TEST_CONTEXT` 를 지운다. 테스트 안에서 띄운 `node --test` 가 이 값을 물려받으면 reporter 출력이 사라진다(검토 실험). 결과는 `{ code, signal, stdout, stderr, timedOut }` 이다. 신호로 끝나면 `code` 는 null 이다. 스크립트는 `[process.execPath, 스크립트, ...인자]` 로 부른다. 명령 경계 테스트(node-runtime 스펙 DECISION11)가 `python3 x.py` 와 `node x.ts` 를 같은 꼴로 부를 수 있게 argv 를 그대로 받는다 |
| `fake-run.ts` | `fakeRun(rulesByCommand)` | `{ run, calls, setRules }` 를 돌려준다. 규칙은 `{ gh: FakeRule[], git: FakeRule[] }` 처럼 명령 이름별로 받는다. `run(argv, opts)` 는 `basename(argv[0])` 으로 규칙 묶음을 고르고, `argv.slice(1)` 에 대해 `FakeRule` 을 위에서부터 보아 `args` 의 문자열이 모두 든 첫 규칙의 `{ code, stdout, stderr, timedOut: false }` 를 돌려준다. 가짜 실행 파일이 `process.argv.slice(2)` 에 맞추는 것과 같은 인자 범위다. 맞는 규칙이 없으면 code 0 과 빈 출력이다. `calls()` 는 받은 argv 와 opts 의 배열이다. orch 의 `lib/proc.ts` 를 import 하지 않고, 결과 꼴이 `RunResult` 와 구조로 맞는다 |
| `measure.ts` | 명령 `node modules/testkit/measure.ts` | 아래 「측정 명령」 |

- `fake-bin.ts` 와 `fake-run.ts` 는 같은 `FakeRule` 꼴과 같은 맞춤 규칙을 쓴다. 명령 하나의 규칙 목록은 두 쪽에 그대로 옮길 수 있다(가짜 실행 파일 `gh` 의 규칙이 `fakeRun({ gh: ... })` 의 규칙이다). 가짜 실행 파일의 본문은 JS 문자열이라 맞춤 함수를 import 할 수 없다. 그래서 같은 사례 표(명령, 규칙, 인자, 기대 결과)를 두 구현에 돌리는 테스트로 묶는다.
- `temp.ts` 는 `node:test` 를 import 하므로 테스트 파일 안에서만 쓴다. 일반 스크립트가 쓰면 stdout 끝에 node:test 요약이 붙는다(검토 실험). `measure.ts` 는 명령이라 `temp.ts` 를 쓰지 않고 자기 정리를 한다.

### 가짜 실행 파일

- shebang 은 `#!<process.execPath>` 다. `#!/usr/bin/env node` 는 PATH 의 node 를 찾는데, 그것이 버전 관리 도구의 shim 이면 호출마다 느려진다(`skills/orch/tests/fixtures/merge-queue-fakes.ts` 의 `writeNodeBin` 이 같은 이유로 이미 이렇게 한다). 실행 경로가 본문에 들어가도 한 프로세스 안에서는 같아 하드 링크 재사용을 막지 않는다.
- 본문은 종류마다 하나다. 규칙 가짜(`fakeBin`)의 본문은 자기 경로(`process.argv[1]`)에 `.rules.json`, `.calls.jsonl` 을 붙인 파일을 읽고 쓴다. 테스트마다 다른 값(규칙, 기록 위치, 기록할 환경 변수 이름)은 본문이 아니라 그 옆 파일에 둔다. 기록할 환경 변수 이름은 규칙 파일에 함께 담는다.
- 원본 보관소: 프로세스마다 처음 부를 때 임시 폴더 하나를 만들고, 본문의 해시를 이름으로 원본을 한 번 쓴다. 실험(2026-11-05)에서 하드 링크로 띄운 node 스크립트의 `process.argv[1]` 은 링크 경로였다. 그래서 링크 옆 파일을 찾을 수 있다.
- `fakeBin(dir, name, ...)` 은 `dir/name` 에 원본을 하드 링크로 건다. 같은 경로에 이미 있으면 지우고 다시 건다. 링크가 실패하면(다른 파일 시스템) 복사로 물러서고, 그때는 첫 실행 검사 비용을 낸다.
- 상태를 가진 가짜(cleanup-sweep 의 `FAKES`, merge-queue 의 `FAKE_GH`)도 `linkBin(dir, name, body)` 로 같은 보관소를 쓴다. 본문에 테스트별 경로를 넣지 않는 조건은 같다(지금 두 가짜는 `FAKE_STATE`, `FAKE_LOG` 환경 변수로 받아 이미 맞는다).
- 보관소는 프로세스 `exit` 에서 지운다. 테스트 파일 사이에서 다시 쓰지 않는다(스펙 DECISION17).
- 기존 `fakeBin` 의 꼴(인자, `FakeBin` 의 `path`, `calls`, `setRules`)은 그대로다. orch fixtures 의 `fake-bin.ts` 는 `ORCH_GH_CACHE=0` 을 건 뒤 testkit 의 것을 다시 내보낸다.

### 실행기

`node scripts/run-tests.ts [파일이나 glob ...] [옵션]`. cwd 는 저장소 루트다. 옵션 이름과 뜻은 `scripts/run-node-tests.ts` 와 같다(스펙 DECISION21).

| 옵션 | 뜻 |
| --- | --- |
| `--concurrency N` | `node --test --test-concurrency=N`. Python 묶음은 `ceil(N/2)` 개씩 함께 돈다. 기본 4 |
| `--timeout SEC` | 기본 600. `node --test --test-timeout=SEC*1000`(테스트 하나의 제한), node 단계의 무진행 감시, Python 묶음 하나와 `tsc` 의 제한에 함께 쓴다(아래 node 단계) |
| `--out DIR` | 결과 폴더. 기본은 임시 폴더 아래 새 폴더 |
| `--background`, `--wait DIR`, `--max-wait SEC` | 지금과 같다. 결과 폴더의 `summary.txt`, `runner.pid`, `runner.log` 꼴도 같다. 기다리기 안내 줄은 `node scripts/run-tests.ts --wait "<폴더>"` 다 |

- 묶음 찾기(스펙 DECISION13): 인자가 없을 때 `git ls-files --cached --others --exclude-standard` 의 목록을 `existsSync` 로 다시 확인하고(지웠지만 커밋하지 않은 파일을 뺀다) `tests/` 아래 `*.spec.ts` 를 node 파일로, `tests/test_*.py` 를 가진 `tests` 폴더를 Python 묶음으로 고른다. 2026-11-05 에 이 규칙으로 고른 Python 묶음은 CI 의 반복문이 돌던 12개와 같았다. 인자 없이 git 저장소 밖에서 부르면 2 로 끝난다.
- 인자를 주면 지금 `expand` 처럼 파일 시스템에서 푼다(glob 문자가 있으면 `globSync`, 없으면 있는 경로). git 은 필요 없다. 풀린 것이 `test_*.py` 파일이면 그 폴더가, `test_*.py` 를 바로 가진 폴더면 그 폴더가 Python 묶음이 된다. 그 밖의 폴더는 그 아래 `*.spec.ts` 를 node 파일로 펼친다. 나머지 파일은 node 파일이 된다(확장자를 따지지 않는다. 지금 실행기 테스트가 `*.spec.mjs` 를 쓴다). `tsc` 는 인자가 없을 때만 돈다. 맞는 것이 없으면 지금처럼 「돌릴 테스트 파일이 없다」 와 2 다.
- 단계: `tsc`, node, Python 묶음을 동시에 띄운다(스펙 DECISION14). 모든 단계를 새 세션(detached)으로 띄우고, 끝나면 그 프로세스 그룹을 SIGKILL 로 정리한다. 자식 환경에서 `NODE_TEST_CONTEXT` 를 지운다. 각 단계의 출력은 결과 폴더의 단계별 로그에 쓰고 섞지 않는다.
- node 단계: `node --test --test-concurrency=N --test-timeout=MS --test-reporter=<파일별 reporter> --test-reporter-destination=stdout --test-reporter=spec --test-reporter-destination=<로그> <파일...>` 를 한 번 띄운다. `NODE_COMPILE_CACHE` 가 없으면 사용자 캐시 폴더 아래 고정 폴더를 준다.
- 그룹 신호의 격리를 지금 실행기만큼 지키지 않는다. 새 세션은 실행기 자신만 지킨다. `node --test` 가 띄운 파일 프로세스는 부모와 같은 그룹이라, 테스트가 그룹에 신호를 보내면 `node --test` 가 남은 파일을 취소하고 끝난다(검토 실험). 이 격리가 필요했던 경우는 재현되지 않았다(스펙 「실행기」, DECISION1). 대신 끊긴 실행이 통과로 보이지 않게 아래 대조로 실패를 드러낸다. 지금 `test_run_node_tests.py` 의 「그룹 신호를 보내는 파일이 섞여도 나머지가 돈다」 사례는 「끊기면 남은 파일이 `보고 없음` 실패로 센다」 로 바꿔 옮긴다.
- 무진행 감시: node 단계에서 파일 완료 사건이 `--timeout` 초 동안 하나도 오지 않으면 그룹을 SIGKILL 한다. 테스트가 남긴 손자 프로세스가 stdio 를 쥐면 `--test-timeout` 과 `--test-force-exit` 로도 `node --test` 가 끝나지 않는다(검토 실험). 감시가 끊은 뒤 보고가 없는 파일은 `시간 초과` 로 센다.
- 파일별 reporter(`scripts/run-tests-reporter.ts`): 파일 하나가 끝나면 Node 24 는 nesting 0, `name` 이 명령줄에 준 경로 그대로인 `test:complete` 를 낸다. 파일 안의 최상위 테스트도 nesting 0 으로 오므로, 실행기가 넘긴 경로 목록(환경 변수 `RUN_TESTS_FILES` 로 reporter 에 넘긴다)에 든 `name` 만 파일 사건으로 본다(critic 실측, 2026-11-05 재확인). 이 사건에는 `details.passed`, `details.duration_ms`(기동 포함), 실패면 `details.error` 의 `failureType`, `exitCode`, `signal` 이 있다. 파일별 `test:summary` 는 프로세스가 `process.exit` 로 끝나거나, 신호로 죽거나, import 에 실패한 파일에는 오지 않는다(검토 실험). 그래서 reporter 는 파일 단위 `test:complete` 마다 한 줄(JSON)을 낸다. 파일 사건의 실패 유형은 assert 실패든 시간 초과든 `subtestsFailed`, `exitCode: 1` 이다. 시간 초과는 하위 테스트 사건에만 `failureType: 'testTimeoutFailure'` 로 온다. 그래서 reporter 는 파일(`data.file`)마다 하위 테스트의 시간 초과를 모아 파일 줄에 싣는다.
- 실행기는 그 줄을 지금 꼴(`통과 <파일> <초>s`, `실패 <파일> <초>s (<이유>) 로그: <로그>`)로 바꿔 `summary.txt` 와 stdout 에 적는다. 이유는 이 순서로 고른다. 신호가 있으면 `신호 S`, 하위 테스트에 시간 초과가 있으면 `시간 초과`, `failureType` 이 `subtestsFailed` 면 `테스트 실패`, 그 밖은 `종료 코드 N`.
- 대조: node 단계가 끝나면 넘긴 파일 목록과 보고를 맞춘다. 보고가 없는 파일은 `실패 <파일> 0.0s (보고 없음)` 으로 센다. `node --test` 가 0 이 아닌 코드로 끝났는데 실패가 하나도 없으면 `실패 node 단계 (종료 코드 N)` 한 줄을 더한다. 끊긴 실행이 끝 줄에서 ` 실패 0,` 으로 읽히지 않게 하려는 것이다.
- Python 단계: 묶음마다 `python3 -m unittest discover -s <폴더>` 를 저장소 루트에서 띄운다. 요약 줄은 파일 대신 폴더 이름을 쓴다. `python3` 가 없으면 남은 묶음마다 실패 줄(「python3 가 없다」)을 낸다(스펙 DECISION15).
- `tsc` 단계: 실행기 상수 `TYPESCRIPT = 'typescript@5.9.3'`, `NODE_TYPES = '@types/node@24.19.2'` 로 설치 폴더를 정한다. 둘 다 정확한 버전이다. 범위(`@24`)로 두면 로컬 캐시는 처음 설치한 버전을 계속 쓰고 CI 는 새 버전을 받아 다시 어긋난다. 2026-11-05 의 `@types/node@24` 최신이 24.19.2 다. 버전을 올릴 때는 이 상수만 고친다. 기본 폴더는 `${XDG_CACHE_HOME:-~/.cache}/fos-skills/tsc/<두 값의 해시>` 이고 `FOS_TSC_DIR` 로 바꾼다. 설치됨은 `<폴더>/node_modules/.bin/tsc` 가 있는지로 본다. 없으면 형제 임시 폴더 `<폴더>.tmp-<pid>` 에 `npm install --no-save --no-audit --no-fund --prefix` 로 설치한 뒤 `rename` 으로 옮긴다. 두 실행기가 함께 설치하면 먼저 옮긴 쪽이 이기고, 진 쪽은 자기 임시 폴더를 지운다. 다른 pid 의 임시 폴더는 그 pid 가 죽었을 때만 지운다. worker 여럿이 워크트리마다 실행기를 함께 돌리기 때문이다. 그다음 `<폴더>/node_modules/.bin/tsc -p tsconfig.json --typeRoots <폴더>/node_modules/@types` 를 돈다. npm 이 없거나 설치가 실패하면 실패 줄(이유 한 줄)을 낸다(스펙 DECISION20). 요약 줄은 `tsc` 를 파일 이름 자리에 쓴다.
- 끝 줄: `결과: 통과 P, 실패 F, 전체 T, 걸린 시간 Ss`. 셈의 단위는 요약 줄 하나(node 파일, Python 묶음, `tsc`, 대조가 더한 줄)다. `--wait` 의 판정(` 실패 0,`)과 「결과: 」 접두는 그대로다. 걸린 시간은 실행기 시작부터 끝 줄까지다(스펙 DECISION22).
- 종료 코드: 0 통과, 1 실패가 있음, 2 실행하지 못함(인자 오류, 대상 없음, 인자 없이 git 저장소 밖, 결과 폴더 없음, 끝 줄 없이 멈춤), 3 `--wait` 가 최대 시간까지 끝 줄을 보지 못함.
- `claude plugin test .` 는 돌지 않는다(스펙 「범위 밖」).

### CI 와 로컬 검증

- `.github/workflows/ci.yml` 은 job 하나(`Tests`)가 된다. 순서: checkout, setup-node 24, setup-python 3.12, `jq`·`zsh` 설치, Claude Code CLI 설치, `claude plugin test .`, `node scripts/run-tests.ts`. 실행기 밖의 `tsc` 단계와 node 테스트 줄, Python 반복문은 지운다. `FOS_TSC_DIR`, `NODE_COMPILE_CACHE` 같은 값은 주지 않고 실행기 기본값을 쓴다(값의 원본은 실행기다). 제한 시간은 지금 두 job 중 긴 쪽인 15분이다.
- `.orch/overlay.md` 의 머지 조건은 「`Tests` 가 통과해야 한다」 가 되고, 로컬 검증은 `claude plugin test .` 와 `node scripts/run-tests.ts` 둘이 된다. 600초를 넘기면 `--background` 와 `--wait` 를 쓰라는 안내는 대기 옵션을 정리할 때까지 남긴다.
- node-runtime 스펙과 설계의 「`Python tests` job 을 지운다」(REQ5)는 「실행기의 Python 단계와 CI 의 Python, jq, zsh 설치 단계를 지운다」 가 된다. 그쪽 문서는 이미 그 꼴로 맞춰졌다(bb61fd3, node-runtime REQ5 와 DECISION22). 이 기능의 PR3 은 node-runtime 문서를 고치지 않는다.
- PR3 이 고칠 문서: README 「기여」 절의 테스트 명령과 세션 분리 설명, 「scripts」 표의 `run-node-tests.ts` 행. `docs/code-architecture.md` 의 「모듈 책임」 표에 실행기 행을 더하고, 「검증」 표의 node 줄과 「실행 규칙」 의 「테스트」 행(`Plugin tests` job, 「필수 체크 이름이 바뀌지 않는다」)을 고친다.
- PR2 가 고칠 문서: `docs/code-architecture.md` 의 「범위」 표 「플러그인과 함께 복사되지만 스킬이 아니다」 칸과 「디렉터리 배치」 표에 `modules/` 를 더한다. 배치 행의 근거는 스펙 DECISION7 이다. 「디렉터리 배치」 아래 「배치의 결정은 [ADR-021](../../adr/021-skill-directory-layout.md) 이 소유한다」 문장 옆에 `modules/` 는 스펙 DECISION7 이 정했다고 적는다.
- PR2 는 새 node 테스트가 PR3 전에도 돌게 CI 의 node 테스트 줄과 `scripts/run-node-tests.ts` 의 `DEFAULT_PATTERNS` 에 `modules/testkit/tests/*.spec.ts`, `scripts/tests/*.spec.ts` 를 더하고, `tsconfig.json` 의 `include` 에 `modules/**/*.ts` 를 더한다.

### 내보내기 경계 검사

- `scripts/tests/exported-imports.spec.ts`(node 테스트). `scripts/export-to-team.sh` 에서 `SHARED_SKILLS=(...)` 와 `SHARED_TOOLS=(...)` 줄을 읽어 폴더를 고른다. 스킬 이름은 `skills/<이름>`, `export-only-skills/<이름>` 순으로 찾고(`scripts/skill_paths.py` 와 같은 순서), 도구는 `tools/<이름>` 이다.
- 그 폴더의 `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` 파일에서 상대 경로 문자열을 찾는다. 꼴은 `import ... from '...'`, `export ... from '...'`, 부수 효과 `import '...'`, `import('...')`, `require('...')`, `new URL('...', import.meta.url)` 이다. 그 파일 기준으로 풀어 폴더 밖이면 `<파일>: <import 경로>` 를 모아 실패한다(스펙 DECISION19).
- 목록의 이름에 맞는 폴더가 없으면 조용히 넘어가지 않고 실패한다. browser-driver 가 node-runtime 영역 10 에서 `skills/browser` 로 옮겨 가면 이 검사가 먼저 알린다.
- 지금 내보내는 폴더에는 TS·JS 파일이 없어 검사가 비어 있다(검토 확인). 그래서 임시 폴더의 가짜 내보내는 폴더로 검사 함수가 잡는지를 따로 본다. node-runtime 전환이 옮겨 오는 파일부터 실제로 걸린다.

### 측정 명령

`node modules/testkit/measure.ts --before <커밋> --after <커밋> [--runs N] <테스트 파일...>`. 아래 「측정 방법」 의 방법을 그대로 명령으로 옮긴다(스펙 DECISION12).

- 두 커밋을 `git archive` 로 각각 임시 폴더에 푼다. 파일마다 전과 후를 번갈아 N 번(기본 3) `node --test <파일>` 로 돌려 실제 걸린 시간의 가운데 값을 낸다.
- 기동 수는 사본에서 `delete <무엇>.NODE_OPTIONS` 꼴의 줄을 지운 뒤 preload 로 한 번 센다. preload 는 측정 명령이 임시 폴더에 쓴다.
- 출력은 PR 본문에 붙일 markdown 표 하나다. 열은 파일, 전 시간, 후 시간, 전 기동 수, 후 기동 수, 실패 여부다. 표 위에 두 커밋과 `uptime` 의 load average 를 적는다.
- 실행기 PR 과 마지막 PR 의 묶음 전체 시간은 실행기 끝 줄의 걸린 시간으로 잰다. 실행기 PR 의 「전」 은 옛 실행기 끝 줄에 시간이 없으므로, `node scripts/run-node-tests.ts` 와 CI 의 Python 반복문을 차례로 돈 바깥 시간(셸의 `time`)으로 잰다.
- 측정 명령도 자식 환경에서 `NODE_TEST_CONTEXT` 를 지운다.

### 측정 방법

- 대상 파일은 스펙 「느린 파일과 원인」 표의 10개다. PR 마다 그 PR 이 바꾸는 원인의 파일을 더 고를 수 있다.
- 시간: 전과 후 커밋을 각각 `git archive` 로 임시 폴더에 풀고, 같은 파일을 `node --test <파일>` 로 혼자 돌린 실제 걸린 시간을 잰다. 부하 차이를 줄이려고 전과 후를 파일마다 번갈아 돌린다.
- 기동 수: 같은 사본에서 `delete env.NODE_OPTIONS` 줄만 지우고, preload 를 `NODE_OPTIONS=--import` 로 모든 node 프로세스에 건다. preload 는 `child_process` 의 spawn, spawnSync, execFile, execFileSync, exec, execSync 를 감싸 pid 와 argv 를 파일에 한 줄씩 덧붙이고 `syncBuiltinESMExports()` 로 named import 에도 반영한다. 기동 수는 부하와 무관하므로 한 번만 잰다.
- 「같은 git 조회」 로 세는 것: `lib/git.ts` 의 `git()` 이 띄우는 `git -C <경로>` 형태의 `rev-parse --path-format=absolute --git-common-dir`, `rev-parse --show-toplevel`, `rev-parse --git-dir`, `check-ignore -q --no-index`, `rev-parse --path-format=absolute --git-path info/exclude`. 같은 pid 에서 argv 가 같은 호출이 두 번째부터 중복이다. `-C` 없이 cwd 로 띄우는 `extensions/work-board/bin/board.ts` 의 `--show-toplevel` 은 이 PR 이 건드리지 않으므로 따로 센다.
- 방법은 이 절이 소유한다. PR1 은 측정 스크립트를 세션 임시 폴더에 두었고, PR2 부터 `modules/testkit/measure.ts` 가 이 방법을 돈다(「측정 명령」).

## 실패와 일관성

- 기억은 프로세스 안에만 있다. 프로세스가 끝나면 사라지므로 파일 잠금이나 다른 프로세스와의 경쟁이 없다.
- 상주 루프(`orch-loop.ts --foreground`)는 오래 살지만 틱마다 자기 자신을 `--tick` 자식으로 띄운다(`orch-loop.ts` 의 `runAsync(scriptCommand(SELF, … '--tick' …))`). 틱 하나의 반복은 자식 안에서 일어나고, 기억도 틱이 끝나면 사라진다. 부모는 경로 조회를 몇 번만 한다.
- 같은 프로세스 안에서 무시 줄을 누가 지우면, 기억한 프로세스는 끝날 때까지 다시 더하지 않는다. 다음 명령이나 다음 틱이 다시 더한다. 무시 줄이 잠깐 빠져도 `.orch` 가 `git status` 에 보일 뿐 데이터는 바뀌지 않는다.
- 다루지 않는 경우: 같은 폴더가 한 프로세스 안에서 다른 저장소의 checkout 으로 바뀌는 경우(지운 뒤 다른 저장소로 다시 만듦). orch 명령에는 그런 흐름이 없다. 독립 검토가 merge_queue 의 사본 워크트리, launch-worker 의 만들기 전 조회, 같은 프로세스에서 `ORCH_DIR` 을 바꾸는 테스트를 확인했고, 모두 위 조건으로 맞는 값을 낸다.
- 배포 순서: 설치본은 main 머지 뒤 플러그인 갱신으로 바뀐다. 기억은 출력과 종료 코드를 바꾸지 않으므로 옛 설치본과 새 설치본이 섞여 돌아도 상태 파일 형식은 같다.
- testkit 의 원본 보관소와 템플릿 저장소는 프로세스마다 따로라 동시 실행(`--test-concurrency`)에서 경쟁하지 않는다. 테스트 파일 하나 안에서 `node:test` 가 테스트를 동시에 돌려도(`concurrency` 옵션) 원본 쓰기는 처음 한 번의 동기 호출이라 겹치지 않는다.
- 하드 링크 원본을 테스트가 고쳐 쓰면 모든 링크가 함께 바뀐다. 그래서 `fakeBin` 과 `linkBin` 은 원본에 쓰지 않고, 같은 경로에 다시 걸 때는 링크를 지우고 새로 건다. 테스트가 가짜 경로에 직접 `writeFileSync` 하면 원본이 바뀌므로, 그런 테스트는 testkit 을 쓰지 않고 지금처럼 자기 파일을 쓴다.
- 실행기가 SIGINT, SIGTERM 을 받으면 띄운 모든 단계의 프로세스 그룹을 끝내고 2 로 끝난다(지금과 같다). `tsc` 설치 중이면 자기 pid 의 임시 폴더가 남고, 다음 실행기가 그 pid 가 죽은 것을 보고 지운다.
- 감시나 끝 정리가 node 단계를 SIGKILL 하면 testkit 의 `exit` 정리가 돌지 않아 임시 폴더가 남는다. 테스트의 `TMPDIR` 을 결과 폴더로 옮기면 남지 않지만, macOS 의 unix 소켓 경로 길이 제한(104바이트)에 걸리는 테스트가 생길 수 있어 옮기지 않는다. 운영체제의 임시 폴더 정리에 맡긴다.
- 옮기는 동안의 호환: PR3 은 `scripts/run-node-tests.ts` 를 같은 PR 에서 지운다. 다른 저장소나 worker 지시서가 옛 명령을 부르면 「모듈 없음」 오류로 끝난다. 저장소 파일 가운데 부르는 곳은 `.orch/overlay.md`, README, `scripts/tests/test_run_node_tests.py` 뿐이다(2026-11-05 `git grep run-node-tests`). 저장소 밖에서는 코디네이터의 지시서(`.orch/specs/` 아래)가 이 명령을 적는다. PR3 을 머지할 때 코디네이터가 남은 지시서를 새 명령으로 바꾼다.
- PR2 와 orch-cli PR3 의 충돌: PR2 는 `skills/orch/tests/fixtures/` 둘과 그것을 쓰는 테스트의 import 만 건드린다. PR3 은 테스트의 스크립트 경로를 고친다. 같은 줄을 고치지 않아 git 이 합친다. 먼저 머지된 쪽 위로 다른 쪽이 rebase 한다.

## 검증 전략

- REQ1, REQ2: CI 의 node 테스트와 Python 테스트가 통과한다(PR3 뒤로는 `Tests` job 하나). 로컬은 `.orch/overlay.md` 대로 돌린다(PR3 뒤로는 `node scripts/run-tests.ts`). 기존 테스트 파일은 두 lib 테스트에 케이스를 더하는 것 말고 바꾸지 않는다.
- 기억의 경계는 `lib-git.spec.ts`, `lib-paths.spec.ts` 에 더한 테스트가 본다. 기억이 실제로 쓰이는지는 첫 호출 뒤 `PATH` 를 빈 폴더로 바꿔 git 을 띄울 수 없게 하고 같은 답이 나오는지로 본다. 측정 도구를 저장소에 들이지 않는다.
- REQ3: PR 본문의 전후 표로 확인한다. PR2 부터는 `modules/testkit/measure.ts` 의 출력이다.
- REQ4: 마지막 PR 에서 부하가 낮을 때(load average 를 표 위에 적는다) 실행기 끝 줄의 걸린 시간으로 확인한다.
- REQ5: `modules/testkit/tests/*.spec.ts` 가 도우미마다 동작을 본다. `beforeEach` 에서 만든 임시 폴더가 테스트 본문에서 아직 있고 파일이 끝난 뒤 사라지는지, `t` 를 주면 그 테스트 뒤 사라지는지, `TESTKIT_KEEP=1` 이면 남는지, `gitEnv` 아래 커밋이 전역 설정을 읽지 않는지, 템플릿 복사본의 origin 이 사본을 가리키고 push 가 되는지, `runCommand` 가 종료 코드, 신호, stdin, 시간 초과를 돌려주는지 본다. fixtures 이전은 그것을 쓰는 기존 orch 테스트(`fakeBin` 을 쓰는 20개 파일과 cleanup-sweep 계열)가 고치지 않은 채 통과하는지로 본다.
- REQ6: 같은 테스트 파일에서 `fakeBin` 을 두 폴더에 만들고 `statSync(...).ino` 가 같은지 본다. 규칙과 기록이 폴더마다 따로인지도 본다.
- 가짜 실행 파일과 가짜 `run()` 의 맞춤 규칙: 같은 사례 표(규칙 목록, argv, 기대 결과)를 두 구현에 돌린다.
- REQ7: `scripts/tests/run-tests.spec.ts` 가 임시 git 저장소에 통과·실패하는 node 파일, Python 묶음, 빈 `tests` 폴더를 만들고 실행기를 돌린다. 요약 줄 꼴, 끝 줄, 종료 코드 0, 1, 2, `--background` 와 `--wait` 의 3, 인자로 고르기, python3 없음(PATH 에서 뺌)을 본다. 보고 없음 대조(`process.exit(3)` 하는 파일, 그룹에 신호를 보내는 파일), 무진행 감시(stdio 를 쥔 손자를 남기는 파일과 짧은 `--timeout`), 테스트 안에서 실행기를 띄워도 출력이 나오는지(`NODE_TEST_CONTEXT`)를 본다. `tsc` 단계는 `FOS_TSC_DIR` 에 가짜 `tsc` 를 둔 폴더로 통과와 실패를 본다. 실제 설치는 CI 와 로컬 실행에서 본다. 지금 `test_run_node_tests.py` 가 보던 경우를 모두 옮긴다.
- REQ8: PR3 의 CI 실행이 `Tests` job 하나로 통과한다. `git grep -l run-node-tests -- ':!docs/features/'` 가 비어 있다(기능 문서는 경위로 이름을 남긴다).
- REQ9: `scripts/tests/exported-imports.spec.ts` 가 지금 저장소에서 통과하고, 임시 폴더에 밖으로 나가는 import 를 가진 가짜 내보내는 폴더를 두면 그 파일 이름을 내며 실패하는지 본다(검사 함수를 따로 내보내 임시 폴더에 돌린다).
- REQ10: 로컬에서 타입 오류 하나를 넣은 상태로 실행기를 돌려 `실패 tsc` 줄과 종료 코드 1 을 보고, 되돌려 통과를 본다. PR3 의 CI 로그에 실행기의 `tsc` 줄이 있다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 기억의 범위 | 프로세스 안의 모듈 변수. 자식 프로세스에 환경 변수로 넘기지 않는다 | 작성자 | 자식은 다른 `--repo` 로 불릴 수 있어 넘긴 값이 틀릴 수 있다. 자식마다 한 번 묻는 비용은 남는다. 이것이 맞는지는 PR1 측정의 pid 별 중복으로 확인한다 |
| DECISION2 | 실패한 답의 기억 | 폴더와 조상에 `.git` 이 없을 때만 기억하고 꺼낼 때 다시 본다 | 작성자 | 반복의 대부분이 git 밖 폴더의 실패한 답이다. `.git` 이 생기는 흐름(워크트리 만들기)은 다시 확인으로 맞는 값을 낸다. 확인은 `existsSync` 몇 번이라 git 기동(약 100ms)보다 훨씬 싸다 |
| DECISION3 | 기억을 지우는 함수 | 두지 않는다 | 작성자 | 테스트가 폴더마다 새 임시 경로를 쓰고, 바뀐 폴더는 꺼낼 때 다시 확인한다. 필요해지면 그때 더한다 |
| DECISION4 | ensureIgnored 의 다른 git 조회 | 따로 기억하지 않고 함수 결과 단위로 기억한다 | 작성자 | `rev-parse --git-dir`, `check-ignore`, `--git-path` 는 같은 판정의 단계라 결과 하나로 묶는 편이 무효화 조건이 단순하다 |
| DECISION5 | 열쇠의 환경 변수 | git 탐색에 닿는 네 변수를 열쇠에 넣는다 | 작성자 | 같은 프로세스에서 `GIT_CEILING_DIRECTORIES` 를 바꾸는 테스트가 있다(`lib-git.spec.ts`, `lib-movement.spec.ts`). 지금은 `mainCheckout` 을 부르지 않지만 가정에 기대지 않는다 |
| DECISION6 | testkit 의 파일 나눔 | 도우미 묶음마다 파일 하나(`temp`, `git`, `fake-bin`, `command`, `fake-run`, `measure`). 색인 파일(`index.ts`)은 두지 않는다 | 작성자 | 테스트가 필요한 것만 import 해 import 비용과 의존을 작게 둔다. 저장소의 lib 모듈도 기능마다 파일이다 |
| DECISION7 | 실행기의 자리와 이름 | `scripts/run-tests.ts` 와 `scripts/run-tests-reporter.ts` | 작성자 | 지금 실행기(`scripts/run-node-tests.ts`)의 자리를 잇는다. 실행기는 저장소 검증 명령이라 testkit(테스트 안에서 쓰는 모듈)과 책임이 다르다 |
| DECISION8 | 파일별 요약 줄을 얻는 법 | 사용자 정의 reporter 가 파일 단위 `test:complete`(nesting 0, 이름이 넘긴 경로)를 한 줄로 내고, 실행기가 넘긴 파일 목록과 대조한다 | 작성자 | TAP 의 최상위 항목은 파일이 아니라 테스트였다(2026-11-05 실험). 파일별 `test:summary` 는 비정상 종료한 파일에 오지 않아 쓰지 않는다(검토 실험) |
| DECISION9 | `tsc` 설치 자리 | 사용자 캐시 폴더 아래 버전 해시 폴더. 두 버전은 정확한 값으로 고정한다. pid 를 붙인 형제 임시 폴더에 설치하고 `rename` 한다 | 작성자 | 실행마다 npm 설치를 하지 않고, 버전을 바꾸면 새 폴더가 생긴다. `rename` 은 같은 파일 시스템에서 원자적이라 동시 설치가 서로 깨뜨리지 않는다 |
| DECISION10 | Python 묶음의 동시 수 | `ceil(concurrency/2)` | 작성자 | node 단계와 함께 돌아 CPU 를 나눈다. 차례로 101초인 Python 이 node 가 빨라진 뒤 가장 긴 단계가 되지 않게 둘 이상으로 돈다 |
| DECISION11 | 내보내기 경계 검사의 언어와 자리 | node 테스트 `scripts/tests/exported-imports.spec.ts` | 작성자 | 새 Python 을 더하면 node-runtime 이 곧 다시 옮긴다. 실행기가 `scripts/tests` 의 두 언어를 함께 찾으므로 같은 폴더에 둘 수 있다 |
| DECISION12 | 함수 주입 PR 의 설계 | 그 PR 을 띄울 때 이 설계에 절을 더한다. 주입 자리의 꼴은 orch-cli 의 lib 추상화(어댑터 층)를 따른다 | 작성자 | 스펙 DECISION10 으로 orch-cli PR3 뒤에 간다. 지금 정하면 PR3 의 폴더 이동과 어댑터 경계에 맞지 않을 수 있다 |
| DECISION13 | `modules/` 의 ADR | 새 ADR 을 두지 않는다. `docs/code-architecture.md` 「디렉터리 배치」 표에 행을 더한다 | 작성자 | 사용자가 표에 더하라고 정했다(스펙 DECISION7). 분리 신호가 걸리지 않아 소유 경계 ADR 초안 조건이 아니다 |
| DECISION14 | 그룹 신호의 격리 | 파일마다 세션을 나누지 않는다. `node --test` 한 번으로 돌고, 끊기면 보고 없음 대조와 무진행 감시로 실패를 드러낸다 | 작성자 | 스펙 DECISION1 이 「격리가 필요한 경우가 재현되지 않았다」 를 근거로 node --test 유지를 정했다. 파일마다 `node --test` 를 띄우면 파일 수만큼 기동이 늘어 2분 목표와 어긋난다. 신호 테스트 11개 파일은 `node --test --test-concurrency=4` 로 끝 요약까지 돌았다 |
| DECISION15 | 임시 폴더의 정리 시점 | 기본은 테스트 파일이 끝날 때 한꺼번에. `t` 를 주면 그 테스트 뒤 | 작성자 | `beforeEach` 안의 `after` 는 테스트 본문 전에 돈다(실험). 기존 fixtures 는 `beforeEach` 에서 저장소를 만든다 |


## PR4: merge-queue 테스트의 준비와 명령 주입

REQ1, REQ2, REQ3, REQ6 을 맡는다. 큐의 인자·출력·종료 코드 계약과 판정은 유지한다.

- `lib/proc.ts` 는 `withRun` 으로 비동기 호출 범위 안의 동기 실행 함수를 받는다. `AsyncLocalStorage` 로 범위를 묶어 다른 실행과 섞지 않고, 주입하지 않으면 기존 실행을 그대로 쓴다. `merge_queue.ts` 는 `main` 을 내보내고 직접 실행할 때만 CLI 와 신호 처리기를 연결한다.
- 첫 커밋은 이 주입 자리와 import 경계만 더하고 기존 테스트를 그대로 실행한다(DECISION16). 다음 커밋에서 테스트의 판정 호출을 `main` 에 가짜 실행 함수를 주는 fixture 로 옮긴다. 큐는 환경·작업 디렉터리·신호 상태를 가지므로 호출마다 별도 프로세스에서 fixture 함수를 실행한다. 이 격리는 남기되 반복되는 가짜 gh/git 프로세스는 없앤다.
- 상태를 바꾸는 가짜 gh/git 의 본문은 실행 파일과 함수 양쪽이 공유한다. 함수 쪽은 본문을 한 번 컴파일하고, 호출마다 argv·env·출력·종료를 제공한다. gh 의 `--jq` 식은 기존처럼 실제 jq 로 평가해 계약을 확인한다. 실제 git 과 사용자 명령·이벤트 핸들러는 기존 실행기로 보낸다.
- 실행 파일은 testkit `linkBin` 을 쓴다. 상태와 기록은 기존 환경 변수가 지정하는 테스트별 파일에 두므로 원본을 재사용해도 섞이지 않는다.
- 겹침 테스트의 초기 파일을 넣은 origin/clone 템플릿을 파일 프로세스마다 한 번 만들고 `copyRepo` 로 테스트 폴더에 복사한다. feat/main 의 변경 커밋과 합친 사본 검사는 계속 실제 git 으로 실행한다.

| 기존 관측 경계 | 전환 뒤 같은 판정과 남기는 경계 |
| --- | --- |
| `merge-queue.spec.ts` 의 `runQueue`: 체크·최신화·보류·앞지르기·완료 근거·hook·정리 | 기존 단언을 유지하고 fixture 가 `main` 을 함수로 호출한다. gh/git 만 함수 가짜이며 실제 jq·hook·명령 실행은 남긴다 |
| `merge-queue-overlap.spec.ts` 의 `runQueue`: 겹침·합친 사본·정리 | 기존 단언과 실제 git 을 유지하고 gh 만 함수 가짜로 바꾼다 |
| 직접 CLI 호출: 인자 오류, 호스트 전달, 신호와 자식 종료 | 실제 진입점을 계속 실행한다. 성공·보류·사용법 오류의 대표 종료 코드와 stdout 을 추가로 CLI 에서 확인한다 |
| 가짜 실행 파일과 함수의 상태 변화·stdout·stderr·종료 코드 | 같은 본문을 양쪽에서 실행하는 대응 테스트로 성공·실패·상태 변화 사례를 비교한다 |

검증은 `node scripts/run-tests.ts` 로 대상 파일과 proc 회귀 테스트를 실행하고 저장소 전체 검사를 잇는다. 시간과 기동 수는 「측정 방법」의 `modules/testkit/measure.ts` 로 기준 커밋과 구현 커밋을 같은 머신에서 번갈아 잰다. 독립 설계·계획·코드·문서 검토는 코디네이터에게 넘기며 자기 점검으로 통과 처리하지 않는다.

## PR5: orch-loop 테스트의 준비와 명령 주입

REQ1, REQ2, REQ3, REQ6 을 맡는다. `orch-loop*.spec.ts` 의 판정과 실제 git 검사는 유지한다.

- PR4 의 `withRun` 을 재사용한다. `orch-loop.ts` 는 `main` 을 내보내고 직접 실행할 때만 호출한다. 선택 인자로 실행 함수와 자식 진입점 경로를 받는다. 기본값은 기존 실행과 자기 경로다. 테스트 fixture 는 자신을 자식 진입점으로 전달해 상주 부모가 띄운 틱에서도 같은 함수 가짜를 쓴다.
- 루프는 pid·신호·로그·환경을 가지므로 호출마다 별도 프로세스에서 `main` 을 함수로 실행한다. 가짜 gh, orca, ps 의 CommonJS 본문만 같은 프로세스에서 평가하고, 실제 git·핸들러·정리·보드·분리된 머지 큐는 기존 실행 경계에 둔다. 함수 가짜는 argv, env, cwd, 표준 출력과 종료만 제공한다. 본문의 예외는 실패 결과로 돌려준다. 시간 제한이 필요한 가짜 orca 의 지연은 실제 실행으로 보낸다.
- CI·멈춤·자동 머지 테스트와 같은 준비를 하는 충돌·최신화 테스트도 포함한다. 실행 파일은 `linkBin` 으로 재사용한다. 초기 저장소는 `templateRepo` 와 `copyRepo` 로 준비하고, 파일이 필요한 묶음은 기본 템플릿을 복사한 뒤 파일을 커밋한 템플릿을 파일 프로세스마다 한 번 만든다. 테스트별 브랜치·충돌·최신화·머지는 계속 실제 git 이다.

| 기존 관측 경계 | 전환 뒤 같은 판정과 남기는 경계 |
| --- | --- |
| 기본 루프의 동기 호출 도우미: 설정·질문·Run·이벤트·오류 | 기존 단언을 유지하고 fixture 의 `main` 을 호출한다. 직접 spawn 하는 시작·종료·신호·부모 감시 사례는 실제 CLI 를 유지한다 |
| CI·자동 머지·멈춤의 틱과 한 번 실행 | 기존 상태 파일·알림·호출 인자·출력 단언을 유지한다. gh/orca/ps 만 함수로 실행하고 틱 자식과 머지 큐의 분리 실행은 유지한다 |
| 충돌·최신화의 동기 한 번 실행 | 기존 단언과 실제 git 을 유지한다. 직접 spawn 하는 경쟁·종료 사례는 실제 CLI 를 유지한다 |
| 초기 저장소의 기본값 | 템플릿 복사본에는 main upstream 이 생긴다. 파일을 넣은 conflict·auto-merge·refresh 템플릿에는 origin/HEAD 와 파일 커밋 앞의 빈 커밋이 추가된다. CI 는 origin/HEAD 없는 기본 템플릿으로 main 대체 경로를 유지한다. 기존 판정 단언과 실제 git 검사는 유지한다 |
| 가짜 명령 실행 파일과 함수의 출력·종료·기록 | 대응 테스트로 gh 규칙, orca 성공·실패, ps 출력, 본문 예외를 비교한다 |

첫 구현 커밋은 주입 자리만 더하고 기존 테스트를 그대로 실행한다(DECISION16). 다음 커밋에서 fixture 와 준비 코드를 전환한다. 운영 상태 형식·출력·배포 계약과 도메인 규칙은 바뀌지 않아 새 ADR 은 필요 없다. 검증과 전후 측정은 PR4 와 같은 실행기와 측정 명령을 쓴다. 독립 검토는 지시서대로 PR 생성 뒤 코디네이터가 마련하며, 그 전에는 대기로 기록한다.


## PR6: cleanup-sweep 계열의 명령 주입과 저장소 준비

REQ1, REQ2, REQ3, REQ6 을 맡는다. PR4·PR5 의 `withRun` 경계를 재사용하고 운영 출력·종료 코드·정리 판정은 유지한다.

- `cleanup-sweep.ts` 와 `notify-conflicts.ts` 의 `main` 은 선택 인자로 실행 함수를 받는다. `AsyncLocalStorage` 범위 안에서 기존 본문을 호출하고 기본값은 기존 실행이다. CLI 는 `import.meta.main` 일 때만 호출한다.
- fixture 는 호출마다 별도 프로세스에서 `main` 을 함수로 실행한다. cleanup-sweep 는 pid 와 프로세스 조회 결과를 함께 판정하므로 이 격리를 유지한다. gh, orca, lsof, ps, kill, docker 의 동기 CommonJS 가짜 본문은 실행 파일과 함수가 공유한다. 함수는 본문을 한 번 컴파일하고 argv·env·출력·종료를 제공한다. `SWEEP` 의 부모 pid 는 함수가 실행되는 정리 프로세스 pid 로 대응한다.
- 실제 git, remove-worktree 자식, hook 과 send-to-worker 대역의 ESM 실행은 기존 실행기로 보낸다. 신호·지연·비동기 출력·상대 경로 파일 접근은 함수 가짜의 지원 범위 밖이다. 없는 경로와 실행 권한·shebang 이 다른 파일은 실제 실행으로 넘긴다. 본문 예외는 종료 코드 1 과 stderr 로 돌려준다. `exitCode` 뒤 `exit()` 와 console 출력도 보존한다.
- cleanup-sweep 의 초기 저장소는 기존 `copyRepo` 를 유지한다. notify-conflicts 는 초기 파일을 커밋한 템플릿을 파일 프로세스마다 한 번 만들고 테스트마다 `copyRepo` 로 복사한다. 가짜 실행 파일은 경로를 본문에 넣지 않고 `linkBin` 으로 재사용한다.

| 기존 관측 경계 | 전환 뒤 같은 판정과 남기는 경계 |
| --- | --- |
| cleanup-sweep 의 merge·holders·reviews·docker·remote·state·routing·repos·launched 의 `runSweep` | 기존 단언·상태 파일·호출 기록을 유지한다. fixture 가 `main` 을 함수로 호출하고 동기 가짜 명령만 함수로 실행한다. 실제 git·remove-worktree·hook 은 유지한다 |
| cleanup-sweep 를 직접 띄우는 인자·오류와 remove-worktree 경계 | 실제 진입점을 유지한다. 대표 성공·사용법 오류·실행 오류의 stdout·stderr·종료 코드를 실제 CLI 로 대조한다 |
| notify-conflicts 의 충돌·알림·재시도·orphan·dry-run·hook | 기존 단언과 실제 git 충돌 판정을 유지하고 gh·orca 만 함수로 실행한다. send-to-worker 대역과 hook 은 실제 자식이다 |
| 초기 저장소 상태 | cleanup-sweep 는 기존 템플릿 그대로다. notify-conflicts 의 main upstream 은 기존 empty clone 과 같고, origin/HEAD 와 파일 커밋 앞의 빈 커밋이 추가된다. 충돌 입력 파일과 테스트별 변경 커밋은 유지한다 |
| 가짜 실행 파일과 함수의 출력·종료·기록 | 같은 본문을 양쪽에서 실행해 성공·실패·상태 변화·예외·출력·없는 경로를 대조한다 |

첫 구현 커밋은 주입 자리만 더하고 기존 테스트를 그대로 실행한다(DECISION16). 다음 커밋에서 fixture 와 준비 코드를 옮긴다. 검증은 실행기로 대상 파일과 proc 회귀 테스트를 돌리고 전체 검사로 잇는다. 전후 시간과 preload 기동 수는 「측정 방법」의 명령으로 같은 머신에서 번갈아 잰다. 독립 설계·계획·코드·문서 검토는 PR 생성 뒤 코디네이터가 마련하며 그 전에는 대기로 기록한다.

운영 상태 형식·도메인 규칙·배포 계약과 데이터 소유권은 바뀌지 않는다. 새 ADR 과 트랜잭션·재시도 정책은 필요 없다. 함수 가짜가 지원하지 않는 실행은 실제 실행 경계에 남긴다.

## PR7: launch-worker 와 남은 느린 테스트

REQ1, REQ2, REQ3, REQ6 을 맡는다. 운영 출력·종료·상태 계약은 유지하고 PR4~PR6 의 `withRun` 경계를 재사용한다.

- 먼저 orch fixtures 의 `stateful-run.ts` 에 동기 CommonJS 가짜 평가를 모은다. 허용 명령과 PATH 해석, 실제 실행으로 보낼 조건은 호출자가 정한다. 가짜 자식의 부모 pid 는 main 을 실행하는 현재 프로세스다. 루프·정리·알림의 진입점과 분리해 알림이 정리 스크립트를 import 하지 않게 한다. 본문 예외는 명령 실패로 돌려주며 `exitCode` 뒤 `exit()` 와 console 출력을 보존한다. 지원하지 않는 지연·신호·비동기 출력·상대 파일 접근은 머리 주석과 실제 실행 대응 테스트로 경계를 남긴다.
- launch-worker 와 orch-doctor 는 `main(argv, runner?)` 과 기존 오류 처리기를 내보내고 직접 실행 판정에 `import.meta.main` 및 realpath 비교를 쓴다. 첫 주입 커밋에서는 기존 테스트를 그대로 실행한다(DECISION16).
- 테스트는 호출마다 별도 fixture 프로세스를 유지한다. 환경·cwd·캐시·pid 격리는 그대로이고 orca 와 doctor 의 ps 대역만 함수로 부른다. launch 의 make-worktree, spec-line, spec-lint, 이벤트 핸들러와 doctor 의 실제 git·shallow clone·지연은 프로세스 경계를 유지한다. 운영 기본 환경은 바꾸지 않는다.
- 같은 가짜 실행 파일은 `linkBin` 으로 재사용한다. doctor 의 설치본 테스트는 파일을 넣고 커밋한 템플릿 저장소를 한 번 만들고 `copyRepo` 로 복사한다. shallow 마켓플레이스 clone 은 매번 실제 `git clone --depth 1 file://...` 로 만든다.
- 전체 기준 실행에서 launch-worker 다음으로 느린 remove-worktree 도 포함한다. `copyRepo` 로 초기 bare origin 과 clone 을 복사하고, 가짜 본문의 상태 경로는 `FAKE_STATE` 환경 변수로 받아 `linkBin` 으로 재사용한다. main 의 빈 커밋·upstream 은 기존과 같고 origin 의 임시 경로만 바뀐다. 실제 worktree 추가·push·삭제·소유 확인·hook 대기는 그대로다.
- merge-queue-overlap 은 PR4 에서 gh 함수 주입과 템플릿 복사가 이미 적용됐다. 실제 겹침·merge·worktree·origin 이동 검증에 필요한 git 비용을 남기며, 재측정으로 남은 비중을 확인한다. 전체 실행기의 느린 파일도 함께 재측정하고 추가 변경은 실제 원인이 같은 경우에만 한다.

| 기존 관측 경계 | 전환 뒤 같은 판정과 남기는 경계 |
| --- | --- |
| launch 도우미의 거부·선택·Run·재시도·준비·hook·감시 | 같은 인자·출력·종료·상태 단언을 유지하고 fixture 의 main 을 호출한다. bash/zsh 인자 전달은 그대로다 |
| doctor 도우미의 설치본·질문·루프·환경·hook | 같은 단언을 유지하고 orca/ps 만 함수로 실행한다. 직접 spawn 하는 생명주기 사례와 지연은 실제 CLI 로 유지한다 |
| remove-worktree 의 정리·소유·브랜치·docker·hook | 기존 실제 CLI 와 단언을 유지한다. 준비 저장소와 가짜 본문만 재사용하고 종료·대기·실제 git 경계는 바꾸지 않는다 |
| 초기 저장소 상태 | doctor·remove-worktree 의 origin 임시 경로는 copyRepo 사본 주소로 바뀐다. remove-worktree 는 기존 빈 커밋·upstream 을 유지한다. doctor 템플릿에는 파일 커밋 앞의 빈 커밋과 main upstream 이 추가된다. shallow clone 여부와 설치 tree 비교는 유지한다. merge-queue-overlap 은 기존 템플릿 그대로다 |
| CLI 인자·stdout·stderr·종료 코드 | 실제 진입점에서 성공·사용법 오류·거부·조회 실패의 대표 사례를 남기고 함수 진입점과 대조한다 |
| 가짜 평가의 env·cwd·출력·종료·상태 | 기존 루프·정리 대응 테스트를 유지하고 launch/doctor 가 쓰는 가짜도 실행 파일과 같은 결과·기록을 내는지 대조한다 |

검증은 실행기로 대상 파일·가짜 대응·proc 회귀를 돌리고 전체 검사로 잇는다. 전후 시간과 기동 수는 「측정 방법」의 명령으로 같은 머신에서 번갈아 잰다. 전체 기본 실행 시간과 남은 실제 git·CLI 기동 비용은 PR 에 남긴다. 독립 설계·계획·코드·문서 검토는 코디네이터가 PR 뒤 마련하며 자기 점검으로 통과 처리하지 않는다. 새 도메인·배포·상태 계약이 없어 ADR 은 추가하지 않는다.
