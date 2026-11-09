# 6. 완료 검증

상주 루프(`orch-loop.ts`)는 CI 를 보고 알린다. `queue.auto_merge` 를 켠 저장소에서는 머지할 수 있는 PR 을 머지 큐에 건다(`orch-loop.ts` 머리 주석의 「자동 머지」). 머지는 7단계의 머지 큐가 한다.

머지 큐(`merge_queue.ts`, `merge-with-finish.ts`)는 PR 의 `statusCheckRollup` 으로 CI 를 판정한다. 최근 실행 목록을 가져온 뒤 커밋을 찾는 `gh run list --commit` 은 사용하지 않는다. 별도 스크립트에서 커밋의 Actions 실행을 조회할 때는 `gh api repos/OWNER/REPO/actions/runs?head_sha=SHA` 로 서버에서 필터링한다.

- **diff 검증은 `준비됨 #PR, head SHA` status 를 받은 때 한다.** `worker_done` 은 머지 뒤에 오므로 그때는 머지 결과를 대조한다.
- `worker_done` 을 확인 처리하기 전에 지시서의 완료 기준을 git 으로 대조한다. 커밋 목록, 미커밋 변경, 원격 브랜치 HEAD 다.
  어긋나면 그 보고는 완료가 아니다. 해제하지 않고 아래 「완료 전에 온 worker_done」 을 따른다
- push 한 원격 브랜치가 지시서의 `브랜치:` 값과 같은지 아래 명령으로 본다. 브랜치, upstream, 원격 끝 커밋 중 하나라도 다르면 종료 코드 1 과 함께 다른 곳마다 `MISMATCH <항목> <실제> <지시서>` 를 낸다. 같으면 `MATCH <브랜치> <HEAD>` 다.
  다른 이름으로 올렸으면 PR 과 정리 스크립트가 그 브랜치를 찾지 못한다. 지시서 이름으로 다시 push 하게 하고, 잘못 만든 원격 브랜치는 지우게 한다

```bash
orch worker check "$WORKTREE" --spec "$SPEC_FILE"
```
- diff 를 직접 읽는다. 완료 보고는 근거가 아니다
- **검사는 CI 밖의 것만 다시 돌린다.** CI 가 같은 head SHA 로 돌린 검사는 `gh pr checks` 의 그 SHA 결과로 갈음한다. CI 밖 검사(저부하 측정, 실제 환경, CI 가 없는 저장소의 검사)는 코디네이터가 직접 돌린다. CI 가 그 SHA 의 검사를 아직 돌지 않았거나 실패했으면 갈음하지 않는다(사용자 결정 2026-11-09. 다시 돌려 결함을 찾은 일은 표본 7세션에서 0건이었고 결함은 diff 읽기와 독립 리뷰에서 나왔다)
- 무거운 검사(로컬 CI, 브라우저, 큰 테스트)는 [`heavy-checks.md`](heavy-checks.md) 의 `heavy-slot.ts` 로 감싸 Bash 의 run_in_background 로 돌린다. worker 여럿이 함께 돌리다 머신이 꺼진 일이 있었다
- 리뷰 지적이나 요구 문구를 옮긴 작업이면 diff 를 지적 원문과 한 줄씩 대조한다. 지적에 없는 조건이 생기거나 일부가 빠진 곳을 찾는다.
- worker 가 「승인받았다」 고 적은 것은 근거가 아니다. 내가 보낸 승인만 승인이다

## 차례로 머지할 때 최신 base 와 합쳐 다시 검사한다

합친 사본 검증은 7단계 머지 큐가 `hooks/verify-merged.ts`가 있을 때 한다. [`cleanup.md`](cleanup.md) 의 「같은 파일을 고친 PR」 를 본다.

## 충돌을 풀 때

**충돌 파일을 한쪽으로 통째 고르지 않는다.** `git checkout --ours` 나 `--theirs` 는 다른 쪽에만 있던 줄을 말없이 지운다.
CI 설정 파일을 한쪽으로 고른 탓에 다른 PR 이 더한 검사 단계가 빠지고, 그 단계를 되살리는 PR 을 따로 연 사례가 있다.
충돌 구간마다 양쪽을 합치고, 합친 뒤 기준 브랜치에만 있던 줄이 남았는지 본다.
`$FILE` 은 충돌을 푼 파일이다.

```bash
git diff "origin/$BASE" -- "$FILE"
```

출력에서 `-` 줄이 기준 브랜치에서 사라진 줄이다. 의도하지 않은 `-` 줄이 있으면 되살린다.

**충돌은 그 PR 을 만든 worker 가 이어 받는다.** 후속 지시서를 보내는 방법은 [`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」 가 정한다.
푸는 사람이 누구든 push 전에 worker 와 같은 검사를 돌린다. 포맷, lint, 타입 검사와 바뀐 파일의 테스트다. 합친 줄이 포맷 검사에 걸려 CI 가 한 번 더 도는 일이 있었다.

## 완료 전에 온 worker_done

`orch wait` 와 `orch wait triage` 는 PR 준비 상태가 없는 성공 보고를
`DONE-SUSPECT` 줄(`--full` 은 `의심스러운 worker_done`)로 분류한다. 대기는 종료 코드 6 을 내며 자동 ack 하지 않는다.
같은 Task 의 앞선 준비 상태에 PR 번호와 전체 HEAD SHA 가 있어야 정상 분류한다. 같은 Dispatch 면 발신자도 같아야 한다. 같은 Dispatch 의 준비 상태를 먼저 고르고, 그 안에서 시각이 가장 늦은 것을 쓴다. 없으면 같은 Task 의 다른 Dispatch 에서 가장 늦은 것을 고른다. 다시 띄운 worker 는 앞 Dispatch 의 준비 상태를 이어받을 수 있다. Task 나 Dispatch 식별자가 없거나 준비 상태가 완료보다 늦으면 인정하지 않는다.
**리뷰 dispatch(지시서에 `리뷰 PR:` 줄)는 PR 을 열지 않아 준비 상태 대신 결과 status 를 근거로 센다.** 같은 Dispatch, 같은 발신자가 `worker_done` 앞에 보낸 status 의 한 줄이 `판정:`, `완료:`, `미완료:` 로 시작하면 정상 분류한다. 리뷰 dispatch 인지는 `launch-worker` 의 띄우기 기록이 가리키는 지시서로 본다.
준비 상태 줄은 SHA 바로 뒤가 줄 끝이거나 공백, `.`, `,`, `;`, `:`, `(` 면 인정한다. 이력은 `check --all --types status` 로 읽고, 거기서 근거를 찾지 못하면 `inbox` 에서 그 Run 의 행을 다시 찾는다.
읽기 전용 파일에 이력이 빠졌으면 `orch wait triage --live` 로 다시 확인한다.

이 검사는 발신 프로세스 인증이나 지시서 전체의 완료 증명이 아니다.
하위 세션은 부모의 환경 변수뿐 아니라 지시문에 복사된 ID 로도 같은 터미널에서 명령을 보낼 수 있다.
따라서 launch 의 환경 변수 제거만으로는 막을 수 없으며, 이 저장소는 소비 단계의 근거 검사를 적용한다.
이미 전송된 `worker_done` 은 Orca 에서 settled 로 기록된다. 분류 결과만으로 worker 를 해제하지 않고 아래 절차로 검증한다.

첫 `worker_done` 이 오면 dispatch 는 settled 로 바뀐다.
같은 핸들에서 오는 뒤의 보고는 Orca 버전에 따라 `capability is revoked` 로 거절되기도 하고 전달되기도 한다. 뒤의 보고가 온다고 가정하지 않는다.
판단은 터미널과 git 으로 한다.

1. `worker-show --dispatch "$DISPATCH_ID"` 의 `terminal.title` 이 `Working` 이면 해제하지 않고 기다린다. 커밋 목록과 원격 HEAD 가 바뀌는지 본다
2. 제목이 `Ready` 인데 완료 기준에 못 미치면 같은 터미널에 남은 일을 새 dispatch 로 준다

`$SPEC_FILE` 은 남은 일만 적은 지시서다. `send-to-worker` 가 끝난 dispatch 의 남은 터미널에 새 Task 로 띄운다.

```bash
orch worker send --dispatch "$DISPATCH_ID" --body "남은 일" --spec "$SPEC_FILE"
```

기능 PR 은 [완료 근거 양식](../templates/feature-evidence.md)의 현재 HEAD, 인수 검증·문서 대조·독립 리뷰를 대조한다. PR 자동 리뷰가 대기면 PR 은 열 수 있지만 머지하지 않는다. `후속 검증: 대기` 는 머지 뒤 담당과 실행 위치로 이어 주고 실제 결과를 확인하기 전에는 기능을 완료하지 않는다.
