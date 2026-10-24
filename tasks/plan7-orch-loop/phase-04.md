# Phase 04. 기다리기 문서를 상주 루프 기준으로 바꾸고 orch 3.4.0 으로 마감한다

**Execution profile**: standard

## 목표

코디네이터가 Monitor 와 5분 주기 정리 대신 저장소마다 상주 루프 하나와 대기 하나로 일하게 문서를 바꾼다.
이벤트 입력 필드 표를 `lib/events.ts` 머리 주석 한 곳으로 옮기고, 개편 설계 문서의 「구현 전」 문장을 남은 일(자동 진행)을 가리키게 고친다.

**범위 외**: 옛 `.py` shim 과 옛 설정 키를 지우는 일. 다음 major 에서 한다. 자동 진행, 배포 묶기, `ci-missing` 은 `index.json` 의 `deferred` 다. 문서에서도 아직 하지 않는다고 적는다.

## 컨텍스트

시작 조건: `orch/tests/orch-loop-conflict.spec.ts` 가 있다. 없으면 `PHASE_BLOCKED: phase 03 커밋 전` 을 내고 멈춘다.

사용자 결정(2026-10-25): plan7 은 늘 도는 루프(질문 확인, 정리, 보드 동기화, CI 감시와 알림, 충돌 PR 처리)와 wait-important 연동까지만 한다. 이 plan 의 루프가 읽는 설정 키는 `pipeline.tick_sec`, `pipeline.authors`, `finish.run`, `finish.specs_dir`, `queue.required`, `queue.skipped_is_missing` 이다. `pipeline.enabled`, `docs_merge`, `after_queue_interval_sec`, `ci_missing_after_sec`, `update_behind_drafts` 는 아직 읽지 않는다. `ready_slots` 는 `ci-ready.ts` 만 읽는다.

`docs/code-architecture.md` 「orch 문서가 소유하는 것」 은 입력 필드 표를 「구현 뒤에는 `lib/events.ts` 머리 주석이 소유한다」 고 정했다. 같은 값을 두 곳에 두면 한쪽이 낡으므로, 표를 옮긴 뒤 `docs/data-schema.md` 에는 남기지 않는다.
지금 「이벤트별 필드」 를 `docs/data-schema.md` 로 가리키는 곳은 아래 명령이 찾는다. 이 phase 가 모두 `lib/events.ts` 머리 주석으로 바꾼다.

```bash
git grep -n "data-schema.md.*「이벤트별 필드」\|data-schema.md.*「공통 필드」" -- orch docs ':!*CHANGELOG.md'
```

`orch/references/hooks.md` 「이벤트 고르기」 의 표는 「내는 명령 | 이벤트」 다. 이벤트 이름은 둘째 열에 쉼표로 나뉘어 있다. `cleanup-sweep.ts` 줄(`before-cleanup`, `after-cleanup`)이 빠져 있다.
같은 절 13행의 「「내는 명령」 이 아직 Python 인 이벤트는 …」 는 orch 3.3.0 에서 모든 명령이 TypeScript 가 되어 낡았다.

**근거 문서**: `docs/code-architecture.md` 의 「orch 문서가 소유하는 것」, `docs/flow.md` 의 「orch 이벤트」, `docs/adr/009-orch-event-handlers.md`

## 의도 메모

- 이벤트 이름은 `lib/events.ts` 의 `EVENTS` 가 원본이다. `docs/flow.md` 「이벤트 목록」, `lib/events.ts` 머리 주석의 「이벤트별 필드」, `orch/references/hooks.md` 「이벤트 고르기」 표가 같은 이름을 갖는지 테스트로 본다. 개수는 적지 않고 집합을 비교한다.
- `ci-missing` 은 `EVENTS` 에 있지만 내는 명령이 없다. hooks.md 표에 「아직 없다」 줄로 두어 핸들러를 두어도 불리지 않는다고 알린다. 지우면 대조 테스트가 그 이름을 빠진 것으로 낸다.
- 「구현 전」 문장은 지우지 않는다. 자동 진행이 아직 없으므로 설계 문서의 그 부분이 지금 동작이 아니라는 것을 독자가 알아야 한다.

## 작업 항목

### 1. 사용법 문서

| 문서 | 바꿀 것 |
| --- | --- |
| `orch/SKILL.md` 단계 표의 4행과 「4. 기다리기」 | 통과 조건을 「저장소마다 `orch-loop.ts --start` 로 띄운 루프가 살아 있고, 이 세션의 백그라운드 `wait-important` 가 그 저장소들을 `--loop-repo` 로 받아 하나만 돈다. 앞 대기의 `LAST_DELIVERY` id 를 `--ack` 로 넘겼고 받은 delivery 를 `triage-messages` 로 읽었다」 로 바꾼다. Monitor 와 깨어날 때마다 정리하는 문장을 지운다 |
| `orch/references/waiting.md` 「질문 감시와 압축 뒤 복구」 | 루프를 띄우고(`--start`), 확인하고(`--status`), 멈추는(`--stop`) 명령. `--start` 가 4(`LOOP-RUNNING`)로 끝나면 출력의 Run id 를 보고, 다른 Run 이면 `--stop` 뒤 다시 띄운다. 압축 뒤 첫 작업은 `orch-doctor.py --run` 의 `LOOP-DEAD` 확인이다. Monitor 로 `watch-questions.ts` 를 띄우는 것은 루프를 쓸 수 없는 때의 대안으로 한 줄만 남긴다 |
| `orch/references/waiting.md` 대기 절 | 대기 명령에 `--loop-repo "$REPO"` 를 더한다. 종료 코드 7(`LOOP-EVENT` 줄마다 할 일: `REMINDER` 는 `replying.md` 의 질문 처리, `CI-FAILED` 는 그 PR 의 worker 와 CI 확인, `CONFLICT-ORPHAN` 은 코디네이터가 충돌을 맡거나 사용자에게 알림, `WATCH-ERROR` 와 `HOOK-FAIL` 은 이유를 고침, `GAP` 은 `loop.log` 를 읽음)과 8(`LOOP-DEAD`: doctor 가 낸 명령으로 다시 띄운다)을 받았을 때 할 일을 적는다 |
| `orch/references/waiting.md` 「깨어날 때마다 정리와 보드 동기화」 | 정리와 보드 동기화는 루프의 틱이 한다고 바꾼다. 루프가 하지 않는 수동 경로 둘을 남긴다: 목표 진행률(`board-sync.ts --goal "$GOAL_ID"`)은 코디네이터가 목표 항목을 고친 뒤 직접 돌린다(루프는 `--goal` 을 넘기지 않는다). 루프가 없는 저장소는 지금의 두 명령을 깨어날 때마다 돌린다 |
| `orch/references/hooks.md` 「이벤트 고르기」 | 표에 `orch-loop.ts` 줄(`worker-question`, `tick`, `ci-passed`, `ci-failed`, `pr-conflict`), `cleanup-sweep.ts` 줄(`before-cleanup`, `after-cleanup`), 「아직 없다. 핸들러를 두어도 불리지 않는다」 줄(`ci-missing`)을 더한다. 13행의 낡은 문장을 지운다. 28행의 필드 소유자를 `scripts/lib/events.ts` 머리 주석의 「공통 필드」 와 「이벤트별 필드」 로 바꾼다 |
| `orch/references/overlay.md` 「마무리 설정 파일」 | 42, 43행의 「스크립트마다 자기 절만 읽는다 …」 에 상주 루프가 `finish.run`, `finish.specs_dir`, `queue.required`, `queue.skipped_is_missing`, `pipeline` 절을 읽는다는 것을 더한다. `pipeline` 의 `authors` 행에 상주 루프를 더한다. 73행(「아직 읽는 명령이 없다」)을 두 행으로 나눈다: `tick_sec`(틱 간격 초, 기본 300, `orch-loop.ts` 가 읽는다)과, `enabled`, `docs_merge`, `after_queue_interval_sec`, `ci_missing_after_sec`, `update_behind_drafts`(자동 진행의 값. 키는 사용법 오류 없이 받지만 아직 읽는 명령이 없다). `heavy` 행(`exclusive`, `normal`, `light`, `wait_idle`. 정규식 목록이고 `heavy-slot.ts` 가 읽는다. 사용법은 [`heavy-checks.md`](heavy-checks.md))을 더한다. 114행의 `state/` 행에 상주 루프의 파일(`loop.json`, `loop.lock`, `loop.log`, `loop-events.jsonl`, `loop-events.cursor`)을 더한다 |
| `orch/references/verification.md` 머리 | 상주 루프는 CI 를 보고 알리기만 하고 머지하지 않는다는 문장을 더한다. 머지는 지금처럼 7단계 머지 큐가 한다 |
| `orch/README.md` | `scripts/watch-questions.ts` 줄을 「루프를 쓸 수 없을 때 Monitor 로 띄우는 질문 감시」 로, `scripts/wait-important.ts` 줄에 `--loop-repo` 로 루프의 알림과 죽음에 깨어난다는 것을 더한다 |

### 2. 입력 필드 표를 `lib/events.ts` 머리 주석으로 옮긴다

- `docs/data-schema.md` 「공통 필드」 와 「이벤트별 필드」 의 표와 `pr`, `worker` 객체 설명을 `lib/events.ts` 머리 주석의 「공통 필드」, 「이벤트별 필드」 블록으로 옮긴다. 블록은 `// 이벤트별 필드` 줄로 시작하고 빈 `//` 줄에서 끝난다. 행은 `//   <이벤트>[, <이벤트>]  <필드>` 꼴이다
- `docs/data-schema.md` 의 두 절은 「`orch/scripts/lib/events.ts` 머리 주석이 소유한다」 한 줄로 바꾼다. 「옛 셸 명령의 환경 변수와 입력 필드의 대응」 표는 그대로 둔다
- 위 「컨텍스트」 의 grep 이 찾는 머리 주석과 문서를 모두 `lib/events.ts` 머리 주석의 「이벤트별 필드」 로 바꾼다. `lib/events.ts` 3행의 「docs/data-schema.md 의 「이벤트별 필드」 가 정한다」 도 같다
- `docs/code-architecture.md` 「orch 문서가 소유하는 것」 의 hooks.md 행 「두지 않는 것」 칸을 「입력 필드 표. `lib/events.ts` 머리 주석이 소유한다」 로 바꾼다

### 3. 「구현 전」 문장

아래 세 곳을 지우지 않고 남은 일을 가리키게 고친다. 문장은 「상주 루프의 자동 진행(ready 슬롯, base 합치기, 순서 머지, 문서 PR 머지)과 배포 묶기, `ci-missing` 은 아직 구현하지 않았다. 이 문서의 그 부분은 설계이고, 지금 동작은 `orch/SKILL.md` 와 `orch/references/` 가 소유한다」 와 같은 뜻이다.

- `docs/data-schema.md` 4행의 「구현 PR 이 머지되면 사용법은 `orch/references/` 로 옮기고 이 문서에는 계약만 남긴다」
- `docs/code-architecture.md` 「orch 코어와 핸들러」 머리의 「구현 PR 이 모두 머지되기 전의 실제 동작은 …」
- `docs/flow.md` 「orch 이벤트」 머리(138행)의 같은 문장

### 4. 이벤트 이름 대조 테스트 `orch/tests/events-doc.spec.ts`

`lib/events.ts` 의 `EVENTS` 키 집합이 아래 셋과 각각 같은지 본다. 검사 함수는 문서 경로를 인자로 받고, 빠진 이름과 남는 이름을 낸다.

- `docs/flow.md` 「이벤트 목록」 표의 첫 열
- `orch/scripts/lib/events.ts` 머리 주석 「이벤트별 필드」 블록의 행 첫 칸(쉼표로 나뉜 이름을 펼친다)
- `orch/references/hooks.md` 「이벤트 고르기」 표의 둘째 열(쉼표로 나뉜 이름을 펼친다)

정상 경로는 지금 문서다. 실패 경로는 임시 사본에서 hooks.md 표의 `ci-missing` 을 지웠을 때 빠진 이름으로 `ci-missing` 을 내는 것과, flow.md 표에 없는 이름을 더했을 때 남는 이름으로 내는 것이다.

### 5. CHANGELOG 와 버전

`orch/SKILL.md` frontmatter 의 `metadata.version` 을 `3.4.0` 으로 올리고 `orch/CHANGELOG.md` 에 `## 3.4.0 (<날짜>)` 항목 하나로 적는다.
본문: `orch-loop.ts`(틱마다 질문 확인, 정리와 원격 브랜치 정리, 보드 동기화, CI 감시와 `ci-passed`, `ci-failed`, 충돌 PR 처리, `tick`), 알림 파일과 `wait-important --loop-repo`(종료 코드 7, 8), `orch-doctor` 의 `loop_alive` 와 `LOOP-DEAD`, 새 `lib/loop.ts`, `lib/workers.ts`, 입력 필드 표의 소유자 이동.
「호환성」 절: `session-resume` 의 `loop_alive` 가 실제 판정이다. `tick` 의 `open_prs` 는 읽지 못하면 null 이다. 자동 진행, 배포 묶기, `ci-missing` 은 아직 없다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/events-doc.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
claude plugin test .
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/README.md orch/CHANGELOG.md orch/references/*.md docs/flow.md docs/data-schema.md docs/code-architecture.md
! git grep -n "구현 PR 이 모두 머지되기 전의 실제 동작\|구현 PR 이 머지되면 사용법은" -- docs
! git grep -n "data-schema.md.*「이벤트별 필드」\|data-schema.md.*「공통 필드」" -- orch docs ':!*CHANGELOG.md' ':!orch/tests/events-doc.spec.ts'
grep -n "아직 구현하지 않았다" docs/flow.md docs/data-schema.md docs/code-architecture.md
```

`python3 -m unittest discover -s scripts/tests` 는 `scripts/tests/test_doc_script_refs.py` 로 문서가 부르는 `$SKILL_DIR/scripts/*` 경로가 실제로 있는지 본다. 하나라도 실패하면 0 이 아닌 종료 코드다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/SKILL.md` | 수정 |
| `orch/README.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/references/waiting.md` | 수정 |
| `orch/references/hooks.md` | 수정 |
| `orch/references/overlay.md` | 수정 |
| `orch/references/verification.md` | 수정 |
| `orch/scripts/lib/events.ts` | 수정 |
| `orch/scripts/lib/questions.ts` | 수정 |
| `orch/scripts/ci-ready.ts` | 수정 |
| `orch/scripts/finish-pr.ts` | 수정 |
| `orch/scripts/launch-worker.ts` | 수정 |
| `orch/scripts/merge_queue.ts` | 수정 |
| `orch/scripts/notify-conflicts.ts` | 수정 |
| `orch/scripts/orch-doctor.ts` | 수정 |
| `orch/scripts/orch-loop.ts` | 수정 |
| `orch/scripts/wait-important.ts` | 수정 |
| `orch/scripts/watch-questions.ts` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/tests/events-doc.spec.ts` | 신규 |
