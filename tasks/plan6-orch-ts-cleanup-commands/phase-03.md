# Phase 03. 원격 브랜치 정리와 닫힌 PR 의 터미널 정리를 더한다

**Execution profile**: deep

## 목표

`cleanup-sweep.ts` 에 로컬 브랜치가 없어도 내 PR 의 원격 브랜치를 지우는 `--remote-branches` 를 더한다. 직접 머지한 PR 과 다른 PR 에 합쳐 닫힌 PR 의 브랜치가 쌓이지 않게 한다.
머지 없이 CLOSED 가 된 내 PR 의 끝난 dispatch 터미널을 닫고 dispatch 를 반납한다.

**범위 외**: 상주 루프가 `--remote-branches` 를 틱마다 부르는 일. 상주 루프 plan 이 한다. 워크트리 지우기의 대상 판정은 바꾸지 않는다.

## 컨텍스트

시작 조건: `orch/scripts/cleanup-sweep.ts` 가 있고 `orch/scripts/terminal_ownership.py` 가 없다. 아니면 `PHASE_BLOCKED: phase 02 커밋 전` 을 내고 멈춘다.

「내 PR」 판정은 `lib/gh.ts` 의 `ownAuthors(repo, host)` 와 `isOwnPr` 이다. 작성자 목록은 `config.json` 의 `pipeline.authors`, 없으면 그 호스트의 gh 현재 사용자다. host 는 `gh repo view --json url` 의 URL 을 `apiTarget` 으로 읽은 값이다. 목록은 `--remote-branches` 를 받았거나 CLOSED PR 을 처음 만났을 때 저장소마다 한 번 읽는다. 무조건 읽으면 `pipeline.authors` 가 없는 저장소의 모든 정리가 gh 현재 사용자를 조회하고, 그 조회가 실패하면 CLOSED PR 이 없어도 2 로 끝난다. 목록이 null 이거나 ConfigError 면 그 저장소에서 이 phase 의 두 동작을 하지 않고, stderr 에 이유를 내고, 종료 코드를 2 로 둔다. 누가 내 PR 인지 모른 채 지우거나 닫지 않는다.

머지 큐의 `merge_queue.ts` 의 `deleteBranch` 는 머지한 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면 그 PR 의 base 를 옮긴 뒤 지운다. `--remote-branches` 는 base 를 옮기지 않는다. 열린 PR 의 base 인 브랜치는 남긴다. 머지 직후가 아닌 뒤늦은 정리라 열린 PR 의 base 를 바꾸는 판단을 하지 않는다.

**근거 문서**: `docs/flow.md` 의 「운영 공백을 막는 곳」 의 원격 브랜치 줄과 「갈래」 의 `worker_done` 뒤 PR 이 열려 있는 줄, `docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」 의 충돌한 PR 줄과 「공통 안전 장치」 의 다른 사람 PR 제외 줄, `docs/data-schema.md` 의 `pipeline.authors` 줄

## 의도 메모

- CLOSED 이고 head 가 base 에 없으면 버린 작업일 수 있어 원격 브랜치를 지우지 않는다. 다른 PR 에 합쳐 닫힌 PR 은 head 커밋이 base 에 들어 있다.
- worker 터미널은 `worker_done` 뒤에도 그 PR 이 머지되거나 닫힐 때까지 남긴다(사용자 결정 2026-10-24). 충돌과 리뷰 반영을 같은 worker 가 이어 받기 위해서다. 원본은 MERGED 일 때만 터미널을 닫아, 머지 없이 닫힌 PR 의 터미널이 남았다.
- CLOSED PR 의 워크트리는 지우기 판정(MERGED, 또는 upstream 이 없고 `git cherry` 로 base 에 없는 커밋이 0)을 그대로 따른다. 터미널만 닫고 워크트리는 남는 경우가 있다.
- `--kill-holders` 와 `--merged-head` 는 MERGED 일 때만이다. CLOSED PR 의 head 는 머지된 커밋이 아니다.

## 작업 항목

### 1. `--remote-branches`

`--repo` 마다 워크트리와 로컬 브랜치 정리가 끝난 뒤에 돈다. 기본은 지울 것만 보이고, `--apply` 일 때 `git push origin --delete <이름>` 으로 지운다.

후보 수집:

- 작성자마다 `gh pr list --state closed --author <작성자> --limit 100 --json number,state,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt` 를 부른다. MERGED 와 CLOSED 가 함께 온다
- 원격 브랜치는 `git ls-remote --heads origin` 한 번으로 이름과 끝점을 읽는다
- 열린 PR 의 base 는 `gh pr list --state open --limit 1000 --json baseRefName` 한 번으로 읽는다
- 셋 가운데 하나라도 실패하면 그 저장소의 원격 브랜치를 지우지 않고 `원격 브랜치 정리 건너뜀: <이유>` 를 내고 종료 코드를 2 로 둔다

원격에 있는 이름마다 한 번 판정한다. 그 이름을 head 로 둔 PR 가운데 `headRefOid` 가 원격 끝점과 같은 PR 을 쓴다. 원격에 없는 이름은 줄을 내지 않는다. 출력은 원본의 원격 브랜치 줄과 같은 꼴(`원격 브랜치 남김 <이름>: <이유>`, `원격 브랜치를 지울 것 <이름>`, `원격 브랜치 삭제 <이름>`, `원격 브랜치 삭제 실패 <이름>: <오류>`)이고 지울 것과 삭제 줄 끝에 ` (#<PR> <state>)` 를 붙인다.

| 차례 | 조건 | 걸리면 |
| --- | --- | --- |
| 1 | `isCrossRepository` 가 true 다 | `fork 의 브랜치다` 로 남긴다 |
| 2 | 이름이 기준 브랜치이거나 `release/` 로 시작한다 | `보호 브랜치다` 로 남긴다 |
| 3 | 끝점이 같은 PR 이 없다 | `원격 끝점이 PR head 와 다르다` 로 남긴다 |
| 4 | 열린 PR 의 base 다 | `열린 PR 의 base 다` 로 남긴다 |
| 5 | MERGED 다 | 지운다 |
| 6 | CLOSED 이고 `git merge-base --is-ancestor <headRefOid> origin/<baseRefName>` 가 0 이다 | 지운다. head 커밋이 로컬에 없으면 먼저 `git fetch -q origin <headRefName>` 로 받는다. 받지 못하면 `head 커밋을 받지 못했다`, `origin/<baseRefName>` 이 없으면 `base 를 찾지 못했다` 로 남긴다 |
| 7 | 그 밖(CLOSED 이고 head 가 base 에 없다) | `CLOSED 이고 head 가 base 에 없다` 로 남긴다 |

`origin/<baseRefName>` 은 phase 02 의 정리가 저장소마다 처음에 하는 `git fetch -q --prune origin` 이 갱신한 원격 추적 브랜치다.

### 2. 머지 없이 CLOSED 가 된 PR 의 터미널

워크트리마다 PR 찾기(원본 머리 주석의 「PR 찾기」)로 찾은 PR 이 아래를 모두 채우면, 그 dispatch 가 쓴 터미널을 닫고 dispatch 를 반납한다. PR 찾기의 `gh pr list --head` 필드에는 phase 02 가 `author` 를 이미 더했다.

- PR 의 state 가 CLOSED 다(MERGED 가 아니다)
- 내 PR 이다
- `--run` 으로 찾은 그 경로의 worker 가 하나 이상이고 모두 workerState 가 succeeded 나 fenced 다
- 그 터미널이 `lib/ownership.ts` 의 소유 확인을 통과한다. 사용자 보유 터미널이면 원본처럼 `남김: 사용자 보유 터미널` 이다

닫는 터미널은 그 worker 행의 `terminalHandle` 과 `agentTerminalHandle` 이다. 같은 경로의 다른 터미널은 닫지 않는다. `--apply` 가 없으면 `닫을 것: <터미널> (CLOSED #<PR>)` 만 낸다.
끼워 넣을 자리는 `sweep_worktree`(phase 02 가 옮긴 `cleanup-sweep.ts` 의 같은 함수)에서 소유 확인과 PR 찾기 뒤, `merged` 판정이 `남김` 으로 일찍 끝내기 전이다. 위 조건을 채우면 둘로 나눈다.

- 워크트리가 지우기 대상이 아니다(`merged` 가 「PR CLOSED, upstream 이 남아 있다」 를 낸다): 터미널을 닫고 dispatch 를 반납한 뒤 원본의 `남김 <경로>: PR CLOSED, upstream 이 남아 있다` 줄을 낸다.
- 워크트리가 지우기 대상이다(upstream 이 없고 cherry 가 0): 뒤따르는 살아 있는 worker 와 살아 있는 터미널 판정에서 이 PR 을 MERGED PR(`by_pr`)과 같게 다뤄, 그 dispatch 의 터미널 때문에 `건너뜀` 이 되지 않게 한다. 그다음 phase 02 의 자리(`정리` 줄 직후, 터미널 닫기 앞)에서 `before-cleanup` 을 내고, 거부되면 터미널도 닫지 않는다.
`--run` 이 없으면 이 동작을 하지 않는다. 열린 PR 의 끝난 dispatch 터미널은 지금처럼 남긴다.

### 3. 머리 주석과 문서

- `cleanup-sweep.ts` 머리 주석: 사용법과 옵션에 `--remote-branches` 를, 「원격 브랜치 삭제」 에 위 표를, 「정리 대상」 에 CLOSED PR 의 터미널을 더한다. 「로컬 브랜치 없이 직접 머지한 PR 의 원격 브랜치는 남을 수 있다」 를 「`--remote-branches` 가 지운다」 로 바꾼다. base 를 옮기지 않는 이유도 적는다
- `orch/README.md` 의 `scripts/cleanup-sweep.ts` 줄에 `--remote-branches` 와 CLOSED PR 의 터미널 정리를 더한다
- `orch/references/cleanup.md` 231행의 「로컬 브랜치가 있을 때만 원격 브랜치도 지운다. 직접 머지한 PR 의 원격 브랜치는 남을 수 있고」 를 `--remote-branches` 로 그 브랜치를 지운다는 문장으로 바꾼다

### 4. 테스트

`orch/tests/cleanup-sweep.spec.ts` 에 더한다. 원격은 임시 bare 저장소, PR 목록은 가짜 gh 다. `--remote-branches` 사례는 `--apply` 로 돌리고 `git ls-remote` 로 원격에 남은 브랜치를 본다.

- MERGED 인 내 PR 의 원격 브랜치를 지운다
- CLOSED 이고 head 커밋이 base 에 들어 있으면(다른 PR 에 합쳐 닫힌 경우) 지운다
- CLOSED 이고 head 커밋이 base 에 없으면 `CLOSED 이고 head 가 base 에 없다` 로 남긴다
- 다른 작성자의 PR 브랜치는 남는다(그 작성자의 목록을 부르지 않는다)
- 열린 PR 의 base 인 브랜치는 `열린 PR 의 base 다` 로 남기고, 그 열린 PR 의 base 를 바꾸는 `gh pr edit` 를 부르지 않는다
- `release/x` 는 남긴다
- fork PR(`isCrossRepository: true`)과 같은 이름의 원격 브랜치는 남긴다
- 원격 끝점이 PR 의 `headRefOid` 와 다르면 `원격 끝점이 PR head 와 다르다` 로 남긴다
- `--apply` 가 없으면 `원격 브랜치를 지울 것` 만 나고 원격이 그대로다
- 머지 없이 CLOSED 가 된 내 PR 의 끝난 dispatch 터미널을 닫고 dispatch 를 반납한다. 그 워크트리에 원격에 없는 커밋이 있으면 워크트리는 남는다
- 열린 PR 의 끝난 dispatch 터미널은 남긴다
- 다른 작성자의 CLOSED PR 이면 터미널을 남긴다
- cherry 판정을 통과한 CLOSED PR 은 한 번 실행에 끝난 dispatch 의 터미널을 닫고 워크트리를 지운다. upstream 이 남은 CLOSED PR 은 터미널만 닫고 `남김 … upstream 이 남아 있다` 로 워크트리를 남긴다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/cleanup-sweep.spec.ts orch/tests/cleanup-wait.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/README.md orch/references/cleanup.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/cleanup-sweep.ts` | 수정 |
| `orch/tests/cleanup-sweep.spec.ts` | 수정 |
| `orch/README.md` | 수정 |
| `orch/references/cleanup.md` | 수정 |

## 구현 중 정한 것

- 열린 PR 의 head 인 브랜치도 남긴다. 지우면 그 열린 PR 이 닫힌다. 그래서 열린 PR 조회가 `baseRefName` 과 `headRefName` 을 함께 읽는다.
- 원격 삭제는 `--force-with-lease=refs/heads/<이름>:<판정한 끝점>` 을 붙여, 판정한 뒤 그사이 push 된 브랜치를 지우지 않는다.
- fork 판정은 그 이름의 PR 가운데 `isCrossRepository` 가 true 인 것이 하나라도 있으면 남긴다.
- 작성자 목록은 CLOSED PR 이면서 이 Run 의 worker 가 모두 끝난 경우에만 읽는다.
- 모든 Run 의 worker 를 읽지 못했으면 CLOSED PR 의 터미널 가운데 `agentTerminalHandle` 만 이 Run 의 것으로 보고 닫는다.
