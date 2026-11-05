# 테스트: node 테스트 묶음의 시간을 줄인다

## 목표

fos-skills 의 node 테스트 묶음(`skills/orch/tests`, `extensions/work-board/tests`, `skills/inbox/tests`)이 개발의 병목이 되지 않게 한다.
느린 원인을 실측으로 나누고, 원인 하나씩 작은 PR 로 줄이며 PR 마다 전후 시간을 남긴다.
테스트가 함께 쓰는 TypeScript testkit(임시 git 저장소 템플릿, 가짜 실행 파일 재사용, 명령 도우미)을 두고, 실행기 하나가 node 와 Python 테스트를 함께 돈다.

- 배경: 사용자 결정(2026-11-04) 「테스트 시간이 개발의 큰 병목이다. 가볍게 유지하도록 계속 줄인다」.
- 넓힌 배경: 사용자 결정(2026-11-04) 「스펙을 넓혀 언어별 testkit 과 두 언어를 함께 도는 실행기 하나를 다음 PR 들에서 만든다. Python 은 node-runtime 전환이 옮기므로 testkit 은 TypeScript 를 먼저 만든다」. 처음 확인(2026-11-04)은 PR1(#336, 같은 git 조회 기억)까지의 범위였다.
- 이 testkit 은 node-runtime 전환(스펙 `docs/features/node-runtime/spec.md`, 브랜치 `feat/node-runtime`, 사용자 확인 2026-11-05)이 쓴다. 그 스펙의 순서는 testkit, orch 폴더 이동(orch-cli PR3), 전환이다.
- 11/04 오전 실측(`scripts/run-node-tests.ts`, 파일 96개, 동시 4): 파일별 시간 합 약 50분, 벽시계 약 12~13분.
- 11/04 오후 실측(같은 명령, 파일 99개, load average 약 130): 파일별 시간 합 128분, 벽시계 33분, 실패 3건(시간 초과 2건, 부하에서 타이밍이 어긋난 SIGTERM 테스트 1건).
- CI(ubuntu, `node --test --test-concurrency=4`)의 node 테스트 단계는 3분 52초다(run 41780055506).

## 측정

### 이 머신의 프로세스 기동 비용

macOS 에서는 프로세스를 띄우는 비용이 크다. 한 번 띄울 때의 평균이다(11/04 오후, 부하 높음).

| 띄운 것 | 시간 |
| --- | --- |
| `node -e 0` | 66~80ms |
| `git --version` (`/usr/bin/git`, xcrun 경유) | 76~92ms |
| `git --version` (CommandLineTools 의 git 직접) | 49ms |
| `git rev-parse HEAD` | 110ms |
| `/bin/echo` | 27ms |
| 방금 쓴 실행 파일의 첫 실행 | 220~690ms |
| 같은 파일의 두 번째 실행, 같은 경로에 다시 쓴 파일, 하드 링크 | 11~85ms |
| 같은 내용을 새 경로로 복사한 파일 | 155~735ms |

새 실행 파일의 첫 실행 비용은 파일(inode) 단위로 붙는다. 테스트가 가짜 실행 파일을 테스트마다 새로 쓰면 그때마다 이 비용을 낸다.

### 느린 파일과 원인

각 파일을 혼자 돌리며 모든 node 프로세스의 `child_process` 호출을 기록했다(측정 스크립트는 세션 임시 폴더에 두었다).
orch-loop 계열은 테스트가 `NODE_OPTIONS` 를 지워, 그 줄만 푼 main 사본에서 다시 쟀다.
시간은 부하가 높은 머신의 값이라 절대값보다 비율을 본다. 기동 수는 부하와 무관하다.

| 파일 | 테스트가 띄운 프로세스 시간 | 같은 git 조회 반복 | 가짜 실행 파일 | 테스트 준비 git | 전체 기동 수 |
| --- | --- | --- | --- | --- | --- |
| orch-loop-stall | 833s | 4446회 570s | 883회 116s | 72회 12s | 6103 |
| orch-loop-auto-merge | 535s | 4817회 348s | 801회 73s | 299회 32s | 6596 |
| orch-loop | 445s | 5224회 399s | 689회 89s | 0회 | 6508 |
| orch-loop-ci | 444s | 2981회 286s | 412회 50s | 138회 23s | 3935 |
| cleanup-sweep-merge | 454s | 547회 89s | 410회 60s | 318회 87s | 2400 |
| merge-queue | 482s | 1560회 103s | 5713회 385s | 1회 | 8335 |
| launch-worker | 369s | 1724회 141s | 657회 55s | 158회 22s | 3675 |
| merge-queue-overlap | 223s | 238회 60s | 743회 168s | 449회 220s | 1770 |
| notify-conflicts | 217s | 404회 51s | 63회 16s | 400회 92s | 1189 |
| orch-doctor | 94s | 367회 34s | 170회 28s | 81회 11s | 714 |

- 같은 git 조회 반복: `lib/git.ts` 의 `mainCheckout()` 이 부를 때마다 `git rev-parse --git-common-dir` 를 띄우고, `lib/paths.ts` 의 `ensureIgnored()` 가 부를 때마다 `rev-parse --git-dir` 와 `check-ignore` 를 띄운다. orch-loop 틱 하나에서 같은 값을 약 65번 묻는다. 테스트가 아니라 실제 스크립트의 동작이라 운영 중인 루프도 같은 비용을 낸다.
- 가짜 실행 파일: 가짜 `gh`, `orca`, `ps` 가 모두 node 스크립트라 호출마다 node 를 띄운다. merge-queue 의 가짜 `gh` 는 `--jq` 식을 확인하려고 다시 진짜 `jq` 를 띄운다(2253회).
- 테스트 준비 git: 테스트마다 `git init`, `clone`, `commit`, `push` 로 저장소를 새로 만든다. cleanup-sweep 계열은 템플릿을 복사해 이미 줄였다(`fixtures/cleanup-sweep.ts` 의 `makeRepo`).
- 고정 대기(sleep, 폴링)는 상위 파일에서 큰 몫이 아니었다. `sleep 60` 과 `setInterval` 프로세스는 신호 테스트의 대상으로 띄운 것이라 기다리는 시간이 아니다.

### 줄일 수 있는 시간 추정

| 원인 | 줄이는 방법 | 상위 10개 파일에서 줄어드는 몫 |
| --- | --- | --- |
| 같은 git 조회 반복 | 프로세스 안에서 결과를 기억한다 | 기동 약 2만 3천 회. orch-loop 계열은 프로세스 시간의 60~70% |
| 가짜 실행 파일의 node 기동과 첫 실행 검사 | 가짜를 한 번 만들어 재사용하고, 판정만 보는 테스트는 함수 주입으로 옮긴다 | 기동 약 1만 회. merge-queue 는 프로세스 시간의 80% |
| 테스트 준비 git | 템플릿 저장소를 복사한다 | merge-queue-overlap, notify-conflicts 에서 약 40% |

### 실행기

| 선택지 | 시간 | 의존성 | 설치본 영향 |
| --- | --- | --- | --- |
| node --test 를 그대로 쓰고 `scripts/run-node-tests.ts` 를 없앤다 | 같다. 시간은 위 원인이 정한다 | 없다 | 없다 |
| vitest 로 바꾼다 | 위 원인(프로세스 기동)은 실행기와 무관해 줄지 않는다. 파일마다 변환 단계가 붙는다 | `package.json` 과 `node_modules` 가 생긴다. `docs/code-architecture.md` 의 「Node 내장 모듈만 쓴다」 와 ADR-010 을 바꿔야 한다 | 플러그인은 저장소 루트를 복사해 설치한다(ADR-001). `package.json` 이 설치본에 들어간다 |
| 지금 실행기를 유지한다 | 같다 | 없다 | 없다 |

- `node:test` 를 import 하는 테스트 파일은 104개이고, 그중 16개가 `TestContext`, `t.after`, `mock` 같은 node:test 전용 API 를 쓴다. vitest 로 옮기면 모두 고쳐야 한다.
- 자체 실행기를 만든 이유(신호를 보내는 테스트가 `node --test` 실행기까지 끝낸다)는 오늘 재현되지 않았다. 신호를 보내는 11개 파일(테스트 370개)을 `node --test --test-concurrency=4` 로 돌려 실행기가 끝 요약까지 냈다(96초, 실패 0). CI 도 같은 명령으로 돈다.
- 실행기의 또 다른 쓰임은 Bash 도구의 600초 전경 제한을 피해 백그라운드로 띄우고 `--wait` 로 나눠 기다리는 것이다. 전체 시간이 줄면 이 쓰임도 사라진다.

### 테스트 도우미의 중복 (2026-11-05 main, 9af83a3)

node 테스트 파일 114개(`skills/orch/tests/*.spec.ts`, `extensions/work-board/tests/*.ts`, `skills/inbox/tests/*.ts`)에서 같은 준비를 파일마다 따로 한다.

| 하는 일 | 파일 수 |
| --- | --- |
| 임시 폴더를 만든다(`mkdtempSync`) | 83 |
| 스크립트를 자식 프로세스로 띄운다(`spawnSync`) | 67 |
| `git init` 으로 저장소를 만든다 | 43 |
| 실행 파일을 직접 쓴다(`chmodSync`) | 33 |
| 자기 `git()` 도우미를 둔다 | 28 |
| git 격리 환경 변수(`GIT_CONFIG_GLOBAL`, `GIT_CEILING_DIRECTORIES`)를 따로 건다 | 26 |
| 공용 fixtures 를 import 한다 | 39 |

- 공용 도우미는 `skills/orch/tests/fixtures/` 에만 있다. `fake-bin.ts` 는 규칙으로 답하는 가짜 실행 파일을 테스트마다 새로 쓴다. `cleanup-sweep.ts` 의 `makeRepo` 는 템플릿 저장소를 한 번 만들어 복사한다. `merge-queue-fakes.ts` 의 가짜 `gh` 는 `--jq` 를 진짜 `jq` 로 평가한다.
- 진입 스크립트 38개 가운데 `main` 을 내보내 함수로 부를 수 있는 것은 `cleanup-sweep.ts` 하나다. 나머지는 import 하면 바로 돈다. 판정 로직에 가짜 `run()` 을 주입하려면(DECISION4) 스크립트에 주입 자리를 만들어야 한다.
- node-runtime 전환이 옮길 Python 테스트도 같은 준비를 한다. 내보내는 스킬 가운데 plan, implementation, review-fix, korean-check 의 테스트 9개 파일이 `git init` 을 쓴다.

### 테스트 배포 경로

- 플러그인은 저장소 루트를 설치본에 통째로 복사한다(`docs/code-architecture.md` 「스킬 사이의 경로 참조」). 테스트 폴더도 이미 설치본에 들어간다.
- 팀 내보내기는 스킬 폴더와 `tools/browser-driver` 만 복사한다(`scripts/export-to-team.sh` 의 `SHARED_SKILLS`, `SHARED_TOOLS`). 팀 CI 는 내보낸 스킬의 테스트를 돈다.
- 팀 저장소에서 korean-check, content-preview 는 `plugins/nhn-dev/skills/<이름>` 에 실물이 있고 `skills/<이름>` 은 심볼릭 링크다. node 는 import 경로를 실물 위치에서 푼다. 그래서 이 저장소에서 `../../../tools/<이름>` 으로 닿는 상대 경로가 팀 사본에서는 다른 곳을 가리킨다.

### 지금 실행 명령과 시간

- 로컬 검증은 명령 넷이다(`.orch/overlay.md`): `claude plugin test .`, Python 두 묶음, `node scripts/run-node-tests.ts`.
- CI 는 `Plugin tests` job(`claude plugin test .`, `tsc`, node 테스트)과 `Python tests` job(폴더마다 `unittest discover`, orch·work-board·inbox 폴더는 건너뜀)이다. `.orch/overlay.md` 가 두 job 이름으로 머지 조건을 적는다.
- Python 묶음 12개를 로컬에서 차례로 돌리면 101초다(2026-11-05, load average 약 12). 가장 긴 것은 `scripts/tests` 34초, `skills/plan/tests` 23초다.
- `extensions/work-board/tests/*.test.ts` 셋은 `claude plugin test .` 가 돌린다. Claude Code CLI 가 있어야 한다.

## 범위

이번 범위:

- 느린 원인 하나씩 작은 PR 로 줄인다. PR 마다 같은 머신에서 잰 전후 시간을 PR 본문에 적는다.
- 같은 git 조회 반복을 줄이는 스크립트 수정(출력과 종료 코드는 바꾸지 않는다).
- 테스트의 가짜 실행 파일과 저장소 준비를 줄이는 수정.
- 판정만 보는 CLI 테스트의 함수 주입 전환(DECISION4).
- TypeScript testkit(`modules/testkit`)과 그 자체 테스트. 기존 공용 fixtures 를 testkit 위로 옮긴다.
- node 와 Python 테스트를 함께 도는 실행기 하나와 CI, 로컬 검증 문서의 교체. 자체 실행기 `scripts/run-node-tests.ts` 는 이 실행기로 대신한다(DECISION1).

범위 밖:

- Python 테스트의 속도와 Python testkit. node-runtime 전환이 Python 테스트를 node 로 옮긴다.
- 팀 저장소로 내보내는 스킬의 테스트가 testkit 을 쓰는 일(DECISION7).
- `extensions/work-board/tests/*.test.ts`(`claude plugin test .` 가 돈다)와 `tsc` 타입 검사. CLI 와 npm 설치가 필요해 실행기에 넣지 않는다.
- 머신 부하(다른 worker, 보안 에이전트)를 줄이는 일.
- orch 스크립트의 폴더 이동과 lib 추상화. orch-cli 기능(`docs/features/orch-cli/`)이 맡는다.

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | 느린 원인을 줄여도 테스트가 보는 동작은 그대로다 | 고친 PR 마다 CI 의 node 테스트와 Python 테스트가 통과한다. 지운 테스트가 있으면 같은 동작을 보는 테스트가 남아 있음을 PR 본문에 적는다 |
| REQ2 | 스크립트의 출력과 종료 코드는 바뀌지 않는다 | 고친 스크립트의 기존 테스트가 고치지 않은 채 통과한다 |
| REQ3 | PR 마다 전후 시간을 남긴다 | PR 본문에 testkit 의 측정 명령으로 같은 머신에서 잰 대상 파일의 전후 시간과 기동 수가 있다. 실행기 PR 과 마지막 PR 은 묶음 전체 벽시계도 있다(DECISION12) |
| REQ4 | 목표 시간에 닿는다 | 부하가 낮은 로컬에서 `node --test --test-concurrency=4` 로 묶음 전체를 돌려 벽시계 2분 이하다(DECISION3) |
| REQ5 | 테스트가 testkit(`modules/testkit`)으로 임시 폴더, 격리된 git 과 템플릿 저장소, 가짜 실행 파일, 명령 실행, 가짜 `run()` 을 준비한다 | testkit 의 도우미마다 자기 테스트가 있다. 기존 공용 fixtures(`fake-bin.ts`, `makeRepo`)를 testkit 위로 옮긴 뒤 그것을 쓰는 기존 테스트가 고치지 않은 채 통과한다 |
| REQ6 | 같은 내용의 가짜 실행 파일은 테스트 파일 하나에서 한 번만 새로 쓴다 | 같은 테스트 파일에서 같은 가짜를 두 번 만들면 두 경로가 같은 inode 를 가리킨다(DECISION6) |
| REQ7 | 명령 하나가 저장소의 node 와 Python 테스트를 모두 돌고 요약 하나와 종료 코드를 낸다 | 실행기가 테스트 파일이 있는 묶음만 돈다. 하나라도 실패하면 0 이 아닌 코드로 끝난다. Python 테스트가 없어진 폴더가 있어도 실패하지 않는다 |
| REQ8 | CI 와 로컬 검증이 같은 실행기 명령을 쓴다 | CI 의 테스트 job 하나가 실행기를 옵션 없이 부르고(DECISION11), `.orch/overlay.md` 와 README 가 같은 명령을 적는다. `scripts/run-node-tests.ts` 를 부르는 곳이 없다 |
| REQ9 | 팀으로 내보내는 스킬의 테스트는 testkit 없이 돈다 | `scripts/export-to-team.sh` 가 내보내는 폴더의 파일이 그 폴더 밖을 상대 경로로 import 하면(`modules/testkit` 포함) 저장소 테스트가 그 파일 이름을 내며 실패한다(DECISION19) |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 테스트 실행기 | node --test 를 유지하고 자체 실행기(`scripts/run-node-tests.ts`)를 없앤다. 그 자리는 DECISION9 의 실행기가 대신하고, 백그라운드 대기는 전체 시간이 Bash 600초 제한 아래로 내려온 뒤 지운다 | 사용자 2026-11-04 | 위 「실행기」 표. 병목이 실행기가 아니고 의존성 0 원칙을 지킨다 |
| DECISION2 | 스크립트(운영 코드)를 고쳐 같은 git 조회를 기억하게 해도 되나 | 고친다. 출력과 종료 코드는 그대로다 | 사용자 2026-11-04 | 가장 큰 원인이고 운영 루프도 함께 빨라진다 |
| DECISION3 | 목표 시간 | 로컬 전체 실행 벽시계 2분 이하 | 사용자 2026-11-04 | 「반복해서 돌릴 수 있어야 한다. 모두 스크립트 검사이니 1~2분 안에 끝나야 한다」 |
| DECISION4 | 판정만 보는 CLI 테스트를 함수 주입 테스트로 옮겨도 되나 | 옮긴다. 판정 로직은 가짜 `run()` 을 주입해 보고, 프로세스 경계와 신호, 종료 코드를 보는 대표 테스트만 프로세스로 남긴다 | 사용자 2026-11-04 | 목표 2분은 프로세스 기동을 줄이지 않고는 닿지 않는다 |
| DECISION5 | PR 순서 | 첫 PR 은 같은 git 조회 반복(#336 머지)이다. 남은 순서는 DECISION10 이 정한다. 원인별로 작게 나눠 이어서 머지한다 | 작성자 | 줄어드는 몫이 큰 순서이고, 사용자가 작은 PR 을 요청했다(2026-11-04) |
| DECISION6 | 가짜 실행 파일 재사용 방식 | 내용이 같은 가짜를 한 번 만들고 하드 링크로 건다 | 작성자 | 첫 실행 검사가 inode 단위로 붙는다는 실측 |
| DECISION7 | testkit 의 자리와 배포(플러그인 설치본, 팀 내보내기) | 저장소 공용 폴더 `modules/testkit` 하나. 팀 내보내기에는 싣지 않는다. 내보내는 스킬의 테스트는 testkit 을 import 하지 않고 내장 모듈만 쓴다. `docs/code-architecture.md` 의 「디렉터리 배치」 표에 `modules/` 를 더한다 | 사용자 2026-11-05 | 권장안 `tools/testkit` 과 다르다. `scripts/` 는 이름이 너무 범용적이고 `tools/` 는 없앤다(browser-driver 는 node-runtime 영역 10 에서 `skills/browser` 로 옮긴다). package.json workspaces 는 ADR-010(의존성 0, package.json 없음)과 설치 단계 때문에 고르지 않았다. 팀 사본은 「테스트 배포 경로」 의 심볼릭 링크 때문에 상대 import 가 깨진다. node-runtime 의 실행용 공용 도우미도 `modules/kit` 으로 맞춘다(그쪽 설계가 소유한다) |
| DECISION8 | testkit 첫 판의 도우미 범위 | 다섯 가지. 임시 폴더(테스트 끝에 지움), 격리된 git(환경 변수, `git()` 도우미, 템플릿 저장소 복사), 가짜 실행 파일(한 번 만들고 하드 링크, 호출 기록), 명령 실행(argv, env, stdin 을 받아 종료 코드, stdout, stderr), 가짜 `run()`(응답 규칙과 호출 기록). 가짜 `run()` 은 결과 꼴(code, stdout, stderr)만 정하고 orch 의 `lib/proc.ts` 를 import 하지 않는다. 스냅숏과 시계 고정은 두지 않고 node:test 내장을 쓴다 | 사용자 2026-11-05 | 「테스트 도우미의 중복」. 가짜 실행 파일과 가짜 `run()` 이 같은 규칙 꼴을 쓰면 프로세스 테스트를 함수 테스트로 옮길 때 규칙을 그대로 옮긴다 |
| DECISION9 | 실행기 하나가 두 언어를 도는 방식과 Python 이 사라진 뒤의 모습 | 새 실행기 하나가 `node --test` 한 번과 Python 묶음(`test_*.py` 가 있는 `tests/` 만)을 함께 돌고 요약 하나와 종료 코드를 낸다. `--background`, `--wait` 를 옮겨 두고 묶음 전체가 600초 아래로 내려오면 지운다. `scripts/run-node-tests.ts` 는 같은 PR 에서 지운다. Python 이 사라지면 Python 부분만 지우고 묶음 목록의 원본으로 남긴다. `claude plugin test .` 와 `tsc` 는 넣지 않는다 | 사용자 2026-11-05 | CI 와 로컬이 같은 명령과 같은 묶음 목록을 써, node-runtime 의 영역 PR 이 CI 를 고치지 않아도 된다(그 스펙 REQ5). 두 명령은 CLI 와 npm 설치가 필요하다 |
| DECISION10 | 이행 순서와 PR 단위. DECISION5 의 남은 순서를 대신한다 | orch-cli PR3 앞에는 testkit 첫 판(기존 fixtures `fake-bin.ts`, `makeRepo` 를 그 위로 옮김)과 실행기를 PR 하나씩 머지한다. 가짜 실행 파일 재사용, 템플릿 저장소, 함수 주입 전환은 PR3 뒤 파일 묶음마다 PR 하나(merge-queue, orch-loop 계열, cleanup-sweep 계열, launch-worker 와 나머지)로 node-runtime 전환과 나란히 간다 | 사용자 2026-11-05 | node-runtime 이 기다리는 것은 testkit 과 실행기뿐이다. PR3 이 테스트 100여 개 파일의 스크립트 경로를 고쳐 앞서 고치면 충돌한다. 함수 주입의 자리는 orch 구조 개편이 나눌 어댑터 층과 겹친다 |
| DECISION11 | CI job 구성 | job 하나가 node 와 Python 을 함께 설치하고 실행기를 옵션 없이 부른다. 로컬과 CI 의 테스트 명령이 완전히 같다. `claude plugin test .` 와 `tsc` 도 같은 job 에 둔다. job 이름이 바뀌므로 `.orch/overlay.md` 의 머지 조건과 node-runtime 문서(REQ5, `Python tests` job 을 지우는 마지막 PR)를 어떻게 맞출지는 설계가 적는다 | 사용자 2026-11-05 | 권장안(두 job 을 두고 언어 옵션)과 다르다. node-runtime 쪽 문서는 코디네이터가 그쪽 worker 로 맞춘다 |
| DECISION12 | 측정 기준과 측정 도구의 자리 | PR 마다 대상 파일의 전후 벽시계와 기동 수를 잰다. 묶음 전체 벽시계는 실행기 PR 과 마지막 PR 에서만 잰다. 측정 명령은 testkit 에 두어 PR 마다 같은 방법을 쓴다 | 사용자 2026-11-05 | PR 여러 개가 같은 측정을 되풀이한다. 기동 수는 부하와 무관해 전후 비교의 주 지표다 |
| DECISION13 | 실행기가 묶음을 찾는 법 | 고정 목록을 두지 않는다. 저장소에서 git 이 추적하거나 무시하지 않는 파일 가운데 `tests/` 아래 `*.spec.ts` 를 node 묶음으로, `test_*.py` 가 있는 `tests/` 폴더를 Python 묶음으로 찾는다. `worktrees/` 처럼 git 이 무시하는 폴더와 `claude plugin test .` 의 `*.test.ts` 는 들지 않는다. 로컬과 CI 가 같은 묶음을 돈다 | 작성자 | DECISION9 의 근거(영역 PR 이 목록을 고치지 않는다)를 지키는 방법이 하나다. 지금 로컬 검증은 Python 두 묶음만 돌았지만 CI 는 12개를 돌아, 같게 맞추면 로컬에서 놓치던 실패를 먼저 본다 |
| DECISION14 | 두 언어를 도는 순서와 요약 | 동시에 돈다. 묶음마다 출력은 따로 모아 섞지 않고, 끝에 묶음별 통과·실패 줄과 끝 줄 하나를 낸다. 실패한 묶음은 출력 위치를 적는다 | 작성자 | Python 묶음 차례 실행 101초가 node 묶음과 겹쳐 벽시계에서 빠진다. 지금 실행기의 파일별 요약 꼴을 따른다 |
| DECISION15 | Python 묶음이 남았는데 python3 가 없을 때 | 실패로 세고 이유 한 줄을 낸다 | 작성자 | 빠진 검증이 통과로 보이지 않게 한다. Python 이 모두 사라지면 이 경우도 없어진다 |
| DECISION16 | 함수 주입 PR 의 커밋 나눔과 대표 테스트 | 첫 커밋은 스크립트에 주입 자리만 더하고 기존 테스트를 고치지 않은 채 통과시킨다(REQ2). 다음 커밋에서 판정 테스트를 함수 테스트로 옮긴다(REQ1). 프로세스로 남기는 대표 테스트는 스크립트마다 인자 해석, stdout 꼴, 종료 코드의 종류마다 하나다 | 작성자 | REQ2 와 DECISION4 가 함께 서려면 출력이 그대로인 것을 옮기기 전에 보여야 한다 |
| DECISION17 | 같은 가짜 실행 파일의 뜻과 재사용 범위 | 가짜의 본문에 테스트별 경로를 넣지 않는다. 규칙과 호출 기록의 위치는 환경 변수나 링크 옆 파일로 받는다. 그래서 같은 종류의 가짜는 테스트 파일 하나(프로세스) 안에서 한 inode 를 쓰고, 테스트마다 다른 경로는 하드 링크로 건다. 원본은 그 프로세스가 끝날 때 지운다 | 작성자 | 지금 `fake-bin.ts` 는 경로를 본문에 넣어 폴더마다 내용이 달라 하드 링크가 생길 수 없다. 파일 사이 재사용은 임시 파일이 남고 동시 실행에서 경쟁이 생긴다 |
| DECISION18 | 실패한 테스트의 임시 폴더 | 늘 지운다. 환경 변수 하나를 켜면 남기고 경로를 출력한다 | 작성자 | 기본은 지금 테스트와 같다. 원인을 볼 때만 켠다 |
| DECISION19 | REQ9 가 막는 import | 내보내는 폴더 밖으로 나가는 상대 import 를 모두 실패로 센다. testkit 을 거쳐 가는 경우도 든다 | 작성자 | 팀 사본이 깨지는 원인(심볼릭 링크)은 testkit 에만 있지 않다. 검사 비용이 같다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: 테스트와 스크립트 내부 동작만 바꾼다.
