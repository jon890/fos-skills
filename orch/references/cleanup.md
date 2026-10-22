# 7. 머지와 정리

머지는 worker 에게 맡기지 않는다.
사용자가 머지까지 맡겼으면 코디네이터가 6단계 검증 뒤 머지한다. 맡기지 않았으면 6단계 검증 뒤 사용자에게 확인받고 머지한다.

## 머지

**PR 머지는 `merge-with-finish.py` 로 건다. 사용자가 말하지 않아도 마무리까지 함께 건다.**
이 스크립트가 PR 마다 `finish-pr.py`(아래 「머지 뒤 마무리」)를 백그라운드로 걸고, 같은 인자로 `merge-queue.sh` 를 돌린다.
머지 큐만 걸면 worker 정리, 배포 확인, 업무 완료, 보드 갱신이 코디네이터의 기억에 달려 빠진다.
마무리가 필요 없는 저장소만 `merge-queue.sh` 를 직접 걸거나 `merge-with-finish.py --no-finish` 를 쓴다.

머지 큐는 오래 걸리므로 Bash 도구의 `run_in_background` 로 건다. 셸의 `&` 나 `nohup` 은 쓰지 않는다.
`merge-queue.sh` 의 옵션과 종료 코드는 그 스크립트 머리 주석이, 래퍼 옵션은 `merge-with-finish.py` 머리 주석이 소유한다.
PR 번호는 머지할 순서대로 인자 하나씩 준다. 공백으로 이은 변수 하나로 넘기면 zsh 가 쪼개지 않아 사용법 오류로 끝난다.
**PR 번호 뒤 `!` 는 그 PR 이 업무의 마지막 PR 이라는 뜻이다.** 업무 하나에 PR 이 여럿이면 마지막 PR 에만 붙인다. 배포가 성공한 뒤 업무가 완료 처리된다.

```bash
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" 101 102 103!
```

저장소마다 다른 값(배포 워크플로, 업무 번호 정규식, 업무 완료 명령, 보드 파일)은 `<repo>/.claude/orch-finish.json` 의 `finish` 절에 둔다. 항목은 [`overlay.md`](overlay.md) 가 소유한다.
**머지 큐에 매번 붙이는 옵션(필수 체크, 합친 사본 검사, 문서 glob, 머지 방식)은 같은 파일의 `queue` 절에 둔다.** `merge-with-finish.py` 가 명령줄에 없는 옵션을 그 절에서 채운다. 오버레이에서 옵션을 옮겨 적다 하나씩 빠뜨리는 일을 막는다.

**머지 큐가 끝나면 `notify-conflicts.py` 로 열린 PR 가운데 base 와 충돌하는 것을 찾는다.** 앞 PR 의 머지로 생긴 충돌은 그 PR 의 worker 가 모른 채 끝나, 머지 큐에 넣은 뒤에야 `STOP` 으로 드러난다.
스크립트가 충돌 파일을 내고 (PR, base SHA) 마다 한 번만 그 worker 에게 base 를 합치라고 보낸다. 같은 base 로 다시 돌려도 또 보내지 않는다.

```bash
python3 "$SKILL_DIR/scripts/notify-conflicts.py" --repo "$REPO" --base "$BASE" --run "$RUN_ID"
```

`STOP` 줄이 나오면 그 PR 에서 멈춘 것이다. 이유를 읽고 고친 뒤 남은 PR 만 다시 준다. 이미 MERGED 인 PR 은 건너뛴다.
`--continue-on-hold` 를 주면 보류한 PR 의 `STOP` 줄만 찍고 다음 PR 로 간다. 끝 줄이 `QUEUE-DONE` 대신 `QUEUE-HELD <번호...>` 이고 종료 코드는 1 이다. 서로 무관한 PR 여럿을 한 번에 걸 때 쓴다. 뒤 PR 이 앞 PR 에 기대면 쓰지 않는다.

- 체크를 보기 전에 PR HEAD 를 고정하고, 머지 직전에 PR HEAD 와 원격 브랜치 HEAD 가 그 값과 같은지 본다. 검사나 머지 전 명령이 도는 사이에 push 된 커밋이 검사 없이 머지되는 것을 막는다
- **체크가 끝나기를 기다리는 조건은 「대기 0」이 아니라 「필수 체크가 모두 나타났고 대기 0」이다.** PR 을 연 직후에는 체크 목록이 비어 있어, 대기 0 만 보면 체크가 시작도 하기 전에 머지를 시도한다. 필수 체크 이름은 `--required a,b,c` 로 주거나, 주지 않으면 저장소 규칙(`rules/branches/<base>` 의 `required_status_checks`)에서 읽는다. 예전 방식의 브랜치 보호 규칙은 규칙 조회에 나오지 않으므로 `--required` 로 준다. 목록을 끝내 알 수 없으면 경고를 찍고 지금 있는 체크만 기다린다. 무료 플랜의 비공개 저장소는 규칙 API 가 403(플랜 제한)을 내는데, 이때도 경고를 찍고 목록을 빈 것으로 다룬다. 인증, 네트워크, 404 는 멈춘다
- `mergeable` 이 `UNKNOWN` 이면 GitHub 이 아직 계산 중이다. 스크립트가 몇 번 다시 묻는다
- 머지 결과를 `state` 로 확인한 뒤에만 원격 브랜치를 지운다. `gh pr merge` 가 보호 규칙으로 거절됐는데 브랜치를 지우면 PR 이 닫힌다

### draft 로 CI 를 미루는 저장소

**오버레이가 「draft PR 은 CI 를 돌리지 않는다」 고 정한 저장소에서만 쓴다.** 그 저장소의 worker 는 PR 을 draft 로 연다.
코디네이터가 6단계 검증을 마친 PR 을 `ci-ready.py` 로 ready 로 바꿔 CI 를 시작한다. 그다음 머지 큐에 넣는다.
겹친 PR 둘을 함께 ready 로 바꾸면 앞 PR 이 머지된 뒤 뒤 PR 의 CI 를 base 와 합쳐 다시 돌려야 한다.
스크립트는 이미 ready 인 PR 과 파일이 겹치거나 base 와 충돌하는 PR 을 보류하고 이유를 낸다.
바뀐 파일은 GraphQL 이 아니라 REST 로 300 개까지 읽는다. PR 이 많은 저장소에서 GraphQL 은 2차 한도에 걸린다.
판정과 종료 코드는 스크립트 머리 주석이 소유한다.

```bash
python3 "$SKILL_DIR/scripts/ci-ready.py" --repo "$REPO" 101 102
```

`보류` 줄의 PR 은 겹친 PR 이 머지된 뒤 다시 돌린다. base 와 충돌하는 PR 은 그 worker 에게 base 를 합치게 한다.

### 실패를 허용하는 체크

**`--allow-fail A,B` 는 필수가 아닌 체크가 코드와 무관한 이유로 실패했고, 그 대신 할 검증을 끝냈을 때만 쓴다.**
사용량 한도나 외부 장애로 리뷰 봇이 실패한 경우가 예다. 그 체크가 하던 일을 독립 리뷰 같은 다른 방법으로 끝낸 뒤에 쓴다.
기본은 실패한 체크가 하나라도 있으면 멈추는 것이다. 모르는 실패를 조용히 넘기지 않으려고 이름을 하나씩 적어 준 체크만 넘긴다.

- 이름이 든 체크의 실패는 세지 않고 머지 전에 `경고: <PR> 실패를 허용한 체크 <이름>` 줄을 찍는다. 목록에 없는 체크가 실패하면 그대로 멈춘다
- `--required` 나 저장소 규칙의 필수 체크에 든 이름은 허용할 수 없다. 옵션 값이 겹치면 종료 코드 2, 규칙에서 읽은 필수 체크와 겹치면 `STOP` 이다
- 진행 중인 체크는 이 옵션과 상관없이 끝날 때까지 기다린다
- **실패를 허용하려면 그 이유를 사용자에게 먼저 알린다.** 어떤 체크가 왜 실패했고, 대신 어떤 검증을 끝냈는지 적는다

```bash
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" --required test,browser --allow-fail claude-review 101
```

### base 최신 여부

**`--require-up-to-date` 는 기본이 꺼져 있다. 저장소 오버레이가 켜라고 정한 저장소에서만 쓴다.**
켜면 머지 직전에 PR 이 base 최신을 품는지 보고, 품지 않으면 `update-branch` 로 base 를 merge 한 뒤 필수 체크를 다시 기다리고 머지한다.
오래된 base 위에서 각각 통과한 PR 둘이 머지돼 base 빌드가 깨진 일이 있었다. 한 PR 은 계약 칸이 서로 일치하는지 보는 테스트를 더했고, 다른 PR 은 계약 칸을 더했다. 둘 다 서로를 모른 채 통과했고, 머지된 base 에서 테스트가 실패했다.
체크는 PR HEAD 기준으로 도는 것이라 base 가 움직였는지는 모른다. 이 옵션이 그 틈을 닫는다.

- base 를 merge 하면 PR HEAD 가 바뀌고 체크가 새로 시작한다. 새 체크는 한동안 목록에 없으므로 필수 체크 목록이 있어야 이 옵션을 켤 수 있다
- 충돌이 나면 `update-branch` 가 실패해 멈춘다. 충돌을 푸는 일은 그 PR 의 worker 가 한다
- 머지 큐에서 앞선 PR 이 머지되면 뒤 PR 은 base 가 달라진 것이므로 이 옵션이 뒤 PR 마다 다시 base 를 merge 한다. 시간이 더 걸리는 대신 base 가 깨지지 않는다

```bash
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" --require-up-to-date --required backend,frontend 101 102
```

### 같은 파일을 고친 PR

**PR 이 갈라진 뒤 base 에서도 바뀐 파일을 그 PR 이 고쳤으면, 체크가 통과해도 합친 상태는 아무도 검사하지 않았다.**
체크는 PR HEAD 기준으로 돈다. 앞 PR 을 머지한 뒤 같은 파일을 고친 뒤 PR 을 그대로 머지하면 base 에서 처음 깨진다.
`--require-up-to-date` 는 base 를 PR 에 merge 하고 CI 를 다시 돌려 이 틈을 닫지만 PR 마다 CI 를 한 번 더 기다린다.
겹친 PR 만 로컬에서 다시 검사하려면 아래 둘 중 하나를 쓴다.

| 옵션 | 겹치면 | 쓰는 때 |
| --- | --- | --- |
| `--stop-on-overlap` | `STOP <PR> 겹침: <파일>` 로 멈춘다 | 합친 상태를 코디네이터가 따로 확인한다 |
| `--verify-merged CMD` | `origin/<base>` 에 PR HEAD 를 merge 한 임시 사본에서 `CMD` 를 돌려 0 이면 머지한다 | 오버레이가 검사 명령을 정해 두었다 |

**파일이 겹치지 않아도 합치면 깨질 수 있다.** 두 PR 이 각자 통과했지만 합치니 같은 상한을 함께 넘은 일이 있었다.
그런 저장소는 오버레이가 `--verify-merged-when code` 를 정한다. 문서만 바꾼 PR 까지 검사하려면 `always` 다. 기본 `overlap` 은 겹칠 때만 검사한다.
`--docs-glob 'docs/*,*.md'` 를 주면 바꾼 파일이 모두 그 glob 에 맞는 PR 은 `overlap` 과 `code` 에서 합친 사본 검사 없이 머지한다. 문서는 합쳐서 깨질 검사가 없고, 충돌은 `mergeable` 로 이미 걸렀다.

`CMD` 는 사본 경로를 `$1` 로 받고 그 사본 안에서 돈다. 사본은 끝나면 지운다.
KILL 로 끊겨 지우지 못한 사본(`merge-queue-pr<PR>-<pid>`)은 다음 실행이 시작할 때 그 pid 가 죽었으면 지운다.
사본을 두는 폴더는 `--copy-dir` 로 준다. 기본은 `TMPDIR` 이다. 저장소 hook 이 `worktrees/` 밖의 워크트리를 막으면 오버레이가 허용된 폴더를 정한다.
`$VERIFY_CMD` 와 `$COPY_DIR` 은 오버레이의 값이다.

```bash
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" --verify-merged "$VERIFY_CMD" --copy-dir "$COPY_DIR" 101 102
```

### draft 때 건너뛴 필수 체크

draft 에서 CI 를 건너뛰게 둔 저장소는 같은 HEAD 에 결론이 `SKIPPED` 인 실행이 남는다. GitHub 는 `SKIPPED` 를 통과로 본다.
ready 로 바꾼 직후 새 실행이 붙기 전에 머지 큐가 그 체크를 보면 CI 없이 머지한다.
그런 저장소는 오버레이가 `--skipped-is-missing` 을 정한다. `SKIPPED` 인 체크를 나타나지 않은 것으로 보아, 필수 체크가 실제로 돌 때까지 기다린다.
필수 체크 목록(`--required` 나 저장소 규칙)이 있어야 뜻이 있다.

PR 조회(`gh pr view`)가 일시로 실패하면 머지 큐가 10초 간격으로 세 번까지 부른다. 그래도 실패하면 `체크 조회 실패` 로 멈춘다.

### 머지 뒤 명령

머지한 뒤 한 번 돌릴 명령이 있으면 `--after-merged CMD` 로 준다. 머지 뒤 배포를 Actions 가 아니라 로컬 스크립트로 하는 저장소가 예다.
이번 실행에서 PR 을 하나라도 머지했을 때만, 큐가 끝나거나 보류로 멈춘 뒤에 한 번 돈다.
`MERGED_PRS` 는 머지한 PR 번호를, `CODE_PRS` 는 그 가운데 `--docs-glob` 에 맞는 문서 PR 을 뺀 번호를 받는다. 문서 PR 만 머지했을 때 배포를 건너뛰려면 명령이 `CODE_PRS` 를 본다.
실패하면 `AFTER-MERGED-FAILED <종료 코드>` 를 찍고, 모두 머지했으면 종료 코드 3 으로 끝난다. 머지는 되돌리지 않는다.
`$AFTER_CMD` 는 오버레이의 값이다.

```bash
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" --docs-glob 'docs/*,*.md' --after-merged "$AFTER_CMD" 101 102
```

### 머지 전 명령

PR 마다 머지 직전에 돌릴 명령이 있으면 `PR번호:명령` 으로 준다. 모든 PR 에 같은 명령이면 `--before` 로 준다.
명령은 `bash -c` 로 돌고 환경 변수 `PR`, `BRANCH`, `OWNER`, `REPO` 를 받는다. 0 이 아니면 그 PR 을 머지하지 않고 멈춘다.

DB 마이그레이션이 든 PR 을 머지하기 전에 개발 DB 를 백업하는 것이 대표적인 예다.
백업 스크립트는 저장소마다 서버와 DB 가 달라 이 스킬에 두지 않는다. 저장소의 오버레이가 경로와 인자를 정한다.

```bash
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" 101 '102:./bin/backup-db.sh orders "before-pr-$PR"' 103
```

백업 스크립트를 저장소에 둘 때 지킬 것이다.

- 덤프가 끝났는지 종료 코드와 파일 크기로 판정하고, 실패하면 0 이 아닌 코드로 끝낸다. 머지 큐가 그 코드로 멈춘다
- 보관 개수를 정하고 오래된 덤프를 지운다. 개발 단계에서는 DB 마다 최근 몇 개만 남겨도 된다
- 비밀번호는 서버 쪽 환경 변수로 읽는다. 명령줄과 출력에 남기지 않는다

### 머지 뒤 마무리

**`finish-pr.py` 는 PR 이 MERGED 인 것을 `gh` 로 직접 확인한 뒤에 정리한다.** 머지 직후 `cleanup-sweep.py` 가 먼저 돌면 GitHub 상태가 아직 반영되지 않아 worker 의 터미널이 살아 있다고 보고 워크트리를 남긴 적이 있다.
옵션과 판정은 스크립트 머리 주석이 소유한다. 순서는 아래와 같다.

1. PR 이 MERGED 가 될 때까지 기다린다. 머지 없이 닫히면 `FINISH-FAIL` 이다
2. `cleanup-sweep.py --apply --kill-holders` 로 그 브랜치의 dispatch 해제, 터미널 닫기, 워크트리와 브랜치 삭제를 한다. 브랜치의 워크트리가 사라질 때까지 다시 시도한다. `finish-pr.py` 에 지시서 폴더(`--specs-dir`)를 주면 업무의 마지막 PR(`--complete`)일 때만 그 브랜치의 지시서를 지운다. 중간 PR 에서는 남기고 로그에 한 줄 적는다
3. 배포 워크플로를 정했으면 머지 커밋을 조상으로 가진 커밋의 실행이 성공할 때까지 기다린다. 머지 커밋의 실행이 뒤 커밋의 배포에 합쳐져 `skipped` 나 `cancelled` 로 끝나도 뒤 실행이 성공하면 성공이다. 성공도 진행 중도 없이 실패만 있으면 `FINISH-FAIL` 이다
4. `!` 로 건 PR 이면 PR 제목에서 업무 번호를 뽑아 업무 완료 명령을 돌린다. 배포가 실패했으면 돌리지 않는다
5. 보드 항목을 정했으면 done 으로 바꾼다

출력은 `<로그 폴더>/finish-<PR>.out` 에 쌓이고 마지막 줄이 `FINISH-DONE` 이나 `FINISH-FAIL` 이다. 깨어날 때마다 그 줄을 본다.
`FINISH-FAIL` 이면 출력의 이유를 읽고 사용자에게 알린다. 배포 실패나 업무 번호 없음처럼 사람이 정해야 하는 것은 스크립트가 다시 시도하지 않는다.
머지 큐가 `STOP` 으로 멈춘 뒤 남은 PR 만 다시 걸어도 같은 PR 의 마무리는 겹쳐 돌지 않는다. 이미 도는 마무리의 pid 파일을 본다.

## 정리

**정리는 `cleanup-sweep.py` 가 한다.** `merge-queue.sh` 가 모든 PR 을 머지한 뒤 `--apply` 로 부르고, 기다리기 단계의 감시 루프도 깨어날 때마다 부른다.
**사용자가 정리하라고 말하지 않아도 이 루프가 돈다.** 끝난 워크트리, 터미널과 Dispatch, 로컬과 원격 브랜치를 사용자 지시를 기다리며 남겨 두지 않는다.
머지나 완료를 확인하는 즉시 worker 의 워크트리, 브랜치, 터미널을 사용자에게 묻지 않고 정리한다.
이 세션이 일을 맡긴 다른 저장소의 worker 도 같다. 다른 세션이 띄운 작업은 건드리지 않는다.
판정 조건과 실행 순서는 스크립트 머리 주석이 소유한다. 지시서 폴더와 Run 은 `--sweep-arg` 로 넘긴다.

```bash
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" --sweep-arg --run --sweep-arg "$RUN_ID" --sweep-arg --specs-dir --sweep-arg "$SPECS_DIR" --sweep-arg --kill-holders 101 102
```

스크립트가 다루는 것은 아래다. 이 경우를 코디네이터가 직접 지우지 않는다.

- squash 머지된 PR. PR HEAD 를 `--merged-head` 로 넘긴다. 머지 큐의 update-branch 로 PR HEAD 가 워크트리보다 앞서 가도 `refs/pull/<번호>/head` 를 받아 와서 지운다
- 로컬 브랜치 이름(`<user>/<접두>-<주제>`)과 PR 브랜치 이름(`<접두>/<주제>`)이 다른 경우. upstream, `branch.<b>.merge`, 이름 변형 순으로 PR 을 찾는다. PR 조회가 비거나 깨지면 머지로 읽지 않는다
- 예전에 머지된 PR 과 이름만 같은 새 브랜치. 브랜치 끝 커밋이 PR HEAD 와 같거나 그 조상일 때만 그 PR 로 보므로 지우지 않는다. `remove-worktree.sh --merged-head` 도 HEAD 가 그 커밋의 조상이 아니면 거부한다
- worker 를 반납한 뒤 Orca 가 그 워크트리에 띄운 빈 셸 터미널. 폴더를 쓰는 프로세스가 자식 없는 로그인 셸뿐이면 그 터미널을 닫고 다시 시도한다. 다른 프로세스가 남아 있으면 건너뛴다
- 뒤처진 기준 브랜치. 기본 체크아웃이 기준 브랜치에 있으면 `--ff-only` 로 맞춘다. 로컬에만 있는 커밋이 있으면 건드리지 않는다
- 머지된 PR 의 본문 파일. 지시서 폴더의 부모(`<specs-dir>/..`)에 둔 `pr-<이름>.md` 를 지시서와 함께 지운다
- **살아 있는 dispatch 가 쓰는 지시서는 지우지 않는다.** 브랜치가 모두 머지됐다는 이유로 아직 일하는 worker 의 지시서가 지워진 일이 있었다. Task 의 `--spec` 줄이 가리키는 경로를 모아 빼고, 그 목록을 읽지 못하면 그 실행에서는 지시서를 하나도 지우지 않는다. `handoff-cleanup.py` 도 같다
- worker 가 끝난 뒤에도 claude 세션, 로그인 셸, 플러그인 node 같은 프로세스가 그 폴더를 작업 디렉터리로 쥔 경우. `worker-stop` 이 `process=none` 을 돌려줘도 남는다. `--kill-holders` 를 주면 PR 이 MERGED 이고 그 dispatch 가 끝났는지 확인한 뒤 TERM, HUP, KILL 순으로 끈다. 코디네이터 흐름의 명령에는 이 옵션을 넣는다
- 워크트리 없이 남은 머지된 로컬 브랜치와, PR 이 머지된 뒤 남은 원격 브랜치
- worker 가 기준선 비교로 저장소 밖에 만들고 남긴 detached 워크트리. 변경이 없고, 쓰는 프로세스와 터미널이 없고, HEAD 가 원격에 있으면 지운다. 폴더가 이미 없는 등록은 먼저 `git worktree prune` 으로 지운다
- 하위 에이전트 워크트리(`agent-*`)에 Orca 가 띄운 빈 셸 터미널. 다른 Run 의 것인지 확인하지 못해도, 그 경로에 자식 없는 로그인 셸만 있으면 빈 셸로 보고 닫는다. 폴더 이름 규칙이 다르면 `--agent-glob` 로 준다
- 끝난 worker 터미널을 닫자 Orca 가 다시 연 빈 셸(「Terminal 1」). 모든 Run 범위를 읽지 못해 「다른 Run 의 것인지 확인하지 못한 터미널」 로 건너뛰던 것을, 이 Run 의 머지된 워크트리에서 `agentIdentity` 가 없고 그 경로의 프로세스가 자식 없는 로그인 셸뿐이며 터미널마다 셸이 하나씩 있으면 `빈 셸을 닫았다: term_…` 를 남기고 닫는다. `--apply` 가 없으면 닫을 것만 보인다
- 저장소가 여럿인 경우. `--repo` 를 저장소마다 준다([`waiting.md`](waiting.md) 의 감시 루프 예시)

스크립트가 건너뛴 항목과, 스크립트가 다루지 않는 아래 일만 직접 한다.

**PR 을 머지한 직후 같은 흐름에서, 사용자 지시를 기다리지 않고 정리한다.**
워크트리와 터미널이 쌓이면 다음 작업이 어느 것을 써야 할지 매번 판단해야 한다.
같은 워크트리에서 후속 작업을 하는 worker 가 있으면 그 worker 가 끝날 때까지 남긴다.

머지마다 아래를 모두 한다.

1. 그 PR 의 dispatch 를 반납하고 worker 터미널을 닫는다. 반납 명령과 잔여 확인 방법은 Orca 가이드를 따른다
2. 원격을 갱신하고 로컬 기준 브랜치를 fast-forward 로 맞춘다(아래 명령).
   워크트리를 지우기 전에 한다. 원격 추적 브랜치가 낡으면 `remove-worktree.sh` 가 머지된 커밋을 원격에 없는 커밋으로 센다.
   백그라운드 동기화 루프는 compact 나 세션 재시작으로 끊기므로 머지마다 직접 한다
3. 워크트리를 `remove-worktree.sh` 로 지운다(아래)
4. 로컬과 원격 브랜치를 지운다. `merge-queue.sh` 가 원격 브랜치를 지웠으면 로컬만 남는다
5. 그 작업만의 문서(지시서 사본, 설계 메모, PR 본문, 리뷰 회신 사본)를 지운다.
   `.omc/` 에 둔 지시서, 조사 보고, 큐 로그, 임시 계획도 작업이 끝나면 지운다.
   공통 지시서, 결정 기록, 인수인계 문서, 진행 중 작업의 문서는 남긴다.
   사용자 미리보기 폴더(`.omc/previews/`)는 사용자가 지우라고 말할 때만 지운다
6. 진행 보드를 쓰면 그 항목을 done 으로 바꾼다. [`board.md`](board.md)

`merge --ff-only` 는 지금 체크아웃된 브랜치에 들어가므로, 기준 브랜치가 체크아웃돼 있을 때만 돌린다.

```bash
git -C "$REPO" fetch --prune origin
[ "$(git -C "$REPO" branch --show-current)" = "$BASE" ] && git -C "$REPO" merge --ff-only "origin/$BASE"
```

**머지 직전과 지우기 직전에 `gh pr view --json state` 를 본다.** 머지는 `OPEN` 일 때만 하고, 브랜치와 워크트리는 `MERGED` 일 때만 지운다.
다른 세션이나 사용자가 같은 PR 을 먼저 머지하기도 한다.

```bash
gh pr view "$PR" --json state --jq .state
```

### 워크트리 지우기

**작업이 끝난 워크트리는 `remove-worktree.sh` 로만 지운다.** `git worktree remove` 를 바로 쓰지 않는다.
활동 중인 worker 의 워크트리를 `git worktree remove` 로 지워 그 worker 가 종료된 사고가 있었다.
스크립트는 그 경로를 쓰는 프로세스(살아 있는 worker), 커밋 안 된 변경, 원격 어디에도 없는 커밋이 있으면 지우지 않고 이유를 낸다.
원격에 같은 제목의 커밋이 있으면 rebase 된 것으로 보지만, squash 머지는 제목이 달라 원격에 없는 커밋으로 센다. 그때는 PR 이 `MERGED` 인 것을 확인한 뒤 사용자에게 알리고 지운다.
macOS 의 zsh 와 `lsof`, git 2.31 이상을 전제한다.
거부되면 먼저 그 worker 터미널을 닫고 `--wait 30` 을 붙여 다시 돌린다. 그 초 동안 프로세스가 빠지기를 기다린다.
OMC session-end hook worker 만 남은 경우는 옵션 없이도 끝날 때까지 기다린다(`ORCH_HOOK_WAIT`, 기본 180초).
거부 줄의 pid 가 끝난 dispatch 의 것이면 `cleanup-sweep.py --kill-holders` 로 끈다. lsof 로 직접 찾아 끄지 않는다.

```bash
"$SKILL_DIR/scripts/remove-worktree.sh" "$WORKTREE" --delete-branch
```

squash 머지된 PR 이면 `--merged-head "$PR_HEAD"` 를 더한다. 그 커밋의 조상은 원격에 있는 것으로 센다. `cleanup-sweep.py` 는 이 값을 스스로 넘긴다.

- Orca 가 만든 워크트리를 `orca worktree rm` 으로 지울 때는 뒤에 `git -C "$REPO" worktree prune` 을 돌린다.
  디렉터리만 지우고 git 의 워크트리 기록이 남아, 그대로면 브랜치 삭제가 `used by worktree` 로 거절된다
- **`orca worktree rm` 이 `ok` 를 돌려줘도 디렉터리는 뒤이어 지워진다.** 응답 직후의 `git worktree list` 에는 아직 남아 있다.
  이때 `git worktree remove` 를 덧붙이면 `is not a working tree` 로 실패한다. 손대지 말고 `ls -d "$WORKTREE"` 로 디렉터리가 사라졌는지 확인한 뒤 `prune` 한다
- `orca worktree rm` 은 그 워크트리의 로컬 브랜치까지 지우므로, 이어서 `git branch -d` 가 `not found` 로 끝나면 이미 지워진 것이다

지우기 전에 미커밋 변경과 stash 를 확인한다. `.omc/` 처럼 추적되지 않는 디렉터리만 남은 것은 지워도 된다.

### 남기는 것

- PR 이 열려 있는 워크트리. 리뷰 반영에 필요하고, 머지된 뒤에 지운다
- `release/*` 브랜치. 머지 여부와 무관하게 릴리스 이력이다

### handoff 산출물 정리

끝난 작업의 큐 로그, 지시서, 오래된 handoff 폴더와 미리보기, 지난 csv·tsv 는 `handoff-cleanup.py` 가 휴지통 폴더로 옮긴다. 지우지 않으므로 되살릴 수 있다.
**기본은 옮길 후보만 보인다. 후보를 사용자에게 보인 뒤 `--apply` 로 옮긴다.** 판정 조건과 옵션은 스크립트 머리 주석이 소유한다.

```bash
python3 "$SKILL_DIR/scripts/handoff-cleanup.py" --repo "$REPO"
python3 "$SKILL_DIR/scripts/handoff-cleanup.py" --repo "$REPO" --apply
```

- 지시서는 보드 항목이 done 이 아니면 남긴다. 띄우기 전이거나 PR 이 여럿인 일의 중간일 수 있다
- 열린 PR 목록을 읽지 못하면 지시서를 옮기지 않는다
- 살아 있는 dispatch 의 `--spec` 줄이 가리키는 지시서는 옮기지 않는다. 그 목록을 읽지 못해도 옮기지 않는다
- 미리보기와 handoff 폴더는 3일 넘게 바뀌지 않았고 보드 파일과 `<previews>/.keep` 에 이름이 없을 때만 옮긴다. 남길 미리보기는 `.keep` 에 한 줄에 하나씩 적는다
