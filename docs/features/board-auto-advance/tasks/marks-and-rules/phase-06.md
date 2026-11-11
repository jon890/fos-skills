# Phase 06. 표시와 코디네이터 규칙을 orch 문서에 적는다

**Execution profile**: standard

## 목표

표시의 꼴과 뜻, 붙여도 되는 일과 근거 꼴, 코디네이터가 다음 단계를 이어 갈 때 따르는 절차를 orch 스킬 문서에 적는다. worker 가 남은 PR 목록을 넘기는 한 줄을 공통 지시서 틀에 더한다. 문서와 코드가 어긋나지 않게 문서 테스트를 더하고, 변경 조각을 남긴다.

**범위 외**: 루프가 표시를 읽는 규칙과 `STEP-READY` 알림 설명(다음 PR 이 그 동작과 함께 적는다). 저장소 오버레이(`.orch/overlay.md`)에는 아무것도 옮겨 적지 않는다(스펙 REQ12).

## 컨텍스트

- 문서 세 곳의 소유 범위는 `docs/features/board-auto-advance/design.md` 「코디네이터 규칙의 자리」 가 정했다.
  - `skills/orch/references/board.md`: 보드 규칙. 지금 절은 「마일스톤 단계」, 「보드 단계」(지시서 예시 안의 제목), 「직접 작성한 사건 단계」, 「갱신 담당」, 「목표 진행 표시줄」 이다.
  - `skills/orch/references/replying.md`: 사용자에게 묻고 worker 에게 지시를 보내는 절차.
  - `skills/orch/references/waiting.md`: 메시지와 루프 알림을 받았을 때. 「메시지가 오면」 절이 있다.
- 문서는 지금 있는 동작만 적는다. 이 PR 이 머지된 시점에 루프는 표시를 읽지 않는다(설계 「PR A 만 머지된 동안」 표). `board.md` 「자동 진행 표시」 에 그 시점의 동작 셋을 적는다: 표시 줄도(`[wait]` 포함) 표시 없는 줄처럼 30분 뒤 멈춤 알림을 받는다, `[wait: 시각]` 줄은 저절로 끝나지 않아 코디네이터가 끝낸다, 다음 단계는 코디네이터가 `worker_done` 과 머지·배포 알림을 받은 턴에 보드를 보고 이어 간다.
- `[ask]` 단계를 무엇으로 묻는지는 승인 버튼 기능이 머지됐는지에 달렸다. `skills/orch/references/replying.md` 에 「보드 승인」 절이 이미 있으면 「`orch board approval add step-<항목>-<번호> --kind step …` 으로 승인 대기를 올린다」 로 적고 그 절을 가리킨다. 없으면 「결정 질문 형식으로 사용자에게 묻는다」 로 적는다(설계 「`[ask]` 단계와 승인 대기」).
- 거절 이유 글의 원본은 `skills/orch/scripts/core/auto-advance.ts` 의 `ADVANCE_REASONS` 다(phase 03).
- 문서 테스트는 `skills/orch/tests/docs-contract.spec.ts` 다. `read('references', 'waiting.md')` 로 문서를 읽고 `section(text, '## 제목')` 으로 절을 떼어 정규식으로 단언한다.
- 설정 표는 `docs/data-schema.md` 「config.json 에 더하는 절」 과 `skills/orch/references/overlay.md` 의 설정 표(board 행들)에, 상태 파일은 `docs/data-schema.md` 「orch 루트에 더하는 파일」 에 있다.
- 명령의 계약 문서는 둘이다. `docs/features/orch-cli/spec.md` 「명령 표」 의 `board` 행(`skills/orch/scripts/lib/commands.ts` 머리 주석이 계약으로 가리킨다)과 `docs/features/orch-cli/design.md` 「짧은 출력 (PR2)」 의 표다.
- worker 가 읽는 공통 규칙은 `skills/orch/templates/spec-common.md` 다. 줄 끝의 `<!-- orch-rule: 이름 -->` 표시로 규칙을 구분하고, `orch spec sync-common` 이 저장소의 공통 지시서에 맞춘다. 표시가 붙은 규칙이 저장소 공통 지시서에 없으면 `spec-lint` 가 경고한다(`skills/orch/scripts/lib/common-rules.ts`). 지금 끝내기 규칙은 「PR 이 MERGED 인 것을 확인한 뒤 `worker_done` 을 보낸다. PR 번호와 머지 커밋, … 줄을 적는다」(`orch-rule: done-after-merged`)다.
- 변경 조각은 `<스킬 폴더>/changes/<슬러그>.<등급>.md` 이고 내용은 `- ` 줄 1~5개다(저장소 `README.md` 「버전과 변경 이력」). 버전과 `CHANGELOG.md` 는 직접 올리지 않는다.
- 한국어 문서는 `node export-only-skills/korean-check/scripts/check.ts <파일>` 로 점검한다.

**선행 조건**: 보드 명령 구현 PR(`docs/features/orch-board-cli/spec.md` REQ4, REQ6, REQ14 와 그 설계의 「마지막 PR 과 남은 단계」)이 먼저 머지된다. 이 phase 는 그 PR 이 만든 `orch board step <항목> <번호> text "<줄>" [--on "<PR> <사건>"]` 와 `done`, 그 PR 이 고친 `board.md`(새 명령 안내, 마지막 PR 규칙, `BOARD-UNMATCHED`)에 기댄다. 시작할 때 `board.md` 와 `waiting.md` 의 지금 모습을 읽고 명령 꼴과 낱말을 그대로 따른다.

**요구사항**: REQ1, REQ2, REQ7, REQ8, REQ9, REQ11, REQ12

**근거 문서**: `docs/features/board-auto-advance/spec.md`, `docs/features/board-auto-advance/design.md`

## 의도 메모

- 규칙을 저장소 오버레이로 덮지 않는다. 다른 저장소 코디네이터도 플러그인 갱신만으로 같은 규칙을 쓴다.
- 문서에 「다음 PR 에서」 같은 예고를 적지 않는다. 계획서는 PR 뒤에 지워지고 문서는 남는다.
- 사용 한도 규칙은 이 PR 에서 글 규칙이다. 명령이 확인하는 것은 다음 PR 이 더한다.

## 작업 항목

### 1. `skills/orch/references/board.md` 에 「자동 진행 표시」 절을 더한다

「직접 작성한 사건 단계」 절 뒤에 둔다. 담을 것:

- 꼬리표 없는 수동 단계 줄의 번호 뒤 맨 앞에 `[auto]`, `[ask]`, `[wait]`, `[wait: <조건>]` 중 하나를 붙일 수 있다. 뜻은 차례로 「미리 허락된 일이라 코디네이터가 묻지 않고 띄운다」, 「사용자가 정한다」, 「조건을 기다린다」 다.
- 예시 줄 넷: `2. [auto] PR4 회차 추이 API (계획: <경로>)`, `3. [ask] real 활성화`, `4. [wait: 2026-11-10 19:00] real 19:00 회차`, `5. [wait] 기획 답 (#665 merge)`.
- 붙이는 것은 코디네이터다. worker 는 계획에서 나눈 PR 목록을 `worker_done` 에 적어 넘기고 보드를 고치지 않는다.
- 사건 단계(줄 글에 `[pr]`, `[merge]`, `[deploy]`, `[release]` 가 있는 줄과 `stages` 필드에 든 번호의 줄)에는 붙이지 않는다. 붙여도 읽지 않는다.
- `[auto]` 를 붙여도 되는 일(스펙 DECISION1): 확인받은 계획의 다음 PR, 스펙 확인 뒤 설계와 계획, 배포·회차 뒤 정리와 다시 재기, 리뷰 지적 반영과 머지.
- 붙이면 안 되는 일(스펙 DECISION2): real 에 닿는 일, 외부로 나가는 글, 범위가 바뀌는 일.
- `[auto]` 줄에는 근거를 괄호로 적는다: `(스펙: <경로>)`, `(계획: <경로>)`, `(앞 사건: #N merge)`. 경로가 절대경로면 그 자리, 상대경로면 저장소 기본 checkout 기준이다. 앞 사건 근거는 줄 끝 사건 꼬리표 `(#N merge)` 와 다른 꼴로 적는다. 줄 끝 꼬리표는 그 사건이 일어나면 그 줄을 끝낸다. 근거 괄호 안의 PR 번호는 그 줄을 끝내지 않는다.
- 꼬리표와 함께 쓸 때의 제약(설계 「단계 줄」): 줄 끝 꼬리표가 하나라도 있는 항목은 꼬리표 줄만 스크립트가 끝내고 항목 상태는 코디네이터가 바꾼다. 그래서 직접 쓴 항목에서는 PR 이 끝낼 줄마다 꼬리표를 붙인다. `stages` 필드가 있는 항목(띄우기가 만든 마일스톤 항목)에는 꼬리표를 붙이지 않는다.
- 마일스톤 항목에서는 표시 줄을 done 지점(`board.done_after`) 뒤 번호에 둔다. 앞 번호의 수동 줄은 마지막 PR 이 done 지점에 닿을 때 함께 끝난다. `--board-id` 로 항목을 정한 마무리는 남은 줄과 상관없이 항목을 닫는다.
- 꼴이 다른 표시(`[Auto]`, `[maybe]`)는 표시 없는 줄로 읽는다. 표시 없는 줄은 지금과 같이 다룬다. 옛 줄을 한꺼번에 고치지 않고 단계를 새로 쓰거나 고칠 때 붙인다.
- 표시를 바꾸는 명령과 띄우는 절차는 `replying.md` 「다음 단계 이어 가기」 가 소유한다는 한 줄.
- 표시의 꼴은 `extensions/work-board/hooks/step-marks.js` 가 소유한다는 한 줄.

### 2. `skills/orch/references/replying.md` 에 「다음 단계 이어 가기」 절을 더한다

「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」 절 앞에 둔다. 담을 것:

- 언제: `worker_done` 이나 머지·배포 알림을 받았거나 보드를 확인한 턴에, 상태가 doing 이나 wait 인 항목의 첫 미완료 단계가 `[auto]` 면 같은 턴에 이어 간다. `[ask]` 면 사용자에게 묻는다(위 컨텍스트의 두 꼴 중 맞는 것). `[wait]` 면 아무것도 하지 않는다.
- 띄우기 전에 `orch board auto-check <항목>` 을 부른다. 코드 블록으로 명령을 보인다.
- `AUTO-OK <항목> <번호> <근거>` 면 지시서를 쓰고 띄운다. 지시서에 `보드 항목 id: <항목>` 줄을 꼭 적는다. 이 줄이 있어야 띄운 기록이 남는다. 커밋하지 않은 스펙은 지시서의 `루프를 쓴다(스펙: …)` 에 절대경로로 적는다. 지시서 검사는 상대경로 스펙을 기준 브랜치의 커밋된 내용으로 읽는다.
- 띄운 턴의 답에 `다음 단계 자동 진행: <무엇을>, <agent·모델>, <묻지 않은 이유(근거)>` 한 줄을 남긴다. 근거는 `AUTO-OK` 줄의 것을 옮긴다. 따로 메시지를 보내지 않는다.
- 띄운 단계의 줄을 끝내는 법을 표로 적는다(설계 「자동으로 띄운 단계의 줄을 끝내는 법」 의 표 세 줄).
  - PR 을 여는 일이고 직접 쓴 항목이면: worker 가 PR 번호를 알린 턴에 `orch board step <항목> <번호> text "<줄>" --on "<PR> merge"` 로 꼬리표를 붙인다. 머지되면 스크립트가 그 줄을 끝낸다.
  - PR 을 여는 일이고 `stages` 필드가 있는 항목이면: 꼬리표를 붙이지 않고 머지를 확인한 턴에 `orch board step <항목> <번호> done`.
  - PR 이 없는 일이면: `worker_done` 을 확인한 턴에 `orch board step <항목> <번호> done`.
- `AUTO-REJECT` 의 이유마다 할 일을 표로 적는다. 이유 글은 `ADVANCE_REASONS` 의 값을 그대로 쓴다.

  | 이유 | 할 일 |
  | --- | --- |
  | `자동 진행이 꺼져 있다`, `항목이 없다`, `상태가 doing 이나 wait 가 아니다`, `첫 미완료 단계가 [auto] 가 아니다` | 띄우지 않는다 |
  | `worker 나 열린 PR 이 있다` | 띄우지 않는다. 그 단계가 진행 중이다 |
  | `worker 나 PR 을 확인하지 못했다` | 띄우지 않는다. 루프가 도는지 보고(`orch loop status`) 다시 확인한다 |
  | `이미 한 번 띄웠다` | 그 일이 끝났으면(머지나 `worker_done` 확인) 위 표대로 줄을 끝낸다. 끝내지 못했으면 다시 띄우지 않고 그 줄을 `[ask]` 로 바꿔 사용자에게 묻는다 |
  | `근거가 없다`, `스펙 파일이 없다`, `스펙에 확인 줄이 없다`, `계획 파일이 없다`, `앞 사건이 끝나지 않았다` | 띄우지 않고 그 줄을 `[ask]` 로 바꿔 사용자에게 묻는다 |

- 표시를 바꾸는 명령: `orch board step <항목> <번호> text "<번호와 새 표시를 넣은 줄 전체>"`. 줄 끝 꼬리표가 붙은 줄은 새 글에도 꼬리표를 넣는다(빼면 명령이 거절한다).
- 한도(스펙 REQ9): 살아 있는 worker 수로는 미루지 않는다. 최근 30분 안에 `WORKER-LIMITED` 를 받았으면 띄우지 않고 사용자에게 알리며 표시는 그대로 둔다. 한 단계는 한 번만 자동으로 띄운다. 전체 테스트는 지금처럼 heavy 자리와 CI 판정 규칙을 따른다.
- 실패(스펙 REQ9, DECISION20): 자동으로 띄운 worker 가 일을 끝내지 못하면(`worker_done` 의 failed, 끝난 터미널, 사용자가 멈춤) 다시 띄우지 않고 그 단계를 `[ask]` 로 바꿔 묻는다. CI 실패와 리뷰 지적은 실패가 아니고 지금처럼 같은 worker 에 고치라고 지시한다.
- `[ask]` 단계를 사용자가 허락해 띄우면 그 줄의 표시를 지운다(설계 DECISION9). 표시 없는 줄이 되어야 worker 가 조용히 끝났을 때 멈춤 알림이 간다.
- 멈추기(스펙 REQ11): 단계 하나는 사용자가 멈추라고 하면 그 worker 를 기존 절차로 중지하고 그 단계를 `[ask]` 로 바꾼다. 저장소 전체는 `.orch/config.json` 의 `board.auto_advance` 를 `false` 로 둔다.
- 이 규칙은 저장소 오버레이에 옮겨 적지 않는다.

### 3. `skills/orch/references/waiting.md` 「메시지가 오면」 에 한 줄을 더한다

`worker_done` 이나 머지·배포 알림으로 깨어났을 때 그 보드 항목의 다음 단계가 `[auto]` 나 `[ask]` 면 `replying.md` 의 「다음 단계 이어 가기」 를 따른다는 한 줄과 링크.

### 4. `skills/orch/templates/spec-common.md` 에 worker 규칙 한 줄을 더한다

끝내기 규칙(`orch-rule: done-after-merged`) 바로 뒤에 아래 뜻의 한 줄을 더하고 줄 끝에 `<!-- orch-rule: remaining-prs -->` 를 붙인다(스펙 REQ1).

> 계획에서 PR 을 여럿으로 나눴으면 `worker_done` 본문에 남은 PR 목록을 PR 마다 한 줄(이름과 계획 경로)로 적는다. 보드에는 코디네이터가 단계로 올린다.

`remaining-prs` 라는 이름이 이미 쓰이는지 `git grep -n "orch-rule: remaining-prs"` 로 확인한다. 이 저장소의 `skills/orch/references/spec-writing.md` 에 공통 규칙 목록이 있으면 같은 줄을 더한다.

### 5. 설정, 상태 파일, 명령 계약 표

- `docs/data-schema.md` 「config.json 에 더하는 절」 표에 `board` `auto_advance` 행: 값 「`true` 나 `false`. 아니면 설정 오류다」, 기본 `true`, 뜻 「`false` 면 `orch board auto-check` 가 거절해 코디네이터가 다음 단계를 자동으로 띄우지 않는다」.
- `docs/data-schema.md` 「orch 루트에 더하는 파일」 표에 `state/step-launches.jsonl` 행: 한 줄의 필드(`at`, `item`, `number`, `step`, `dispatch`, `branch`), 쓰는 쪽(`launch-worker`, `send-to-worker`), 읽는 쪽(`orch board auto-check`), 자동으로 지우지 않는다.
- `skills/orch/references/overlay.md` 설정 표의 board 행들 옆에 `auto_advance` 행.
- `docs/features/orch-cli/spec.md` 「명령 표」 의 `board` 행에 `auto-check <항목>` 과 스크립트 `auto-check` 를 더한다.
- `docs/features/orch-cli/design.md` 「짧은 출력 (PR2)」 표의 `board goal` 행 뒤에 `board auto-check` 행: 짧은 출력 `AUTO-OK <항목> <번호> <근거>`, `AUTO-REJECT <항목> <번호 또는 -> <이유>`, 읽는 쪽 `references/replying.md`.

### 6. 변경 조각

- `skills/orch/changes/board-step-marks-rules.minor.md` 신규: 표시와 근거 규칙, `orch board auto-check`, `board.auto_advance`, 띄운 기록, 근거 괄호의 PR 번호가 줄을 끝내지 않게 한 것을 `- ` 줄로 적는다.
- `extensions/work-board/changes/step-marks.patch.md` 신규: 단계 줄의 자동 진행 표시를 읽고 쓰는 `hooks/step-marks.js` 를 더했고 창의 표시는 그대로라는 한 줄.

### 7. 이 phase 를 검증하는 `skills/orch/tests/docs-contract.spec.ts` 수정

- `board.md` 에 `## 자동 진행 표시` 절이 있고, 그 절에 `[auto]`, `[ask]`, `[wait]`, `(스펙:`, `(계획:`, `(앞 사건:` 과 붙이면 안 되는 일 셋의 낱말(`real`, `외부로 나가는 글`, `범위가 바뀌는 일`)이 있다.
- `replying.md` 에 `## 다음 단계 이어 가기` 절이 있고, 그 절에 `orch board auto-check`, `다음 단계 자동 진행:`, `보드 항목 id:`, `board.auto_advance`, `WORKER-LIMITED`, `--on` 이 있다.
- `ADVANCE_REASONS` 의 값이 모두 그 절에 있다. 값을 코드에서 가져와 돌면서 단언한다. 이유를 더하거나 글을 바꾸고 문서를 안 고치면 깨진다.
- `waiting.md` 가 「다음 단계 이어 가기」 를 가리킨다.
- `templates/spec-common.md` 에 `orch-rule: remaining-prs` 가 한 번 있다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/docs-contract.spec.ts skills/orch/tests/events-doc.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/sync-common.spec.ts
node export-only-skills/korean-check/scripts/check.ts skills/orch/references/board.md skills/orch/references/replying.md skills/orch/references/waiting.md skills/orch/references/overlay.md skills/orch/templates/spec-common.md docs/data-schema.md docs/features/orch-cli/spec.md docs/features/orch-cli/design.md skills/orch/changes/board-step-marks-rules.minor.md extensions/work-board/changes/step-marks.patch.md
claude plugin test .
```

세 명령 모두 종료 코드 0 이어야 한다. `spec-lint.spec.ts` 와 `sync-common.spec.ts` 는 공통 지시서 틀에 규칙을 더해도 깨지지 않는지 본다. 규칙 수를 상수로 단언하는 사례가 있으면 그 값을 고치고 변경 파일에 더한다.

마지막 phase 이므로 커밋 전에 전체 테스트도 한 번 돈다. 여러 worker 가 함께 돌리면 느려지므로 자리를 잡고 돈다. 종료 코드 0 이어야 한다.

```bash
orch slot heavy --exclusive -- node scripts/run-tests.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/references/board.md` | 수정 (「자동 진행 표시」 절) |
| `skills/orch/references/replying.md` | 수정 (「다음 단계 이어 가기」 절) |
| `skills/orch/references/waiting.md` | 수정 (가리키는 한 줄) |
| `skills/orch/references/overlay.md` | 수정 (설정 표 행) |
| `skills/orch/templates/spec-common.md` | 수정 (남은 PR 목록 규칙) |
| `docs/data-schema.md` | 수정 (설정 행, 상태 파일 행) |
| `docs/features/orch-cli/spec.md` | 수정 (명령 표의 board 행) |
| `docs/features/orch-cli/design.md` | 수정 (짧은 출력 표 행) |
| `skills/orch/changes/board-step-marks-rules.minor.md` | 신규 |
| `extensions/work-board/changes/step-marks.patch.md` | 신규 |
| `skills/orch/tests/docs-contract.spec.ts` | 수정 (문서 단언) |
| `scripts/runtime-policy.json` | 수정 (work-board 공용 JS 모듈 허용 목록에 step-marks 추가) |
