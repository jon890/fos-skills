# 7. 머지와 정리

`cleanup-sweep.ts` 와 `remove-worktree.ts` 는 삭제 전에 그 경로와 하위 경로의 터미널 소유 상태를 확인한다.
소유 상태는 모든 Run 의 worker 행에서 읽는다. 코디네이터 터미널에서 부르면 범위 없는 `worker-list` 가 그 Run 만 주므로(scope `bound`), `run-list` 를 따라 Run 마다 `worker-list --run` 으로 읽어 합친다.
정리 한 번 안에서는 읽은 지 60초가 지나기 전까지 다시 읽지 않고, 범위를 읽는 방법과 이유는 `scripts/lib/ownership.ts` 머리 주석이 소유한다.
터미널 목록이나 모든 Run 의 소유 상태를 읽지 못하면 빈 셸도 닫지 않고 남긴다.

끝난 dispatch 의 터미널을 상태별로 어떻게 정리하는지(`ownershipState` / `retainedReason` 별 `남김` 사유)는 `scripts/lib/ownership.ts` 머리 주석이 소유한다.

`user_takeover` 는 사용자가 의도해 넘겨받은 터미널과, worker 의 claude 가 끝난 뒤 그 셸에 입력이 들어가 자동으로 기록된 터미널을 가르지 못한다. Orca 의 필드에 시각과 주체가 없다.
사용자 터미널을 잘못 닫는 것이 남기는 것보다 나쁘므로 기본은 남긴다.

**코디네이터가 그 워크트리가 자기 worker 것이고 사용자가 쓰지 않는다는 것을 알면 `cleanup-sweep.ts --run "$RUN_ID" --close-own-taken-over` 로 닫는다.**
옵션은 `--run` 과 함께 줄 때만 동작하고, 소유 확인에서 빼는 조건은 `cleanup-sweep.ts` 머리 주석의 「넘겨받은 터미널」 이 소유한다.
`finish-pr.ts` 와 `merge-with-finish.ts` 는 이 옵션을 넘기지 않는다.

머지는 worker 에게 맡기지 않는다.
사용자가 머지까지 맡겼으면 코디네이터가 6단계 검증 뒤 머지한다. 맡기지 않았으면 6단계 검증 뒤 사용자에게 확인받고 머지한다.

## 머지

**PR 머지는 `merge-with-finish.ts` 로 건다. 사용자가 말하지 않아도 마무리까지 함께 건다.**
이 스크립트가 PR 마다 `finish-pr.ts`(아래 「머지 뒤 마무리」)를 백그라운드로 걸고, 같은 인자로 `merge_queue.ts` 를 돌린다.
머지 큐만 걸면 worker 정리, 배포 확인, 업무 완료, 보드 갱신이 코디네이터의 기억에 달려 빠진다.
마무리가 필요 없는 저장소만 `merge_queue.ts` 를 직접 걸거나 `merge-with-finish.ts --no-finish` 를 쓴다.

머지 큐는 오래 걸리므로 Bash 도구의 `run_in_background` 로 건다. 셸의 `&` 나 `nohup` 은 쓰지 않는다.
`merge_queue.ts` 의 옵션과 종료 코드는 그 스크립트 머리 주석이, 래퍼 옵션은 `merge-with-finish.ts` 머리 주석이 소유한다.
PR 번호는 머지할 순서대로 인자 하나씩 준다. 공백으로 이은 변수 하나로 넘기면 zsh 가 쪼개지 않아 사용법 오류로 끝난다.
**PR 번호 뒤 `!` 는 그 PR 이 업무의 마지막 PR 이라는 뜻이다.** 업무 하나에 PR 이 여럿이면 마지막 PR 에만 붙인다. 배포가 성공한 뒤 업무가 완료 처리된다.

`--run "$RUN_ID"` 은 머지 뒤 정리가 다른 Run 의 worker 터미널을 닫지 않도록 한정한다. 빠지면 정리 단계가 Run 으로 한정되지 않는다는 경고가 난다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" --run "$RUN_ID" 101 102 103!
```

저장소마다 다른 값(배포 워크플로, 업무 번호 정규식, 업무 완료 명령, 보드 파일)은 `<repo>/.orch/config.json` 의 `finish` 절에 둔다. 항목은 [`overlay.md`](overlay.md) 가 소유한다.
**머지 큐에 매번 붙이는 옵션(필수 체크, 합친 사본 검사, 문서 glob, 머지 방식, 최신화 규칙, 정리 인자)은 같은 파일의 `queue` 절에 둔다.** `merge-with-finish.ts` 가 명령줄에 없는 옵션을 그 절에서 채운다. 오버레이에서 옵션을 옮겨 적다 하나씩 빠뜨리는 일을 막는다.

**머지 큐가 끝나면 `notify-conflicts.ts` 로 열린 PR 가운데 base 와 충돌하는 것을 찾는다.** 앞 PR 의 머지로 생긴 충돌은 그 PR 의 worker 가 모른 채 끝나, 머지 큐에 넣은 뒤에야 `STOP` 으로 드러난다.
충돌 파일 출력과 알림 중복 방지는 스크립트 머리 주석이 소유한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/notify-conflicts.ts" --repo "$REPO" --base "$BASE" --run "$RUN_ID"
```

`STOP` 줄이 나오면 그 PR 에서 멈춘 것이다. 이유를 읽고 고친 뒤 남은 PR 만 다시 준다. 이미 MERGED 인 PR 은 건너뛴다.
`--continue-on-hold` 를 주면 보류한 PR 의 `STOP` 줄만 찍고 다음 PR 로 간다. 끝 줄이 `QUEUE-DONE` 대신 `QUEUE-HELD <번호...>` 이고 종료 코드는 1 이다. 서로 무관한 PR 여럿을 한 번에 걸 때 쓴다. 뒤 PR 이 앞 PR 에 기대면 쓰지 않는다.

PR 마다 하는 확인(HEAD 고정, 필수 체크가 모두 나타난 뒤 대기, 충돌과 미해결 스레드, 머지 결과 확인)의 순서와 종료 코드는 `merge_queue.ts` 머리 주석이 소유한다.

### draft 로 CI 를 미루는 저장소

**오버레이가 「draft PR 은 CI 를 돌리지 않는다」 고 정한 저장소에서만 쓴다.** 그 저장소의 worker 는 PR 을 draft 로 연다.
코디네이터가 6단계 검증을 마친 PR 을 `ci-ready.ts` 로 ready 로 바꿔 CI 를 시작한다. 그다음 머지 큐에 넣는다.
겹친 PR 둘을 함께 ready 로 바꾸면 앞 PR 이 머지된 뒤 뒤 PR 의 CI 를 다시 돌려야 하므로, 스크립트가 겹치거나 충돌하는 PR 을 보류한다.
판정과 종료 코드는 스크립트 머리 주석이 소유한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/ci-ready.ts" --repo "$REPO" 101 102
```

`보류` 줄의 PR 은 겹친 PR 이 머지된 뒤 다시 돌린다. base 와 충돌하는 PR 은 그 worker 에게 base 를 합치게 한다.

### 실패를 허용하는 체크

**`--allow-fail A,B` 는 필수가 아닌 체크가 코드와 무관한 이유로 실패했고, 그 대신 할 검증을 끝냈을 때만 쓴다.**
사용량 한도나 외부 장애로 리뷰 봇이 실패한 경우가 예다. 그 체크가 하던 일을 독립 리뷰 같은 다른 방법으로 끝낸 뒤에 쓴다.
기본은 실패한 체크가 하나라도 있으면 멈추는 것이다. 모르는 실패를 조용히 넘기지 않으려고 이름을 하나씩 적어 준 체크만 넘긴다.
**실패를 허용하려면 그 이유를 사용자에게 먼저 알린다.** 어떤 체크가 왜 실패했고, 대신 어떤 검증을 끝냈는지 적는다.
필수 체크는 허용할 수 없고, 목록에 없는 체크가 실패하면 멈춘다. 판정은 스크립트 머리 주석이 소유한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" --required test,browser --allow-fail claude-review 101
```

### base 최신 여부

**`--require-up-to-date` 는 기본이 꺼져 있다. 저장소 오버레이가 켜라고 정한 저장소에서만 쓴다.**
켜면 머지 직전에 PR 이 base 최신을 품는지 보고, 품지 않으면 `update-branch` 로 base 를 merge 한 뒤 필수 체크를 다시 기다리고 머지한다.
오래된 base 위에서 각각 통과한 PR 둘이 머지돼 base 빌드가 깨진 일이 있었다. 한 PR 은 계약 칸이 서로 일치하는지 보는 테스트를 더했고, 다른 PR 은 계약 칸을 더했다. 둘 다 서로를 모른 채 통과했고, 머지된 base 에서 테스트가 실패했다.
체크는 PR HEAD 기준으로 도는 것이라 base 가 움직였는지는 모른다. 이 옵션이 그 틈을 닫는다.

- 충돌이 나면 `update-branch` 가 실패해 멈춘다. 충돌을 푸는 일은 그 PR 의 worker 가 한다
- 머지 큐에서 앞선 PR 이 머지되면 뒤 PR 은 base 가 달라진 것이므로 이 옵션이 뒤 PR 마다 다시 base 를 merge 한다. 시간이 더 걸리는 대신 base 가 깨지지 않는다

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" --require-up-to-date --required backend,frontend 101 102
```

### 겹치지 않는 PR 은 최신화하지 않기

**`--up-to-date-when overlap` 은 `--require-up-to-date` 가 base 를 합치는 때를 줄인다. 기본은 `always`(뒤처졌으면 늘 합친다)이고, 바꾸지 않으면 동작이 달라지지 않는다.**
`--require-up-to-date` 만 쓰면 앞 PR 이 머지될 때마다 뒤 PR 이 base 를 합치고 필수 CI 를 다시 기다려, PR 하나에 CI 한 번 분량이 더 든다.
`overlap` 은 PR 이 바꾼 단위와 PR 이 갈라진 뒤 base 에 들어온 변경의 단위가 겹치지 않으면 최신화 없이 머지하고, 겹치면 지금처럼 합치고 CI 를 다시 기다린다.

단위, 공용 경로, 문서 파일, 판정 시점, 다시 판정하는 조건과 횟수 한도는 `merge_queue.ts` 와 `overlap_units.ts` 머리 주석이 소유한다.
PR 차례마다 `<PR> 판정: 바로 머지` 나 `<PR> 판정: 갱신 필요(이유)` 한 줄이 찍힌다. 판정하지 못하면 안전한 쪽인 갱신 필요로 다룬다.
`--require-up-to-date` 가 있어야 한다.

#### 언제 overlap 을 쓰는가

**공용 경로가 잘 정의된 모노레포에서만 쓴다.** 아래 조건을 모두 확인할 수 있어야 한다.

- 다른 모듈의 코드에 컴파일 의존이 있는 모듈 쌍은 `--unit-group a,b` 로 묶었다. 한 단위가 두 묶음에 들 수 없으므로 의존이 사슬(`web` → `bff` → `billing`)이면 사슬 전체를 한 묶음으로 쓴다. 묶음 설정이 틀리면 큐를 시작할 때 종료 코드 2 로 멈춘다
- 모든 모듈에 영향을 주는 경로를 `--shared-paths` 로 빠짐없이 적었다. 공용 모듈, 루트 빌드 파일과 버전 카탈로그(`settings.gradle`, `gradle/`, `buildSrc/`), 계약, CI 설정, 공용 테스트 설정, 저장소 전체에서 번호가 하나로 이어지는 마이그레이션이 후보다
- 머지 뒤 검사가 따로 있다(아래 「머지 뒤 안전망」)

**이 규칙이 놓치는 경우.** 단위가 겹치지 않으면 합친 상태를 아무도 검사하지 않는다.

| 놓치는 경우 | 대응 |
| --- | --- |
| 계약 없이 런타임에 호출하는 모듈 쌍(화면 모듈과 그 BFF) | `--unit-group` 으로 묶는다 |
| 공개 API 를 바꾸고 호출처를 같이 고친 base 변경과, 옛 시그니처를 새로 호출하는 PR | 폴더가 달라 못 잡는다. 모듈 의존을 `--unit-group` 으로 묶거나 `verify_merged_when: code` 를 함께 쓴다 |
| 같은 이름 공간을 쓰는 자원(마이그레이션 버전 번호, 빈 이름, 라우트, 번역 키) | 경로를 `--shared-paths` 에 넣거나 `verify_merged_when: code` 를 함께 쓴다 |
| `--shared-paths` 에서 빠진 루트 파일 | 접두 밖 파일은 파일 경로 자체가 단위라 같은 파일을 고칠 때만 겹친다. 루트에서 모듈이 함께 쓰는 파일을 모두 적는다 |
| 너무 넓은 `--docs-glob`(`*.md` 가 문서 빌드나 doctest 가 읽는 파일일 때) | 문서 glob 은 코드가 읽지 않는 경로로 좁힌다 |
| 판정한 base 를 마지막으로 확인한 때와 머지 API 를 부르는 때 사이의 짧은 틈 | 막을 수 없다. `--match-head-commit` 은 PR HEAD 만 지키고 base 는 지키지 않는다. 이 틈에 들어온 변경은 머지 뒤 안전망으로 잡는다 |
| 합친 사본 검사(`--verify-merged`)를 도는 사이 base 가 움직였다 | 놓치지 않고 `STOP <PR> 검사하는 동안 base(<브랜치>) 가 움직였다. 다시 돌린다` 로 멈춘다. 같은 인자로 다시 걸면 새 base 로 검사한다 |

**머지 뒤 안전망.** `overlap` 으로 합친 상태가 깨져도 PR 쪽 CI 는 알 수 없다. 이미 있는 확인은 `finish-pr.ts` 의 배포 워크플로 성공 대기(`--deploy-workflow`)뿐이다. 머지 커밋의 배포 실행이 실패하면 `FINISH-FAIL` 로 알린다. 배포 워크플로가 없는 저장소에는 머지 뒤 base CI 를 보는 단계가 없다.
깨진 조합을 막으려면 `verify_merged_when: code` 를 `overlap` 과 함께 둬 합친 사본에서 컴파일과 영향받는 모듈의 테스트를 돌린다. 이 경우 CI 재대기는 줄지만 로컬 검사 시간은 든다.
깨진 base 가 나오면 그 PR 을 되돌리는 PR 로 복구한다.

옵션을 매번 적지 않도록 `queue` 절에 둔다. 코디네이터는 `merge-with-finish.ts` 만 부르면 된다.

```json
{
  "queue": {
    "required": ["backend", "frontend"],
    "require_up_to_date": true,
    "up_to_date_when": "overlap",
    "shared_paths": ["^modules/common/", "^(settings|build)\\.gradle(\\.kts)?$", "^(gradle|buildSrc)/", "^\\.github/"],
    "unit_groups": [["web", "bff"]],
    "docs_glob": ["docs/*", "*.md"],
    "sweep_args": ["--specs-dir", ".orch/specs"]
  }
}
```

`sweep_args` 에 `--run` 을 고정하지 않는다. Run 은 명령줄의 `--run` 으로 준다. 둘이 다르면 `merge-with-finish.ts` 가 멈춘다.

그러면 호출은 다음 한 줄이다. 마지막 PR 에는 `!` 를 붙이고, 그 PR 의 보드 항목은 보드 파일에서 `pr` 필드로 찾아 done 으로 바꾼다.
`!` 가 없는 PR 은 보드 항목을 바꾸지 않는다. 같은 PR 이 든 항목이 둘 이상이면 건너뛴다. `--board-item PR=ID` 로 직접 줄 수도 있다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" 492 '495!:./bin/backup-db.sh orders "before-pr-$PR"'
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
`--docs-glob` 을 주면 문서 PR 은 `overlap` 과 `code` 에서 합친 사본 검사를 생략한다. `--stop-on-overlap` 만 쓰면 문서 PR 도 겹침에서 멈춘다.

문서 PR 도 최신 base 와 합친 CI 를 확인해야 하면 **`--update-docs-on-overlap` 을 더한다.** 조건은 스크립트 머리 주석이 소유한다.
기존의 검사 생략 방식을 유지할 수 있도록 기본은 꺼져 있으며, 문서 겹침에서 큐가 멈추던 저장소의 오버레이에서 켠다.

합친 사본 검사가 실패하면 그 PR 을 만든 worker 가 이어 받아 기준 브랜치를 merge 하고 고친다([`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」). rebase 와 force push 는 쓰지 않는다.

`CMD` 가 받는 인자와 환경 변수, 사본을 두는 폴더(`--copy-dir`)는 `merge_queue.ts` 머리 주석이 소유한다.
검증 명령은 실행할 테스트 파일이 실제로 있는지 확인해야 한다.
사본 생성과 머지까지 하는 저장소 스크립트가 이미 있으면 그 전체를 넘기지 않는다. 검증 부분만 넘기며 사본 생성, 충돌 검사, HEAD 대조와 머지는 큐가 한다.
저장소 hook 이 `worktrees/` 밖의 워크트리를 막으면 오버레이가 허용된 폴더를 정한다.
`$VERIFY_CMD` 와 `$COPY_DIR` 은 오버레이의 값이다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" --verify-merged "$VERIFY_CMD" --copy-dir "$COPY_DIR" 101 102
```

### draft 때 건너뛴 필수 체크

draft 에서 CI 를 건너뛰게 둔 저장소는 같은 HEAD 에 결론이 `SKIPPED` 인 실행이 남는다. GitHub 는 `SKIPPED` 를 통과로 본다.
ready 로 바꾼 직후 새 실행이 붙기 전에 머지 큐가 그 체크를 보면 CI 없이 머지한다.
그런 저장소는 오버레이가 `--skipped-is-missing` 을 정한다. 조건은 스크립트 머리 주석이 소유한다.

### 머지 뒤 명령

머지한 뒤 한 번 돌릴 명령이 있으면 `--after-merged CMD` 로 준다. 머지 뒤 배포를 Actions 가 아니라 로컬 스크립트로 하는 저장소가 예다.
문서 PR 만 머지했을 때 배포를 건너뛰려면 명령이 `CODE_PRS` 를 본다. 환경 변수와 실패 처리는 `merge_queue.ts` 머리 주석이 소유한다.
`$AFTER_CMD` 는 오버레이의 값이다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" --docs-glob 'docs/*,*.md' --after-merged "$AFTER_CMD" 101 102
```

저장소의 검증과 배포 명령은 그 저장소의 오버레이가 소유한다.

### 머지 전 명령

PR 마다 머지 직전에 돌릴 명령이 있으면 `PR번호:명령` 으로 준다. 모든 PR 에 같은 명령이면 `--before` 로 준다.
환경 변수와 종료 코드는 `merge_queue.ts` 머리 주석이 소유한다.

DB 마이그레이션이 든 PR 을 머지하기 전에 개발 DB 를 백업하는 것이 대표적인 예다.
백업 스크립트는 저장소마다 서버와 DB 가 달라 이 스킬에 두지 않는다. 저장소의 오버레이가 경로와 인자를 정한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" 101 '102:./bin/backup-db.sh orders "before-pr-$PR"' 103
```

백업 스크립트를 저장소에 둘 때 지킬 것이다.

- 덤프가 끝났는지 종료 코드와 파일 크기로 판정하고, 실패하면 0 이 아닌 코드로 끝낸다. 머지 큐가 그 코드로 멈춘다
- 보관 개수를 정하고 오래된 덤프를 지운다. 개발 단계에서는 DB 마다 최근 몇 개만 남겨도 된다
- 비밀번호는 서버 쪽 환경 변수로 읽는다. 명령줄과 출력에 남기지 않는다

### 머지 뒤 마무리

**`finish-pr.ts` 는 PR 이 MERGED 인 것을 `gh` 로 직접 확인한 뒤에 정리한다.** 머지 직후 `cleanup-sweep.ts` 가 먼저 돌면 GitHub 상태가 아직 반영되지 않아 worker 의 터미널이 살아 있다고 보고 워크트리를 남긴 적이 있다.
순서(머지 확인, worker 정리, 배포 확인, 업무 완료, 보드 done)와 옵션, 판정은 스크립트 머리 주석이 소유한다. 업무 시스템이 없는 저장소는 `--complete` 만 주면 되고, `merge-with-finish.ts` 의 `PR!` 도 같은 뜻이다.

출력은 `<로그 폴더>/finish-<PR>.out` 에 쌓이고 마지막 줄이 `FINISH-DONE` 이나 `FINISH-FAIL` 이다. 깨어날 때마다 그 줄을 본다.
`FINISH-FAIL` 이면 출력의 이유를 읽고 사용자에게 알린다. 배포 실패나 업무 번호 없음처럼 사람이 정해야 하는 것은 스크립트가 다시 시도하지 않는다.
머지 큐가 `STOP` 으로 멈춘 뒤 남은 PR 만 다시 걸어도 같은 PR 의 마무리는 겹쳐 돌지 않는다.

## 정리

**정리는 `cleanup-sweep.ts` 가 한다.** `merge_queue.ts` 가 모든 PR 을 머지한 뒤 `--apply` 로 부르고, 상주 루프(`orch-loop.ts`)가 틱마다 `--remote-branches` 와 함께 부른다.
**사용자가 정리하라고 말하지 않아도 상주 루프가 돈다.** 끝난 워크트리, 터미널과 Dispatch, 로컬 브랜치를 사용자 지시를 기다리며 남겨 두지 않는다.
로컬 브랜치가 없는 원격 브랜치는 `--remote-branches` 로 지운다. 직접 머지한 PR 과 다른 PR 에 합쳐 닫힌 PR 의 원격 브랜치가 여기 든다.
상세 판정은 `cleanup-sweep.ts` 머리 주석이 소유한다.
머지나 완료를 확인하는 즉시 worker 의 워크트리, 브랜치, 터미널을 사용자에게 묻지 않고 정리한다.

**코디네이터가 worker 에게 맡긴 작업은 그 PR 이 머지되면 그 자리에서 정리한다.** 작업을 맡긴 저장소가 코디네이터의 저장소가 아니어도 같다.
대상은 worker 터미널, 워크트리, 로컬 브랜치다(원격 브랜치는 위 조건을 따른다). 지시한 쪽이 정리하지 않으면 아무도 정리하지 않는다.
절차는 아래 「다른 저장소에 맡긴 PR 을 직접 머지했을 때」 가 소유한다.
**다른 세션이 띄운 작업은 건드리지 않는다.** 그 세션이나 사용자가 하던 작업이 끊긴다.
판정 조건과 실행 순서는 스크립트 머리 주석이 소유한다. 지시서 폴더와 Run 은 `--sweep-arg` 로 넘긴다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo "$REPO" --sweep-arg --run --sweep-arg "$RUN_ID" --sweep-arg --specs-dir --sweep-arg "$SPECS_DIR" --sweep-arg --kill-holders 101 102
```

**스크립트 머리 주석이 다루는 경우는 코디네이터가 직접 지우지 않는다.** squash 머지, 로컬과 PR 의 브랜치 이름 차이, 빈 셸 터미널, 살아 있는 dispatch 의 지시서 보호, 남은 프로세스가 대표적이다.
저장소가 여럿이면 `--repo` 를 저장소마다 준다([`waiting.md`](waiting.md) 의 감시 루프 예시).

스크립트가 건너뛴 항목은 `건너뜀` 줄의 이유로 읽는다. 읽는 법은 [`waiting.md`](waiting.md) 의 「깨어날 때마다 정리와 보드 동기화」 가 소유한다.

**PR 을 머지한 직후 같은 흐름에서, 사용자 지시를 기다리지 않고 정리한다.**
워크트리와 터미널이 쌓이면 다음 작업이 어느 것을 써야 할지 매번 판단해야 한다.
같은 워크트리에서 후속 작업을 하는 worker 가 있으면 그 worker 가 끝날 때까지 남긴다.

**worker 터미널은 `worker_done` 뒤에도 PR 이 머지되거나 닫힐 때까지 남긴다.** 충돌과 리뷰 반영을 그 PR 을 만든 worker 가 이어 받기 때문이다([`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」).
머지 뒤에는 그 터미널을 바로 정리한다. `cleanup-sweep.ts` 가 PR 이 MERGED 일 때 닫는다.
머지 없이 닫힌 PR 의 터미널도 `--run` 을 주면 `cleanup-sweep.ts` 가 닫는다. 대상은 내 PR 의 끝난 dispatch 터미널이다.
다른 사람의 PR 이거나 `--run` 이 없으면 코디네이터가 화면을 확인하고 이 세션이 띄운 worker 의 터미널만 `orca terminal close` 로 닫는다.

스크립트가 하지 않아 직접 하는 일은 아래 둘이다.

1. 그 작업만의 문서(지시서 사본, 설계 메모, PR 본문, 리뷰 회신 사본)를 지운다.
   `.orch/` 에 둔 지시서, 조사 보고, 큐 로그, 임시 계획도 작업이 끝나면 지운다(`handoff-cleanup.ts`).
   공통 지시서, 결정 기록, 인수인계 문서, 진행 중 작업의 문서는 남긴다.
   사용자 미리보기 폴더는 content-preview 의 것이라 사용자가 지우라고 말하거나 설정의 `cleanup.previews` 로 맡겼을 때만 지운다
2. 진행 보드를 쓰면 그 항목을 done 으로 바꾼다. [`board.md`](board.md)

**머지 직전과 지우기 직전에 `gh pr view --json state` 를 본다.** 머지는 `OPEN` 일 때만 하고, 브랜치와 워크트리는 `MERGED` 일 때만 지운다.
다른 세션이나 사용자가 같은 PR 을 먼저 머지하기도 한다.

```bash
gh pr view "$PR" --json state --jq .state
```

### 다른 저장소에 맡긴 PR 을 직접 머지했을 때

`merge-with-finish.ts` 의 마무리는 머지 큐를 건 저장소만 정리한다. 다른 저장소에 맡긴 PR 을 코디네이터가 `gh pr merge` 로 머지했으면 바로 이어서 정리한다.
값을 채운다: `$OTHER_REPO` 는 그 저장소의 주 checkout, `$RUN_ID` 는 worker 를 띄운 Run, `$PR` 은 PR 번호, `$WORKER_TERM` 은 그 worker 의 터미널 handle(`worker-show`), `$WORKTREE` 는 그 워크트리 경로다.
먼저 `cleanup-sweep.ts` 로 정리한다. 터미널 소유 확인, 끝난 dispatch 반납, 워크트리와 로컬, 원격 브랜치 삭제를 한 번에 한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/cleanup-sweep.ts" --repo "$OTHER_REPO" --run "$RUN_ID" --kill-holders --apply
```

스크립트가 건너뛴 것만 아래 묶음으로 직접 지운다. 묶음은 PR 이 `MERGED` 일 때만 돈다.
돌리기 전에 그 터미널이 이 세션이 띄운 worker 의 것인지 `worker-list` 의 `ownershipState` 로 본다. `owned` 가 아니면 `orca terminal close` 줄을 빼고 돌린다.

```bash
if [ "$(cd "$OTHER_REPO" && gh pr view "$PR" --json state --jq .state)" = MERGED ]; then
  BRANCH=$(git -C "$WORKTREE" branch --show-current)
  PR_HEAD=$(cd "$OTHER_REPO" && gh pr view "$PR" --json headRefOid --jq .headRefOid)
  orca terminal close --terminal "$WORKER_TERM"
  node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/remove-worktree.ts" "$WORKTREE" --delete-branch --merged-head "$PR_HEAD" --wait 30
  if git -C "$OTHER_REPO" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null; then
    git -C "$OTHER_REPO" push origin --delete "$BRANCH"
  fi
fi
```

### 워크트리 지우기

**작업이 끝난 워크트리는 `remove-worktree.ts` 로만 지운다.** `git worktree remove` 를 바로 쓰지 않는다.
활동 중인 worker 의 워크트리를 `git worktree remove` 로 지워 그 worker 가 종료된 사고가 있었다.
거부하는 경우와 전제는 스크립트 머리 주석이 소유한다. squash 머지로 거부되면 `--merged-head` 를 주고(아래), PR 이 `MERGED` 인 것을 확인했으면 사용자에게 묻지 않고 지운다.
거부되면 먼저 그 worker 터미널을 닫고 `--wait 30` 을 붙여 다시 돌린다.
거부 줄의 pid 가 끝난 dispatch 의 것이면 `cleanup-sweep.ts --kill-holders` 로 끈다. lsof 로 직접 찾아 끄지 않는다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/remove-worktree.ts" "$WORKTREE" --delete-branch
```

squash 머지된 PR 이면 `--merged-head "$PR_HEAD"` 를 더한다. `cleanup-sweep.ts` 는 이 값을 스스로 넘긴다.

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

끝난 작업의 큐 로그, 지시서, 오래된 handoff 폴더와 미리보기, 지난 csv·tsv 는 `handoff-cleanup.ts` 가 휴지통 폴더로 옮긴다. 지우지 않으므로 되살릴 수 있다.
**사용자에게 묻지 않고 `--apply` 로 옮긴다.** 휴지통 폴더라 되살릴 수 있다. 판정 조건과 옵션은 스크립트 머리 주석이 소유한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/handoff-cleanup.ts" --repo "$REPO" --apply
```
