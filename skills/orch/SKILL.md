---
name: orch
description: |
  Orca orchestration 으로 worker 를 띄워 PR 머지와 정리까지 끝내는 코디네이터 절차다.
  "/orch", "worker 띄워", "worker 로 맡겨", "병렬로 맡겨", "코디네이터", "머지 큐",
  "worker_done 확인", "PR 머지하고 정리" 같은 요청이면 이 스킬을 쓴다.
  다른 저장소의 파일을 고치고 커밋해야 할 때도 이 스킬로 worker 에게 맡긴다.
  orca 명령 문법과 lifecycle 은 Orca 의 `orchestration` 스킬이 소유한다.
metadata:
  version: "7.51.2"
---

# orch

**목표: worker 가 보고한 완료가 실제로 끝난 작업이고, 머지한 뒤 워크트리, 브랜치, 대기 프로세스가 남지 않는다.**

입력은 사용자가 맡긴 일(요청, 스펙 경로, 열린 PR)이다. 사용자가 할 다음 행동은 정할 것에 답하는 일(배경과 권장안을 붙여 올린 질문)과 사람만 할 수 있는 일(승인, 접속)뿐이다. 그 밖에는 코디네이터가 머지와 정리까지 끝낸다.

명령 문법과 lifecycle 은 Orca 의 `orchestration` 가이드(`orca skills get orchestration`)가 소유한다.
이 스킬은 그 가이드에 없는 코디네이터의 판단과, 각 단계에서 같은 실패를 피하는 규칙을 담는다.
`$SKILL_DIR` 은 이 스킬 번들 경로다.
스크립트는 `orch <묶음> <동작> [인자]` 로 부른다. 묶음과 동작은 `orch --help` 가 보이고, 원본은 명령 표 `scripts/lib/commands.ts` 다.
저장소(`--repo`), Run(`--run`), 지시서 폴더(`--specs-dir`), 대기의 루프 저장소(`--loop-repo`)는 주지 않으면 작업 폴더와 코디네이터 터미널에서 읽는다. 다른 저장소나 다른 Run 이면 그 값을 준다.
설정을 보고 바꾸는 명령은 `orch config show`, `orch config get`, `orch config set`, `orch config unset` 이다. 코디네이터가 [`references/overlay.md`](references/overlay.md) 의 「설정 바꾸기」 를 따른다.
기본 출력은 판정 줄(대문자 낱말로 시작하는 줄)과 결과 데이터다. 설명과 진행 줄은 `--full` 로 본다. 명령마다의 줄은 각 스크립트 머리 주석의 「짧은 출력」 이 소유한다. 루프, worker, 보드는 `orch status` 로 한 번에 본다.
`orch` 는 부를 때마다 설치 기록의 지금 설치된 번들을 골라 실행하므로, 갱신이나 프로필 전환 뒤에도 옛 번들을 부르지 않는다. PATH 에 없는 셸(Codex, 사람 셸)은 아래 첫 점검의 셸 함수를 쓰고, `orch doctor install-cli` 를 한 번 돌리면 `~/.local/bin/orch` 가 생긴다.
<!-- orch-compat -->
옛 꼴 `"$SKILL_DIR/bin/orch.ts" <스크립트 이름> [인자]` 도 같은 스크립트를 같은 인자로 부르고 stderr 에 새 꼴을 안내한다. 옛 이름을 지우는 PR 까지 받는다. 저장소 스크립트가 orch 를 부르는 방법은 [`references/overlay.md`](references/overlay.md) 의 「저장소 스크립트에서 orch 부르기」 가 소유한다.
캐시의 스크립트를 직접 불러 현재 설치 기록과 다르면 stderr 에 `STALE-BUNDLE` 경고와 현재 진입점 경로가 나온다.
**`orca orchestration` 조회를 직접 부를 때는 `--full` 을 붙인다.** `--full` 이 없으면 줄인 보기라 `dispatchStatus`, `resource`, `thread_id` 처럼 판정에 쓰는 키가 빠진다. 스크립트는 스스로 붙인다(`scripts/lib/orca.ts` 의 `withFull`).

스킬을 열면 먼저 설치본을 점검한다. 비교 방법은 `orch-doctor.ts` 머리 주석이 소유한다. `STALE` 이면 출력의 갱신 명령을 사용자에게 보인다. `SKIP-VERSION` 은 원본을 비교하지 못했다는 알림이라 그대로 진행한다.
`MISSING` 이면 문서가 부르는 스크립트가 설치본에 없다는 뜻이라, 그 단계를 건너뛰지 않고 갱신한 뒤에도 없으면 사용자에게 알린다.
`NODE-TOO-OLD` 면 이 스킬의 명령이 돌지 않는다. node 24 이상을 PATH 에 둔 뒤 다시 점검한다.
`UNKNOWN-HOOK` 은 작업 디렉터리 저장소의 핸들러 경고라 진행을 막지 않는다. `INVALID-CONFIG <경로> <이유>` 는 `config.json` 의 그 경로에 고칠 곳이 있다는 뜻이다. 이유별 조치는 [`references/hooks.md`](references/hooks.md) 의 줄 표가 소유한다.
`FEEDBACK-OPEN <개수> <폴더>` 는 다시 보지 않은 스킬 개선 후보가 있다는 뜻이다. 그날 안에 [`references/feedback-review.md`](references/feedback-review.md) 대로 판정한다.
`STUDY-OPEN <개수> <폴더>` 는 글로 쓰지도 빼지도 않은 공부 후보가 있다는 뜻이다. 「고를 공부 후보 <개수>개가 <폴더> 에 있다」 로 알리기만 하고 고르라고 재촉하지 않는다.
사용자 질문이나 결정에서 일반 기술 개념이 판단을 바꿨으면(뜻을 물은 경우 포함) 그 자리에서 공부 후보로 적는다. 아무 주제나 적지 않고 네 기준을 모두 채운 것만 적는다. 기준, 적는 법, 사용자가 고른 후보를 글로 잇는 법은 [`references/study-candidates.md`](references/study-candidates.md) 를 따른다.
`PLUGIN-PATH-MISSING <플러그인> <scope> <경로>` 는 설치 기록이 가리키는 폴더가 없어 그 플러그인이 로드되지 않았다는 뜻이다. 이 스킬이 로드됐어도 다른 플러그인의 스킬과 명령이 빠져 있을 수 있으니 다음 줄들의 안내를 사용자에게 보인다. doctor 는 설치 기록을 고치지 않는다.
`ORCA-SHAPE worker-list <키>` 는 Orca 출력 형식이 바뀌어 orch 가 읽는 키가 없다는 뜻이다. worker 판정과 정리가 빈 값으로 엇나가므로 orch 를 갱신하고, 최신에도 나오면 사용자에게 알린다.

```bash
command -v orch >/dev/null || orch() { node "$SKILL_DIR/../../bin/orch" "$@"; }
orch doctor
```

셸 함수는 그 Bash 호출 안에서만 살아, 다른 문서의 `orch` 명령도 같은 셸에서는 이 줄을 먼저 둔다.
`CLI-MISSING`, `CLI-STALE` 이면 다음 줄의 `orch doctor install-cli` 를 한 번 돌린다. `CLI-CONFLICT`(다른 `orch` 가 있어 덮지 않았다)와 `CLI-NOT-ON-PATH` 는 사용자에게 알린다.
`OLD-CALL`, `DIRECT-PATH` 는 그 저장소의 오버레이·공통 지시서·핸들러가 옛 꼴로 orch 를 부른다는 뜻이다. 진행을 막지 않으니 다음 줄의 새 꼴로 그 저장소 worker 에게 고치게 한다.
`LOOP-STALE` 이면 다음 줄의 명령으로 다시 시작한다. `WAITER-LEFT` 는 옛 대기 종료 안내를 따른다.

새 세션을 시작하거나 압축·계정 전환 뒤에는 `orch worker adopt` 로 이전 세션에서 떨어진 터미널을 확인한다. 저장소는 작업 폴더에서 읽고, 다른 저장소면 `--repo` 를 준다. 목록을 검토한 뒤 이어받을 때만 `--apply` 를 쓴다. 상세는 [`references/launch.md`](references/launch.md) 의 「이전 세션 이어받기」 를 따른다.

## 기능 단위 개발

기능 요청 또는 스펙을 받으면 [기능 단위 개발 루프](references/feature-loop.md)를 읽고 단계를 조율한다.
제품 결정은 spec, 구조와 책임은 technical-design, 작업 분해는 plan, 구현은 implementation, 독립 검증은 verify, 후보 추출은 docs-consolidate 가 맡는다.
기존 worker·머지 큐를 사용한다. 이 스킬은 각 단계의 내용을 다시 소유하지 않는다.

## 언제 쓰나

| 상황 | 방식 |
| --- | --- |
| 현재 세션이 연 저장소가 아닌 곳의 파일을 고치고 커밋, 푸시해야 한다 | 이 스킬로 worker 를 띄운다 |
| 다른 저장소를 조회하거나 로그를 보거나 이미 있는 스크립트를 실행한다 | 현재 세션에서 직접 한다 |
| 현재 저장소 안의 독립적이고 큰 작업이다(구현, PR, 머지까지 가는 일) | 이 스킬로 worker 를 띄운다 |
| 결과만 받으면 되는 짧은 조사, 판정, 리뷰 | 하위 에이전트를 쓴다 |
| 구현한 제공자와 다른 제공자의 리뷰가 필요하다(예: Claude 가 만든 PR 의 Codex 리뷰) | 리뷰 worker 로 띄운다. 하위 에이전트는 코디네이터와 같은 제공자다. 지시서는 [`templates/spec-review.md`](templates/spec-review.md) 로 쓴다 |
| 사용자가 감독 없이 작업을 통째로 넘기라고 했다 | `orca-cli` 로 handoff 한다 |

현재 저장소의 큰 작업도 worker 로 띄운다. 사용자가 Orca 화면에서 어느 worker 가 어느 워크트리에서 무엇을 하는지 보고, 중간에 직접 끼어들 수 있어야 한다.
저장소마다 변경이 독립된 검토 단위로 남아야 한다. 한 세션이 여러 저장소의 브랜치를 쥐면 어느 변경이 어디에 얹혔는지 추적하기 어렵다.

## 원칙

- **사용자 요청을 바로 worker 에게 넘기지 않는다.** 코드와 운영 상태로 사실을 먼저 확인하고, 사용자가 정할 것은 배경과 권장안을 붙여 묻고 나서 맡긴다.
  요청 문장 그대로 넘기면 worker 가 사실과 다른 전제로 구현하거나, 사용자가 정해야 할 것을 worker 가 대신 정한다
- **사용자가 정할 질문은 코디네이터가 대신 답하지 않는다.** 권장안을 붙여 사용자에게 올리고 고른 답을 worker 에게 보낸다. 형식과 검사 규칙은 저장소의 `../../docs/data-schema.md` 「사용자 결정 질문 형식」 이 소유한다
- **worker 는 모두 코디네이터가 띄운다.** worker 는 다시 worker 를 띄우지 못한다(`nested_worker_depth_exceeded`).
  일을 나눠야 하면 worker 에게는 계획서와 worktree 준비까지만 맡기고, 소계획마다 `ready: <plan> <worktree 절대경로> <지시서 절대경로>` status 를 받아 코디네이터가 띄운다
- **worker 는 PR 이 머지될 때까지 맡는다.** 준비됨 뒤에도 CI 실패, 충돌, 기준 브랜치 변경을 worker 가 직접 처리하고 `worker_done` 은 MERGED 뒤에 보낸다. 지시서 하나의 완료 기준은 PR 하나의 MERGED 다. 계획이 PR 여럿이면 지시서는 PR1 만 맡고, 앞 PR 이 머지되면 코디네이터가 다음 지시서를 써 새 worker 를 띄운다(worker 하나가 PR 여럿을 이어 맡지 않는다)
- **PR 생성은 사용자가 미리 허락한 경우에만 worker 에게 맡긴다.** 허락받지 않았으면 worker 는 push 까지만 하고, 코디네이터가 확인받은 뒤 PR 을 연다. 머지는 worker 에게 맡기지 않는다
- **기능 루프를 쓸지는 지시서를 쓰기 전에 정하고 `## 할 일` 아래 첫 줄에 적는다.** 새 동작, 새 계약, 여러 PR 이면 루프를 쓰고, 버그 수정·정리·설정·측정 같은 작은 일은 쓰지 않는다. 첫 줄의 꼴이 틀리거나 가리킨 스펙이 확인받지 않은 것이면 `launch-worker` 가 띄우지 않는다. 기준과 꼴은 [`references/feature-loop.md`](references/feature-loop.md) 의 「루프를 쓸지 정한다」 가 소유한다
- **worker 의 spec 인터뷰는 코디네이터가 사용자에게 중계한다.** 결정 블록을 나눠 묻고 답을 모아 돌려주며, 스펙 확인도 사용자에게 받는다. 절차는 [`references/replying.md`](references/replying.md) 의 「spec 인터뷰를 중계한다」 가 소유한다
- **사용자 확인을 받을 때는 채팅 질문보다 먼저 보드 승인 대기를 올린다.** 외부 게시(`post`), 스펙 확인(`spec`), `[ask]` 단계(`step`), real 쓰기(`real`), 사용자가 칠 명령(`command`)은 `orch board approval add` 로 승인 대기를 올리고 채팅에도 한 줄 알린다. 종류별 값과 신호 처리는 [`references/replying.md`](references/replying.md) 의 「보드 승인」 이 소유한다. 선택지가 여럿인 결정은 버튼 종류가 없으므로 승인으로 올리지 않고 지금처럼 채팅 질문으로 묻는다
- **worker 보고서의 사용자 안내(누를 단추, 순서, 화면 문구)는 코드나 화면으로 확인한 뒤 사용자에게 전한다.** 계획한 화면과 실제 화면이 다를 수 있다
- **auto mode 분류기가 코디네이터의 머지나 배포를 막으면 우회 스크립트를 새로 쓰지 않는다.** 돌릴 명령을 보여 주고 사용자가 직접 실행하게 한다. 우회 스크립트는 다시 거부되기 쉽다
- **「따로 맡기겠다」 고 말한 일은 그 자리에서 맡기거나 할 일로 남긴다.** 말로만 미룬 일은 다음 요청에 묻혀 빠진다
- **코디네이터가 겪은 스킬 개선 후보도 겪은 자리에서 `orch feedback add` 로 적는다.** 형식과 세 기준은 worker 와 같고, [`references/feedback-review.md`](references/feedback-review.md) 의 「후보 파일」 이 소유한다. 대화에만 두면 압축될 때 사라진다

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
| 1 | 에이전트 고르기 | 에이전트, 모델, effort, 모델 표의 행 id 와 비교한 후보, 고른 이유가 지시서의 `worker 선택:` 줄에 있다 | [`references/agent-selection.md`](references/agent-selection.md) |
| 2 | 지시서 쓰기 | 지시 본문이 파일에 있고 `--spec` 에는 그 경로만 있다. 이번에 띄울 지시서를 넘긴 `spec-lint` 가 0 으로 끝났다(`launch-worker` 도 띄우기 전에 한 번 더 돌려 막는다) | [`references/spec-writing.md`](references/spec-writing.md), [`templates/spec-common.md`](templates/spec-common.md) |
| 3 | 띄우기 | `orch worker launch` 가 종료 코드 0 과 `LAUNCHED` 줄로 끝났고, `LAUNCH-EFFECTIVE` 줄(`launch.effective`)이 고른 값과 같고, 대상 저장소 `git status` 에 `worktrees/` 가 없다 | [`references/launch.md`](references/launch.md) |
| 4 | 기다리기 | 저장소별 루프가 살아 있고 Run 이 등록돼 있다. 메시지는 Orca 가 깨우며 별도 대기를 걸지 않는다 | [`references/waiting.md`](references/waiting.md) |
| 5 | 답하고 지시 보내기 | 답과 지시를 `send-to-worker` 로 보냈고 종료 코드가 0 이며, 그 답이 검사를 무력화하지 않는다 | [`references/replying.md`](references/replying.md) |
| 6 | 완료 검증 | diff 를 직접 읽었고, CI 가 같은 head SHA 로 돌린 검사는 CI 결과로 확인했고 CI 밖 검사는 다시 돌려 통과했다 | [`references/verification.md`](references/verification.md) |
| 7 | 머지와 정리 | `orch queue merge` 가 건 머지 큐가 `QUEUE-DONE` 으로 끝났고, PR 마다 마무리 출력의 마지막 줄이 `FINISH-DONE` 이다. 끝난 dispatch, 워크트리, 머지된 로컬 브랜치, 그 작업만의 문서가 없다 | [`references/cleanup.md`](references/cleanup.md), [`references/board.md`](references/board.md) |

진행 보드가 있으면 띄우기와 루프가 항목, PR 연결, 머지를 자동 반영한다. 코디네이터는 결정과 다음 단계를 관리한다([보드 갱신 담당](references/board.md)). 보드가 없으면 건너뛴다.

## 1. 에이전트 고르기

Task 성격으로 모델과 effort 를 고르고, 모델 표의 행 id 와 비교한 후보, 이유를 지시서의 `worker 선택:` 줄에 남긴다. `spec-lint` 와 `launch-worker` 가 이 줄을 검사한다. 행 id 는 모델 표와, high 근거는 저장소의 띄우기 이력과 대조한다. 선택 표와 Codex 에 넘기는 방법은 reference 가 소유한다.

## 2. 지시서 쓰기

저장소마다 공통 지시서를 한 번 만들고, 개별 지시서는 담당 범위와 완료 기준만 적는다.
넣을 항목과 그 이유는 reference 가 소유한다. `--spec` 에 들어갈 한 줄은 [`references/launch.md`](references/launch.md) 가 소유한다.

## 3. 띄우기

원격을 갱신한 뒤 `launch-worker` 로 띄운다. 거부 조건과 워크트리 만들기는 `launch-worker.ts` 머리 주석이 소유한다.
새로 띄우기는 `launch-worker`, 후속 지시는 `send-to-worker` 로 한다. 같은 Task 를 다시 띄울 때도 `launch-worker` 를 쓰고, 실패한 Task 는 `--retry-of <dispatch>` 를 함께 준다.
띄운 직후 reference 의 「띄운 직후 확인」 을 본다.
`STALLED-START` 와 종료 코드 1 이면 자동 abandon·재시도 없이 코디네이터가 화면을 확인하고 다시 띄울지 사용자에게 묻는다. 첫 화면에서 멈추거나 시작 직후 실패하면 reference 의 해당 절을 따른다.

## 4. 기다리기

저장소마다 `orch loop start` 로 루프를 등록한 뒤 턴을 끝낸다. worker 질문·보고와 루프 알림은 Orca 가 코디네이터를 깨운다. 깨어났을 때의 처리와 옛 대기 정리는 [`references/waiting.md`](references/waiting.md)를 따른다.
사용자와 대화 중이면 사용자 답을 먼저 한다. decision-pending 은 남은 결정을 사용자에게 묻도록 요청하고, 이미 답을 기다리는 결정은 다시 묻지 않는다.
압축 뒤에는 `orch status` 와 doctor 로 루프 생존을 확인하고 꺼진 것만 다시 시작한다.

### gh 호출 예산

자동 조회로 GitHub 서버에 주는 부하를 줄이기 위해 같은 읽기 조회는 프로세스 사이에서 캐시를 공유한다.
코디네이터가 직접 CI 를 기다릴 때는 `gh pr checks --watch --interval 60` 이상을 쓴다.
TTL, 기록 위치, 호출 수 확인 명령은 [`references/gh-call-budget.md`](references/gh-call-budget.md) 를 따른다.

## 5. 답하고 지시 보내기

답과 지시는 `send-to-worker` 로 보낸다(분기와 종료 코드는 그 스크립트 머리 주석이 소유한다). worker 터미널에 `orca terminal send` 로 직접 쓰지 않는다.
충돌과 리뷰 반영은 그 PR 을 만든 worker 가 이어 받고, 종료 코드 3 이면 새 worker 를 띄우지 않고 사용자에게 알린다. PR 생성과 회신이 막힌 worker 는 reference 의 해당 절을 따른다.

## 6. 완료 검증

여러 worker 가 같은 PC 에서 무거운 검사를 실행하면 [`references/heavy-checks.md`](references/heavy-checks.md)의 대기열로 감싼다.

`worker_done` 은 근거가 아니다. git 으로 완료 기준을 대조하고, diff 를 읽고, CI 밖 검사만 다시 돌린다. CI 가 같은 head SHA 로 돌린 검사는 그 결과로 대신한다.
충돌은 그 PR 을 만든 worker 가 풀고, 푸는 규칙은 reference 의 「충돌을 풀 때」 를 따른다.

## 7. 머지와 정리

`orch queue merge` 로 머지 큐를 걸면 PR 마다 머지 뒤 마무리(worker 정리, 배포 확인, 업무 완료, 보드 done)가 함께 돈다. 사용자가 말하지 않아도 이 스크립트로 건다. `queue.auto_merge` 를 켠 저장소는 상주 루프가 머지할 수 있는 PR 을 스스로 건다(`references/cleanup.md` 의 「머지」).
앞 PR 머지마다 뒤 PR 을 최신화하느라 CI 를 다시 기다리는 저장소는 `--up-to-date-when overlap` 으로 겹치지 않는 PR 의 최신화를 생략한다. 쓸 수 있는 저장소와 규칙은 `references/cleanup.md` 의 「겹치지 않는 PR 은 최신화하지 않기」 가 소유한다.
그래도 겹치는 PR 이 차례마다 CI 를 기다리면 `pipeline.refresh_slots` 로 상주 루프가 뒤처진 PR 을 머지 차례 전에 최신화하게 한다(`references/cleanup.md` 의 「머지 차례 전에 미리 최신화하기」).
머지 큐가 끝나면 `orch queue conflicts` 로 충돌한 열린 PR 의 worker 에게 알린다. 업무의 마지막 PR 인지는 마무리가 배포 뒤에 판정하므로 PR 마다 `!` 를 정하지 않는다. 판정을 덮을 때만 `!`(마지막)나 `~`(중간)를 붙인다. 워크트리는 `orch cleanup worktree` 로만 지운다. 끝난 handoff 산출물은 묻지 않고 `orch cleanup handoff --apply` 로 휴지통 폴더에 옮긴다.
뒤 PR 이 남았으면 머지한 뒤 같은 흐름에서 그 지시서를 써 새 worker 를 띄운다. 절차는 `references/cleanup.md` 의 「정리」 절에 있는 「다음 PR 은 새 worker 로 띄운다」 문단이 소유한다.
맡긴 작업은 다른 저장소의 것이어도 머지한 자리에서 정리하고, 다른 세션이 띄운 것은 건드리지 않는다. 원칙과 직접 머지했을 때의 명령은 `references/cleanup.md` 의 「정리」 가 소유한다.
