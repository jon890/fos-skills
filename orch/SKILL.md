---
name: orch
description: |
  Orca orchestration 으로 worker 를 띄워 PR 머지와 정리까지 끝내는 코디네이터 절차다.
  에이전트와 모델 고르기, 지시서, 띄우기, 기다리기, 답하기, 완료 검증, 머지와 정리를 다룬다.
  "/orch", "worker 띄워", "worker 로 맡겨", "병렬로 맡겨", "코디네이터", "머지 큐",
  "worker_done 확인", "PR 머지하고 정리" 같은 요청이면 이 스킬을 쓴다.
  다른 저장소의 파일을 고치고 커밋해야 할 때도 이 스킬로 worker 에게 맡긴다.
  orca 명령 문법과 lifecycle 은 Orca 의 `orchestration` 스킬이 소유한다.
metadata:
  version: "4.20.0"
---

# orch

**목표: worker 가 보고한 완료가 실제로 끝난 작업이고, 머지한 뒤 워크트리, 브랜치, 대기 프로세스가 남지 않는다.**

명령 문법과 lifecycle 은 Orca 의 `orchestration` 가이드(`orca skills get orchestration`)가 소유한다.
이 스킬은 그 가이드에 없는 코디네이터의 판단과, 각 단계에서 같은 실패를 피하는 규칙을 담는다.
`$SKILL_DIR` 은 이 스킬 번들 경로다.

스킬을 열면 먼저 설치본을 점검한다. `STALE` 이면 출력의 갱신 명령 두 줄을 사용자에게 보인다.
`MISSING` 이면 문서가 부르는 스크립트가 설치본에 없다는 뜻이라, 그 단계를 건너뛰지 않고 갱신한 뒤에도 없으면 사용자에게 알린다. `SKIP-VERSION` 은 그대로 진행한다.
`NODE-TOO-OLD` 면 이 스킬의 명령이 돌지 않는다. node 24 이상을 PATH 에 둔 뒤 다시 점검한다.
`UNKNOWN-HOOK`, `DEPRECATED-CONFIG` 는 작업 디렉터리 저장소의 핸들러와 설정 경고라 진행을 막지 않는다. 고치는 법은 [`references/hooks.md`](references/hooks.md) 가 소유한다.
`PLUGIN-PATH-MISSING <플러그인> <scope> <경로>` 는 설치 기록(`installed_plugins.json`)이 가리키는 폴더가 없어 그 플러그인이 실리지 않았다는 뜻이다. 이 스킬이 실렸어도 다른 플러그인의 스킬과 명령이 빠져 있을 수 있다. 다음 줄들의 안내를 사용자에게 보인다. doctor 는 설치 기록을 고치지 않는다. 설정 폴더가 바뀐 세션에서 옛 폴더 경로가 남은 경우가 대표적이다.
설치본이 옛 커밋이면 문서가 부르는 스크립트가 없어 그 단계를 건너뛰게 된다.

```bash
python3 "$SKILL_DIR/scripts/orch-doctor.py"
```

## 언제 쓰나

| 상황 | 방식 |
| --- | --- |
| 현재 세션이 연 저장소가 아닌 곳의 파일을 고치고 커밋, 푸시해야 한다 | 이 스킬로 worker 를 띄운다 |
| 다른 저장소를 조회하거나 로그를 보거나 이미 있는 스크립트를 실행한다 | 현재 세션에서 직접 한다 |
| 현재 저장소 안의 독립적이고 큰 작업이다(구현, PR, 머지까지 가는 일) | 이 스킬로 worker 를 띄운다 |
| 결과만 받으면 되는 짧은 조사, 판정, 리뷰 | 하위 에이전트를 쓴다 |
| 사용자가 감독 없이 작업을 통째로 넘기라고 했다 | `orca-cli` 로 handoff 한다 |

현재 저장소의 큰 작업도 worker 로 띄운다. 사용자가 Orca 화면에서 어느 worker 가 어느 워크트리에서 무엇을 하는지 보고, 중간에 직접 끼어들 수 있어야 한다.
저장소마다 변경이 독립된 검토 단위로 남아야 한다. 한 세션이 여러 저장소의 브랜치를 쥐면 어느 변경이 어디에 얹혔는지 추적하기 어렵다.

## 원칙

- **사용자 요청을 바로 worker 에게 넘기지 않는다.** 코드와 운영 상태로 사실을 먼저 확인하고, 사용자가 정할 것은 배경과 권장안을 붙여 묻고 나서 맡긴다.
  요청 문장 그대로 넘기면 worker 가 사실과 다른 전제로 구현하거나, 사용자가 정해야 할 것을 worker 가 대신 정한다
- **사용자가 정할 질문은 코디네이터가 대신 답하지 않는다.** 권장안을 붙여 사용자에게 올리고 고른 답을 worker 에게 보낸다. 형식과 검사 규칙은 저장소의 `../docs/data-schema.md` 「사용자 결정 질문 형식」 이 소유한다
- **worker 는 모두 코디네이터가 띄운다.** worker 는 다시 worker 를 띄우지 못한다(`nested_worker_depth_exceeded`).
  일을 나눠야 하면 worker 에게는 계획서와 worktree 준비까지만 맡기고, 소계획마다 `ready: <plan> <worktree 절대경로> <지시서 절대경로>` status 를 받아 코디네이터가 띄운다
- **worker 는 PR 이 머지될 때까지 맡는다.** 준비됨 뒤에도 CI 실패, 충돌, 기준 브랜치 변경을 worker 가 직접 처리하고 `worker_done` 은 MERGED 뒤에 보낸다. 지시서 하나는 PR 하나로 끝나는 크기로 쓴다. 더 큰 일은 나눠 앞 PR 이 머지된 뒤 다음 지시서를 쓴다
- **PR 생성은 사용자가 미리 허락한 경우에만 worker 에게 맡긴다.** 허락받지 않았으면 worker 는 push 까지만 하고, 코디네이터가 확인받은 뒤 PR 을 연다. 머지는 worker 에게 맡기지 않는다
- **범위가 큰 일은 지시서에 「`planning` 으로 설계를 확정한 뒤 `build-with-teams` 로 구현한다」 를 적는다.** 보안 경계, 저장 구조, 여러 화면에 걸친 변경이 여기 해당한다
- **worker 보고서의 사용자 안내(누를 단추, 순서, 화면 문구)는 코드나 화면으로 확인한 뒤 사용자에게 전한다.** 계획한 화면과 실제 화면이 다를 수 있다
- **auto mode 분류기가 코디네이터의 머지나 배포를 막으면 우회 스크립트를 새로 쓰지 않는다.** 돌릴 명령을 보여 주고 사용자가 직접 실행하게 한다. 우회 스크립트는 다시 거부되기 쉽다
- **「따로 맡기겠다」 고 말한 일은 그 자리에서 맡기거나 할 일로 남긴다.** 말로만 미룬 일은 다음 요청에 묻혀 빠진다

## 레포 오버레이

`<repo-root>/.orch/overlay.md` 가 있으면 그 저장소의 worker 를 띄우기 전에 **먼저 읽고** 코어보다 우선한다.
옛 위치(`.claude/orch-overlay.md`, `.claude/orch-finish.json`, `.omc/orch/`, `.omc/handoffs/specs/`)가 남아 있으면 먼저 옮긴다. 방법은 [`references/overlay.md`](references/overlay.md) 의 「옛 구조에서 옮기기」 가 소유한다.
오버레이는 기준 브랜치, 검증 명령, 머지 전 명령, CI runner 장애 대응, 원격 접속 규칙, 마이그레이션 순서를 소유한다.
무엇을 적는지는 [`references/overlay.md`](references/overlay.md) 가 소유한다. 없으면 코어 기본값으로 동작한다.

## 실행 절차

worker 하나마다 1단계부터 7단계를 돈다. 여러 worker 를 동시에 두면 4단계 대기는 run 하나에 하나만 건다.
각 단계는 진입할 때 해당 reference 를 읽고 수행한다. 통과 조건을 확인한 뒤 다음으로 간다.

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 에이전트 고르기 | 에이전트, 모델, effort 와 비교한 후보, 고른 이유가 지시서의 `worker 선택:` 줄에 있다 | [`references/agent-selection.md`](references/agent-selection.md) |
| 2 | 지시서 쓰기 | 지시 본문이 파일에 있고 `--spec` 에는 그 경로만 있다. 이번에 띄울 지시서를 넘긴 `spec-lint` 가 0 으로 끝났다(`launch-worker` 도 띄우기 전에 한 번 더 돌려 막는다) | [`references/spec-writing.md`](references/spec-writing.md), [`templates/spec-common.md`](templates/spec-common.md) |
| 3 | 띄우기 | `launch-worker` 가 종료 코드 0 과 `LAUNCHED` 줄로 끝났고, `launch.effective` 가 고른 값과 같고, 대상 저장소 `git status` 에 `worktrees/` 가 없다 | [`references/launch.md`](references/launch.md) |
| 4 | 기다리기 | 저장소마다 `orch-loop.ts --start` 로 띄운 루프가 살아 있고, 이 세션의 백그라운드 `wait-important` 가 그 저장소들을 `--loop-repo` 로 받아 하나만 돈다. 앞 대기의 `LAST_DELIVERY` id 를 `--ack` 로 넘겼고 받은 delivery 를 `triage-messages` 로 읽었다 | [`references/waiting.md`](references/waiting.md) |
| 5 | 답하고 지시 보내기 | 답과 지시를 `send-to-worker` 로 보냈고 종료 코드가 0 이며, 그 답이 검사를 무력화하지 않는다 | [`references/replying.md`](references/replying.md) |
| 6 | 완료 검증 | diff 를 직접 읽었고 검사를 다시 돌려 통과했다 | [`references/verification.md`](references/verification.md) |
| 7 | 머지와 정리 | `merge-with-finish.ts` 가 건 머지 큐가 `QUEUE-DONE` 으로 끝났고, PR 마다 마무리 출력의 마지막 줄이 `FINISH-DONE` 이다. 끝난 dispatch, 워크트리, 머지된 로컬 브랜치, 그 작업만의 문서가 없다 | [`references/cleanup.md`](references/cleanup.md), [`references/board.md`](references/board.md) |

진행 보드가 있으면 띄우기와 루프가 항목, PR 연결, 머지를 자동 반영한다. 코디네이터는 결정과 다음 단계를 관리한다([보드 갱신 담당](references/board.md)). 보드가 없으면 건너뛴다.

## 1. 에이전트 고르기

Task 성격으로 모델과 effort 를 고르고, 비교한 후보와 이유를 지시서의 `worker 선택:` 줄에 남긴다. `spec-lint` 와 `launch-worker` 가 이 줄을 검사한다. 선택 표와 Codex 에 넘기는 방법은 reference 가 소유한다.

## 2. 지시서 쓰기

저장소마다 공통 지시서를 한 번 만들고, 개별 지시서는 담당 범위와 완료 기준만 적는다.
넣을 항목과 그 이유는 reference 가 소유한다. `--spec` 에 들어갈 한 줄은 [`references/launch.md`](references/launch.md) 가 소유한다.

## 3. 띄우기

원격을 갱신한 뒤 `launch-worker` 로 띄운다. 지시서의 `허락:` 줄을 첫 지시 줄에 붙이고, `worker 선택:` 줄과 `--agent`, `--model` 이 다르면 거부하고, 지시서의 브랜치 이름으로 `origin/<기준 브랜치>` 위에 워크트리를 만들고, 기존 워크트리에 남은 터미널이 있으면 거부한다.
새로 띄우기는 `launch-worker`, 후속 지시는 `send-to-worker` 로 한다. `--task` 로 기존 Task 를 다시 띄우는 호출(`--retry-of` 유무와 관계없이)만 예외로 `worker-start` 를 직접 부른다. `launch-worker` 는 `--spec` 이 필수라 늘 Task 를 새로 만들기 때문이다.
띄운 직후 reference 의 「띄운 직후 확인」 을 본다.
첫 화면에서 멈추거나 시작 직후 실패하면 새로 띄우지 않고 reference 의 해당 절을 따른다.

## 4. 기다리기

저장소마다 상주 루프 `orch-loop.ts` 를 띄운다. 루프가 틱마다 질문 확인, 정리, 보드 동기화, CI 감시, 충돌 PR 처리를 한다.
`wait-important` 를 `--loop-repo` 와 함께 백그라운드로 하나만 걸고, 깨어나면 `triage-messages` 로 `worker_done`, `escalation`, `question` 을 먼저 본다. 루프의 알림(`LOOP-EVENT`)과 죽음(`LOOP-DEAD`)에도 이 대기가 깨어난다.
압축 뒤에는 루프와 대기가 살아 있는지 확인하고 꺼진 것만 다시 띄운다.
heartbeat 만 오는데 커밋과 화면이 그대로면 reference 의 「heartbeat 만 올 때」 를 따른다.

## 5. 답하고 지시 보내기

답과 지시는 `send-to-worker` 로 보낸다. 살아 있는 dispatch 면 마지막 메시지에 `reply` 하고 깨우고, 끝났으면 후속 지시서로 남은 터미널을 이어 쓴다. 그 터미널이 에이전트를 다시 띄우지 못하면 스크립트가 그 터미널을 닫고 같은 워크트리에 새 worker 를 띄우고, 터미널도 없으면 종료 코드 3 이다. worker 터미널에 `orca terminal send` 로 직접 쓰지 않는다.
충돌과 리뷰 반영은 그 PR 을 만든 worker 가 이어 받고, 종료 코드 3 이면 새 worker 를 띄우지 않고 사용자에게 알린다.
PR 생성과 회신이 막힌 worker 는 reference 의 해당 절을 따른다.

## 6. 완료 검증

여러 worker 가 같은 PC 에서 무거운 검사를 실행하면 [`references/heavy-checks.md`](references/heavy-checks.md)의 대기열로 감싼다.

`worker_done` 은 근거가 아니다. git 으로 완료 기준을 대조하고, diff 를 읽고, 검사를 다시 돌린다.
충돌은 그 PR 을 만든 worker 가 풀고, 푸는 규칙은 reference 의 「충돌을 풀 때」 를 따른다.

## 7. 머지와 정리

`merge-with-finish.ts` 로 머지 큐를 걸면 PR 마다 머지 뒤 마무리(worker 정리, 배포 확인, 업무 완료, 보드 done)가 함께 돈다. 사용자가 말하지 않아도 이 스크립트로 건다. `queue.auto_merge` 를 켠 저장소는 상주 루프가 머지할 수 있는 PR 을 스스로 건다(`references/cleanup.md` 의 「머지」).
앞 PR 머지마다 뒤 PR 을 최신화하느라 CI 를 다시 기다리는 저장소는 `--up-to-date-when overlap` 으로 겹치지 않는 PR 의 최신화를 생략한다. 쓸 수 있는 저장소와 규칙은 `references/cleanup.md` 의 「겹치지 않는 PR 은 최신화하지 않기」 가 소유한다.
머지 큐가 끝나면 `notify-conflicts.ts` 로 충돌한 열린 PR 의 worker 에게 알린다. 업무의 마지막 PR 인지는 마무리가 배포 뒤에 판정하므로 PR 마다 `!` 를 정하지 않는다. 판정을 덮을 때만 `!`(마지막)나 `~`(중간)를 붙인다. 워크트리는 `remove-worktree.ts` 로만 지운다. 끝난 handoff 산출물은 묻지 않고 `handoff-cleanup.ts --apply` 로 휴지통 폴더에 옮긴다.
맡긴 작업은 다른 저장소의 것이어도 머지한 자리에서 정리하고, 다른 세션이 띄운 것은 건드리지 않는다. 원칙과 직접 머지했을 때의 명령은 `references/cleanup.md` 의 「정리」 가 소유한다.
