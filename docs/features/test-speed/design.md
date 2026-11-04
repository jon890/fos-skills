# 테스트: node 테스트 묶음의 시간을 줄인다: 기술 설계

스펙: [spec.md](spec.md). 원인별 PR 의 순서는 스펙 DECISION5 가 정한다. 이 설계는 PR 마다 고칠 곳과 지킬 조건을 정하고, 뒤 PR 은 그 PR 을 띄울 때 해당 절을 보강한다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 각 PR 은 테스트가 보는 동작을 바꾸지 않는다. 스크립트 수정(PR1)은 기존 테스트를 그대로 두고, 테스트 수정(뒤 PR)은 지운 프로세스 테스트와 같은 판정을 보는 함수 테스트를 같은 PR 에 남긴다 |
| REQ2 | PR1 의 기억은 git 이 같은 답을 낼 조건이 그대로일 때만 꺼낸다(「PR1: 기억을 다시 확인하는 조건」). 기존 테스트 파일은 케이스를 더하기만 하고, 기존 케이스를 고치지 않은 채 통과시킨다 |
| REQ3 | 측정은 「측정 방법」 절의 두 가지(사본 그대로의 벽시계, preload 로 센 기동 수)로 같은 머신에서 전후를 번갈아 잰다. 결과는 PR 본문에 적는다 |
| REQ4 | DECISION5 의 순서로 원인을 하나씩 줄이고, 마지막 PR(실행기 제거) 전에 부하가 낮은 때 `node --test --test-concurrency=4` 로 묶음 전체를 잰다 |

## 책임과 경계

- PR1(같은 git 조회 반복): `skills/orch/scripts/lib/git.ts` 의 `mainCheckout` 과 `skills/orch/scripts/lib/paths.ts` 의 `ensureIgnored` 가 자기 결과를 프로세스 안에서 기억한다. 부르는 쪽(orch 명령과 lib 모듈)은 바꾸지 않는다. 기억은 두 함수의 모듈 변수가 소유한다. 다시 확인하는 데 쓰는 `.git` 찾기 함수 하나만 git.ts 가 내보내 paths.ts 와 함께 쓴다.
- 이미 있는 캐시는 그대로 둔다. `lib/gh.ts` 의 `contexts` 는 `mainCheckout` 과 origin 주소를 60초 묶어 기억하고, `lib/gh-budget.ts` 의 `roots` 는 `[repo, ORCH_DIR]` 열쇠로 `orchDir` 을 기억한다. 두 캐시가 놓친 호출이 이제 기억에 걸릴 뿐이고, gh.ts 의 60초는 origin 주소 때문에 남긴다.
- 가짜 실행 파일 재사용(DECISION6), 테스트 준비 git, 함수 주입 전환(DECISION4), 실행기 제거(DECISION1)는 테스트 쪽(`skills/orch/tests/`, `scripts/run-node-tests.ts`, README)만 바꾼다. 스크립트의 출력 계약은 건드리지 않는다.
- 자식 프로세스에 결과를 넘기지 않는다. 틱과 정리처럼 orch 명령이 다른 orch 명령을 띄우면 자식은 처음 한 번 다시 묻는다.

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

### 측정 방법

- 대상 파일은 스펙 「느린 파일과 원인」 표의 10개다. PR 마다 그 PR 이 바꾸는 원인의 파일을 더 고를 수 있다.
- 시간: 전과 후 커밋을 각각 `git archive` 로 임시 폴더에 풀고, 같은 파일을 `node --test <파일>` 로 혼자 돌린 벽시계 시간을 잰다. 부하 차이를 줄이려고 전과 후를 파일마다 번갈아 돌린다.
- 기동 수: 같은 사본에서 `delete env.NODE_OPTIONS` 줄만 지우고, preload 를 `NODE_OPTIONS=--import` 로 모든 node 프로세스에 건다. preload 는 `child_process` 의 spawn, spawnSync, execFile, execFileSync, exec, execSync 를 감싸 pid 와 argv 를 파일에 한 줄씩 덧붙이고 `syncBuiltinESMExports()` 로 named import 에도 반영한다. 기동 수는 부하와 무관하므로 한 번만 잰다.
- 「같은 git 조회」 로 세는 것: `lib/git.ts` 의 `git()` 이 띄우는 `git -C <경로>` 형태의 `rev-parse --path-format=absolute --git-common-dir`, `rev-parse --show-toplevel`, `rev-parse --git-dir`, `check-ignore -q --no-index`, `rev-parse --path-format=absolute --git-path info/exclude`. 같은 pid 에서 argv 가 같은 호출이 두 번째부터 중복이다. `-C` 없이 cwd 로 띄우는 `extensions/work-board/bin/board.ts` 의 `--show-toplevel` 은 이 PR 이 건드리지 않으므로 따로 센다.
- 측정 스크립트는 한 번 쓰고 끝나므로 세션 임시 폴더에 둔다. 방법은 이 절이 소유한다.

## 실패와 일관성

- 기억은 프로세스 안에만 있다. 프로세스가 끝나면 사라지므로 파일 잠금이나 다른 프로세스와의 경쟁이 없다.
- 상주 루프(`orch-loop.ts --foreground`)는 오래 살지만 틱마다 자기 자신을 `--tick` 자식으로 띄운다(`orch-loop.ts` 의 `runAsync(scriptCommand(SELF, … '--tick' …))`). 틱 하나의 반복은 자식 안에서 일어나고, 기억도 틱이 끝나면 사라진다. 부모는 경로 조회를 몇 번만 한다.
- 같은 프로세스 안에서 무시 줄을 누가 지우면, 기억한 프로세스는 끝날 때까지 다시 더하지 않는다. 다음 명령이나 다음 틱이 다시 더한다. 무시 줄이 잠깐 빠져도 `.orch` 가 `git status` 에 보일 뿐 데이터는 바뀌지 않는다.
- 다루지 않는 경우: 같은 폴더가 한 프로세스 안에서 다른 저장소의 checkout 으로 바뀌는 경우(지운 뒤 다른 저장소로 다시 만듦). orch 명령에는 그런 흐름이 없다. 독립 검토가 merge_queue 의 사본 워크트리, launch-worker 의 만들기 전 조회, 같은 프로세스에서 `ORCH_DIR` 을 바꾸는 테스트를 확인했고, 모두 위 조건으로 맞는 값을 낸다.
- 배포 순서: 설치본은 main 머지 뒤 플러그인 갱신으로 바뀐다. 기억은 출력과 종료 코드를 바꾸지 않으므로 옛 설치본과 새 설치본이 섞여 돌아도 상태 파일 형식은 같다.

## 검증 전략

- REQ1, REQ2: CI 의 node 테스트(`node --test --test-concurrency=4` 세 묶음)와 Python 테스트가 통과한다. 로컬은 `.orch/overlay.md` 대로 `scripts/run-node-tests.ts` 로 돌린다. 기존 테스트 파일은 두 lib 테스트에 케이스를 더하는 것 말고 바꾸지 않는다.
- 기억의 경계는 `lib-git.spec.ts`, `lib-paths.spec.ts` 에 더한 테스트가 본다. 기억이 실제로 쓰이는지는 첫 호출 뒤 `PATH` 를 빈 폴더로 바꿔 git 을 띄울 수 없게 하고 같은 답이 나오는지로 본다. 측정 도구를 저장소에 들이지 않는다.
- REQ3: PR 본문의 전후 표로 확인한다.
- REQ4: 실행기 제거 PR 에서 확인한다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 기억의 범위 | 프로세스 안의 모듈 변수. 자식 프로세스에 환경 변수로 넘기지 않는다 | 작성자 | 자식은 다른 `--repo` 로 불릴 수 있어 넘긴 값이 틀릴 수 있다. 자식마다 한 번 묻는 비용은 남는다. 이것이 맞는지는 PR1 측정의 pid 별 중복으로 확인한다 |
| DECISION2 | 실패한 답의 기억 | 폴더와 조상에 `.git` 이 없을 때만 기억하고 꺼낼 때 다시 본다 | 작성자 | 반복의 대부분이 git 밖 폴더의 실패한 답이다. `.git` 이 생기는 흐름(워크트리 만들기)은 다시 확인으로 맞는 값을 낸다. 확인은 `existsSync` 몇 번이라 git 기동(약 100ms)보다 훨씬 싸다 |
| DECISION3 | 기억을 지우는 함수 | 두지 않는다 | 작성자 | 테스트가 폴더마다 새 임시 경로를 쓰고, 바뀐 폴더는 꺼낼 때 다시 확인한다. 필요해지면 그때 더한다 |
| DECISION4 | ensureIgnored 의 다른 git 조회 | 따로 기억하지 않고 함수 결과 단위로 기억한다 | 작성자 | `rev-parse --git-dir`, `check-ignore`, `--git-path` 는 같은 판정의 단계라 결과 하나로 묶는 편이 무효화 조건이 단순하다 |
| DECISION5 | 열쇠의 환경 변수 | git 탐색에 닿는 네 변수를 열쇠에 넣는다 | 작성자 | 같은 프로세스에서 `GIT_CEILING_DIRECTORIES` 를 바꾸는 테스트가 있다(`lib-git.spec.ts`, `lib-movement.spec.ts`). 지금은 `mainCheckout` 을 부르지 않지만 가정에 기대지 않는다 |
