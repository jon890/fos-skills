# Phase 01. orch 문서의 지시 충돌을 지금 동작 기준으로 없앤다

**Execution profile**: standard

## 목표

orch 스킬 문서끼리, 그리고 문서와 스크립트가 서로 다르게 지시하는 곳을 한 문서가 소유하게 고친다.
worker 와 코디네이터가 어느 쪽을 따를지 매번 판단하지 않게 한다.

**범위 외**: 스크립트 동작 변경. 동작이 문서와 다르면 문서를 지금 동작에 맞춘다. 동작을 바꾸는 일은 TypeScript 전환 plan 이 맡는다.

## 컨텍스트

시작 조건: PR #190(`fix/orch-sweep-bound-scope`)이 main 에 머지됐다. 그 PR 이 `orch/references/cleanup.md` 와 `orch/scripts/cleanup-sweep.py` 를 고친다. 머지 전이면 `PHASE_BLOCKED: #190 머지 전` 을 내고 멈춘다.

문서 소유 규칙은 `docs/code-architecture.md` 의 「orch 문서가 소유하는 것」 표가 정한다. 요약하면 SKILL.md 는 단계와 통과 조건, reference 는 언제 어떤 옵션을 쓰는가, 스크립트 머리 주석은 동작과 옵션과 종료 코드를 소유한다.
스킬 문서를 고치기 전에 `~/.claude/references/skill-structure.md` 와 `~/.claude/references/skill-sync.md` 를 읽는다. 없는 환경이면 이 저장소의 `harness-cleanup/` 기준을 따른다.

**근거 문서**: `docs/code-architecture.md` 의 「orch 코어와 핸들러」 절 가운데 「사용자 결정 (2026-10-24)」 과 「orch 문서가 소유하는 것」, `docs/adr/009-orch-event-handlers.md`

## 의도 메모

- 줄 번호는 #190 머지로 밀릴 수 있다. 아래 표의 「찾을 문구」 로 위치를 찾는다.
- 한쪽을 지울 때 다른 쪽이 그 내용을 이미 가졌는지 먼저 확인한다. 둘 다 지우면 지시가 사라진다.

## 작업 항목

### 1. 아래 충돌을 표의 해소 방법대로 고친다

| 위치 | 찾을 문구 | 해소 |
| --- | --- | --- |
| `orch/references/spec-writing.md` 「넣을 것」, `orch/scripts/launch-worker.py` | `허락:` 줄을 PR 을 열게 할 때만 적는다는 문장 | 스크립트가 늘 요구하므로 문서도 필수로 적는다. 허락이 없으면 `허락: 없음. push 까지만 한다.` 를 적게 한다 |
| `orch/SKILL.md` 2단계, `spec-writing.md` 첫 절, `launch.md` | `--spec` 에 들어갈 내용 | `spec-line.py` 가 만든다는 한 문장만 `launch.md` 에 두고, 나머지 두 곳은 그 절을 가리킨다 |
| `SKILL.md` 6단계, `verification.md` | 무거운 검사를 heavy-slot 으로 / mem-gate 로 감싸라 | `heavy-slot.py` 하나로 맞춘다. 그 스크립트가 자리를 잡은 뒤 mem-gate 를 부른다는 사실은 `heavy-checks.md` 가 소유한다 |
| `launch.md` | 워크트리를 따로 만든다 / launch-worker 가 한 번에 만든다 | `launch-worker.py` 가 만든다로 맞추고, `make-worktree.py` 는 원격 PR 브랜치를 이어 받을 때만 쓴다고 적는다 |
| `spec-writing.md` 머지 순서, `templates/spec-common.md` | 머지 순서를 지시서에 적어라 / PR 분할과 순서는 worker 가 정한다 | PR 분할은 worker 판단, 머지 순서는 코디네이터가 정해 지시서에 적는다로 나눈다 |
| `spec-writing.md`, `templates/spec-common.md` | 공통 지시서에 `{{RUN_ID}}` 를 채운다 | 공통 지시서에서 `{{RUN_ID}}` 를 뺀다. Run id 는 개별 지시서나 launch 가 넘긴다 |
| `templates/spec-common.md` | `**PR 생성은 승인돼 있다.**` | 「PR 생성은 지시서의 `허락:` 줄이 허락한 경우에만 한다. 허락이 없으면 push 까지만 하고 status 로 알린다」 로 바꾼다. `SKILL.md` 원칙과 맞춘다 |
| `SKILL.md` 6단계 통과 조건, `verification.md` | 합친 사본 검증 | 6단계 통과 조건에서 빼고 「7단계 머지 큐가 `queue.verify_merged` 가 있을 때 한다」 로 `cleanup.md` 가 소유한다 |
| `SKILL.md` 5단계, `launch.md` 「끊긴 worker 다시 띄우기」 | 끝난 dispatch 터미널을 이어 쓴다 / 닫고 새로 띄운다 | `send-to-worker.py` 의 동작으로 맞춘다. 끝난 dispatch 의 터미널이 남았으면 후속 지시서로 이어 쓰고, 에이전트를 다시 띄울 수 없으면(종료 코드 3) 그 터미널을 닫고 새로 띄운다. 판정은 그 스크립트 머리 주석이 소유한다 |
| `agent-selection.md` 첫 절, `launch.md` 예시 | 기본값을 두지 않는다 / 예시가 모델과 effort 를 고정한다 | 예시의 값을 `"$MODEL"`, `"$EFFORT"` 변수로 바꾸고 1단계에서 고른 값이라고 적는다 |
| `SKILL.md` 3단계, `waiting.md`, `replying.md` | `worker-start` 를 직접 부르지 않는다 / 직접 부르게 한다 | 직접 부르는 예시를 `launch-worker.py` 나 `send-to-worker.py` 로 바꾼다 |
| `cleanup.md` 「정리」 | 스크립트가 안 하는 일만 직접 한다 / 스크립트가 하는 1~4단계를 다시 시킨다 | 1~4단계 목록을 지우고, 스크립트가 건너뛴 항목을 읽는 법과 5, 6단계(작업 문서, 보드)만 남긴다 |
| `cleanup.md` 「워크트리 지우기」, 「정리」 | squash 머지 워크트리를 사용자에게 알리고 지운다 / 묻지 않고 정리한다 | 묻지 않고 정리한다로 맞춘다. `--merged-head` 가 squash 를 다룬다 |
| `cleanup.md` 「handoff 산출물 정리」, `SKILL.md` 7단계 | 후보를 보인 뒤 `--apply` / 바로 옮긴다 | 사용자 결정(2026-10-24)대로 묻지 않고 `--apply` 로 옮긴다. 휴지통 폴더라 되살릴 수 있다고 적는다 |
| `cleanup.md` `queue` 절 예시 | `sweep_args` 에 `--run` 을 고정 | 예시에서 `--run` 쌍을 뺀다. 명령줄 `--run` 과 다르면 멈춘다는 사실을 한 줄 적는다 |
| `board.md`, `work-board/bin/board.py` 머리 주석 | 진행 정도는 `--progress` 로 넣는다 | 「진행률은 단계 줄에서 센다. `--progress` 는 단계로 나타낼 수 없을 때만 쓴다」 로 board.py 머리 주석과 맞춘다 |
| `waiting.md`, `board.md` | `--goal-items` 를 기본 예시로 쓴다 | 예시에서 빼고 하위 호환 옵션이라고만 적는다 |
| `cleanup.md` 「정리」 | 원격 브랜치를 지운다 | 「로컬 브랜치가 있을 때만 원격도 지운다. 직접 머지한 PR 의 원격 브랜치는 남을 수 있다」 로 지금 동작을 적는다 |
| `SKILL.md` 4단계 통과 조건 | 질문 감시 | 통과 조건에 「질문 감시(`watch-questions.py`)가 Run 마다 하나 돈다」 를 더한다 |

### 2. `orch/tests/test_template_script_path.py` 가 계속 통과하는지 본다

`templates/spec-common.md` 를 고치므로 이 테스트가 읽는 문구가 바뀌었는지 확인하고, 바뀌었으면 테스트의 기대 문구를 고친다.
정상 경로는 틀의 스크립트 경로 명령이 그대로 있는 경우이고, 실패 경로는 그 명령이 빠진 경우다. 둘 다 이 테스트가 이미 다룬다.

## 검증

```bash
python3 -m unittest orch/tests/test_template_script_path.py
python3 -m unittest discover -s scripts/tests
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/references/*.md orch/templates/spec-common.md
! grep -n "PR 생성은 승인돼 있다" orch/templates/spec-common.md
! grep -n "{{RUN_ID}}" orch/templates/spec-common.md orch/references/spec-writing.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/SKILL.md` | 수정 |
| `orch/references/spec-writing.md` | 수정 |
| `orch/references/launch.md` | 수정 |
| `orch/references/verification.md` | 수정 |
| `orch/references/waiting.md` | 수정 |
| `orch/references/replying.md` | 수정 |
| `orch/references/cleanup.md` | 수정 |
| `orch/references/board.md` | 수정 |
| `orch/references/agent-selection.md` | 수정 |
| `orch/templates/spec-common.md` | 수정 |
| `orch/tests/test_template_script_path.py` | 수정 |
