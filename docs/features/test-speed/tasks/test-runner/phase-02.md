# Phase 02. CI job 하나와 로컬 검증 문서

**Execution profile**: standard

## 목표

CI 가 job 하나(`Tests`)에서 `claude plugin test .` 와 `node scripts/run-tests.ts` 만 부르고, `.orch/overlay.md`, README, `docs/code-architecture.md` 가 같은 명령을 적는다. 묶음 전체의 전후 시간을 잰다.

**범위 외**: 실행기 코드(phase 01). node-runtime 문서(이미 이 꼴로 맞춰져 있다. 설계 「CI 와 로컬 검증」).

## 컨텍스트

- 지금 `.github/workflows/ci.yml` 은 `plugin`(`Plugin tests`: setup-node 24, Claude Code CLI 2.1.309 설치, `claude plugin test .`, tsc 설치와 검사, node 테스트 줄, 제한 10분)과 `python`(`Python tests`: setup-python 3.12, setup-node 24, `jq`·`zsh` 설치, 폴더마다 `unittest discover` 반복문, 제한 15분) 두 job 이다.
- 사용자가 job 하나로 정했다(스펙 DECISION11). 실행기 밖에 `tsc` 단계가 남지 않는다(REQ10). `FOS_TSC_DIR`, `NODE_COMPILE_CACHE` 는 주지 않고 실행기 기본값을 쓴다(설계 「CI 와 로컬 검증」).
- `.orch/overlay.md` 의 머지 조건(「`Plugin tests` 와 `Python tests` 가 모두 통과」)과 로컬 검증 줄이 바뀐다. main 에 branch protection 의 필수 검사는 없다(node-runtime 스펙 「실측」).
- `git grep run-node-tests` 로 찾은 저장소 파일: `.orch/overlay.md`, README(「scripts」 표 286줄 근처, 「기여」 304~306줄 근처). `docs/features/` 의 기능 문서는 경위라 고치지 않는다.

**요구사항**: REQ1, REQ3, REQ8, REQ10

**근거 문서**: `docs/features/test-speed/spec.md`(DECISION11, DECISION12, DECISION20), `docs/features/test-speed/design.md` 「CI 와 로컬 검증」, 「측정 명령」

## 의도 메모

- job 이름은 `Tests` 다. 코디네이터의 다른 저장소 지시서(`.orch/specs/`)가 옛 job 이름이나 `run-node-tests.ts` 를 적으면 PR 본문에 그 사실을 적어 코디네이터가 고치게 한다. 이 PR 은 저장소 밖 파일을 고치지 않는다.
- 전 시간에는 옛 실행기 끝 줄에 걸린 시간이 없다. 그래서 옛 명령들을 차례로 돈 바깥 시간으로 잰다.

## 작업 항목

### 1. `.github/workflows/ci.yml`

- jobs 를 `tests`(name `Tests`, `timeout-minutes: 15`) 하나로 합친다. 단계: checkout(`persist-credentials: false`), setup-node 24(`check-latest: true`), setup-python 3.12, `sudo apt-get update && sudo apt-get install --yes jq zsh`, `npm install --global @anthropic-ai/claude-code@2.1.309`, `claude plugin test .`, `node scripts/run-tests.ts`.
- 기존 주석 가운데 아직 맞는 것(typescript 를 임시 폴더에 설치하는 이유)은 실행기 머리 주석으로 옮겼는지 확인하고 workflow 에서 지운다.

### 2. `.orch/overlay.md`

- 머지 조건을 「머지 전 `Tests` 가 통과해야 한다」 로 바꾼다.
- 로컬 검증을 「저장소 루트에서 `claude plugin test .` 와 `node scripts/run-tests.ts` 를 실행한다. 600초를 넘기면 `--background` 로 띄우고 출력된 `--wait` 명령을 끝 줄이 나올 때까지 다시 부른다」 로 바꾼다.

### 3. README

- 「scripts」 표의 `run-node-tests.ts` 행을 `run-tests.ts`(node, Python 테스트와 tsc 를 함께 돌고 결과 폴더에 요약을 남긴다. 사용법은 머리 주석) 로 바꾼다.
- 「기여」 의 테스트 설명에서 Python 폴더별 명령, `run-node-tests.ts`, 「파일마다 세션을 나눠요」 줄을 `node scripts/run-tests.ts` 하나와 「`claude plugin test .` 는 따로 돌린다」 로 바꾼다. 오래 걸릴 때의 `--background`, `--wait` 안내는 남긴다. 한 파일만 돌릴 때 인자를 준다는 것도 적는다.
- `python3 -m unittest discover -s scripts/tests` 를 부르는 다른 README 줄(매니페스트 검사 설명 등)은 `node scripts/run-tests.ts scripts/tests` 로 바꾼다.

### 4. `docs/code-architecture.md`

- 「모듈 책임」 표에 `scripts/run-tests.ts` 행(저장소의 검증 명령. 묶음 찾기, tsc·node·Python 단계, 요약과 끝 줄. 부르는 쪽: 사람, worker, CI)을 더한다.
- 「검증」 표의 `node --test ...` 줄과 `python3 -m unittest discover -s scripts/tests` 줄을 `node scripts/run-tests.ts` 한 줄(확인하는 것: 저장소의 모든 node·Python 테스트와 tsc)로 바꾸고 매니페스트 검사 설명은 그 칸에 남긴다.
- 「실행 규칙」 의 「테스트」 행을 「`node scripts/run-tests.ts`. `node --test` 한 번과 Python 묶음, tsc 를 함께 돈다. CI 는 `Tests` job 이 같은 명령을 부른다」 로 바꾼다.

### 5. 측정과 PR 본문

- 전: origin/main 에서 `time node scripts/run-node-tests.ts` 와 CI 의 Python 반복문(`for suite in ...; do python3 -m unittest discover -s "$suite"; done`)을 차례로 돈 바깥 시간.
- 후: 이 브랜치에서 `node scripts/run-tests.ts` 끝 줄의 걸린 시간.
- 두 값과 `uptime` 을 PR 본문 표에 적는다(스펙 DECISION12, REQ3). CI 의 job 시간(전: 두 job 중 긴 쪽, 후: `Tests`)도 적는다.

## 검증

```bash
git grep -l run-node-tests -- ':!docs/features/' | wc -l | grep -qx '\s*0'
git grep -n "Plugin tests\|Python tests" -- .orch/overlay.md README.md docs/code-architecture.md .github/workflows/ci.yml | wc -l | grep -qx '\s*0'
node scripts/run-tests.ts --background
```

마지막 줄이 출력한 `--wait` 명령을 끝 줄이 나올 때까지 다시 부르고 종료 코드 0 을 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `.github/workflows/ci.yml` | 수정 |
| `.orch/overlay.md` | 수정 |
| `README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
