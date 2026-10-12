# 7. 머지와 정리

머지는 worker 에게 맡기지 않는다.
사용자가 머지까지 맡겼으면 코디네이터가 6단계 검증 뒤 머지한다. 맡기지 않았으면 6단계 검증 뒤 사용자에게 확인받고 머지한다.

## 머지

**PR 머지는 `merge-queue.sh` 로 한다.** 여러 PR 이면 머지할 순서대로 준다.
스크립트가 PR 마다 체크 완료를 기다리고, 실패한 체크, 미해결 리뷰 스레드, 충돌, 원격 HEAD 불일치 중 하나라도 있으면 멈춘다.
옵션과 종료 코드는 스크립트 머리 주석이 소유한다.
PR 번호는 머지할 순서대로 인자 하나씩 준다. 공백으로 이은 변수 하나로 넘기면 zsh 가 쪼개지 않아 사용법 오류로 끝난다.

```bash
bash "$SKILL_DIR/scripts/merge-queue.sh" --repo "$REPO" 101 102 103
```

`STOP` 줄이 나오면 그 PR 에서 멈춘 것이다. 이유를 읽고 고친 뒤 남은 PR 만 다시 준다. 이미 MERGED 인 PR 은 건너뛴다.

- 체크를 보기 전에 PR HEAD 를 고정하고, 머지 직전에 PR HEAD 와 원격 브랜치 HEAD 가 그 값과 같은지 본다. 검사나 머지 전 명령이 도는 사이에 push 된 커밋이 검사 없이 머지되는 것을 막는다
- `mergeable` 이 `UNKNOWN` 이면 GitHub 이 아직 계산 중이다. 스크립트가 몇 번 다시 묻는다
- 머지 결과를 `state` 로 확인한 뒤에만 원격 브랜치를 지운다. `gh pr merge` 가 보호 규칙으로 거절됐는데 브랜치를 지우면 PR 이 닫힌다

### 머지 전 명령

PR 마다 머지 직전에 돌릴 명령이 있으면 `PR번호:명령` 으로 준다. 모든 PR 에 같은 명령이면 `--before` 로 준다.
명령은 `bash -c` 로 돌고 환경 변수 `PR`, `BRANCH`, `OWNER`, `REPO` 를 받는다. 0 이 아니면 그 PR 을 머지하지 않고 멈춘다.

DB 마이그레이션이 든 PR 을 머지하기 전에 개발 DB 를 백업하는 것이 대표적인 예다.
백업 스크립트는 저장소마다 서버와 DB 가 달라 이 스킬에 두지 않는다. 저장소의 오버레이가 경로와 인자를 정한다.

```bash
bash "$SKILL_DIR/scripts/merge-queue.sh" --repo "$REPO" 101 '102:./bin/backup-db.sh orders "before-pr-$PR"' 103
```

백업 스크립트를 저장소에 둘 때 지킬 것이다.

- 덤프가 끝났는지 종료 코드와 파일 크기로 판정하고, 실패하면 0 이 아닌 코드로 끝낸다. 머지 큐가 그 코드로 멈춘다
- 보관 개수를 정하고 오래된 덤프를 지운다. 개발 단계에서는 DB 마다 최근 몇 개만 남겨도 된다
- 비밀번호는 서버 쪽 환경 변수로 읽는다. 명령줄과 출력에 남기지 않는다

## 정리

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
   공통 지시서, 결정 기록, 인수인계 문서, 진행 중 작업의 문서는 남긴다
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
거부되면 먼저 그 worker 터미널을 닫고 잠시 뒤 다시 돌린다.

```bash
"$SKILL_DIR/scripts/remove-worktree.sh" "$WORKTREE" --delete-branch
```

- Orca 가 만든 워크트리를 `orca worktree rm` 으로 지울 때는 뒤에 `git -C "$REPO" worktree prune` 을 돌린다.
  디렉터리만 지우고 git 의 워크트리 기록이 남아, 그대로면 브랜치 삭제가 `used by worktree` 로 거절된다
- **`orca worktree rm` 이 `ok` 를 돌려줘도 디렉터리는 뒤이어 지워진다.** 응답 직후의 `git worktree list` 에는 아직 남아 있다.
  이때 `git worktree remove` 를 덧붙이면 `is not a working tree` 로 실패한다. 손대지 말고 `ls -d "$WORKTREE"` 로 디렉터리가 사라졌는지 확인한 뒤 `prune` 한다
- `orca worktree rm` 은 그 워크트리의 로컬 브랜치까지 지우므로, 이어서 `git branch -d` 가 `not found` 로 끝나면 이미 지워진 것이다

지우기 전에 미커밋 변경과 stash 를 확인한다. `.omc/` 처럼 추적되지 않는 디렉터리만 남은 것은 지워도 된다.

### 남기는 것

- PR 이 열려 있는 워크트리. 리뷰 반영에 필요하고, 머지된 뒤에 지운다
- `release/*` 브랜치. 머지 여부와 무관하게 릴리스 이력이다
