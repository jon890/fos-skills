# Phase 06. 문서의 orch 호출을 새 꼴로, 공통 지시서 틀, 버전과 CHANGELOG

**Execution profile**: standard

## 목표

이 저장소 문서의 orch 호출(`"$SKILL_DIR/bin/orch.ts" <이름>`, `$SKILL_DIR/scripts/<orch 스크립트>.ts`, `python3 "$SKILL_DIR/scripts/orch-doctor.py"`, `$ORCH_SCRIPTS/<이름>.ts`)을 `orch <묶음> <동작>` 으로 바꾸고, 그 상태를 검사로 고정한다.

**범위 외**: 다른 저장소의 사본과 오버레이(doctor 가 알리고 코디네이터가 고친다). 출력 줄 설명의 변경(PR2). 역사 기록인 `skills/orch/CHANGELOG.md` 의 옛 항목과 `docs/adr/008-orch-own-dir.md` 는 그대로 둔다.

## 컨텍스트

**요구사항**: REQ8

**근거 문서**: `docs/features/orch-cli/spec.md` 의 REQ8, 「명령 표」, 「출력」 의 읽는 쪽 표(코디네이터·worker 가 읽는 문서 행). `docs/features/orch-cli/design.md` 의 요구사항 연결 REQ8, 결정 DECISION10·DECISION11.

- 바꿀 문서(2026-11-04 `git grep` 실측): `skills/orch/SKILL.md`, `skills/orch/references/` 의 `board.md`, `cleanup.md`, `gh-call-budget.md`, `heavy-checks.md`, `hooks.md`, `launch.md`, `overlay.md`, `replying.md`, `spec-writing.md`, `study-candidates.md`, `verification.md`, `waiting.md`, `skills/orch/templates/spec-common.md`, `docs/code-architecture.md`, `skills/mac-cleanup/references/git-and-sessions.md`(정리 명령 이름). 구현 때 아래 명령으로 다시 찾는다.

  ```bash
  names=$(ls skills/orch/scripts/*.ts skills/orch/scripts/*.py | xargs -n1 basename | sed 's/\.[a-z]*$//' | sort -u | paste -sd'|' -)
  git grep -nE "bin/orch\.ts|orch-doctor\.py|(SKILL_DIR|ORCH_SCRIPTS)/scripts/($names)\.(ts|py)|ORCH_SCRIPTS/($names)\.ts" -- '*.md' ':!docs/features/orch-cli' ':!skills/orch/CHANGELOG.md' ':!docs/adr'
  ```
- `skills/orch/templates/spec-common.md` 에는 `ORCH_SCRIPTS=$(node -e '…')` 로 설치본 경로를 푸는 블록이 넷 있다(37·46·64·151줄 근처: `worker-ask`, `reserve-migration` 둘, `study-candidates`). `skills/orch/tests/template-script-path.spec.ts` 가 그 명령을 정규식으로 꺼내 돌리고 99~114줄 근처가 `reserve-migration` 꼴을 확인한다.
- `skills/orch/references/overlay.md` 168줄 근처의 「진입점 경로 한 줄」(`ORCH=$(node -e …) && "$ORCH" <명령>`)을 `skills/orch/tests/orch-entry.spec.ts` 219~252줄이 꺼내 돌린다. 172줄 근처의 「진입점 한 파일 복사」 설명은 phase 01 뒤 틀린 말이라 「실행기 `bin/orch` 를 복사한다」 로 고친다. 168줄의 한 줄은 저장소 스크립트(PATH 를 믿을 수 없다)용이라 `orch` 로 바꾸지 않고, 풀어 내는 경로를 실행기 `e.installPath+"/bin/orch"` 로, 예시를 `"$ORCH" slot mem --help` 로 바꾼다. 풀이 규칙은 `selectBundle` 과 같게 한다. `orch-entry.spec.ts` 219~252줄의 기대값은 `/u/a/bin/orch` 꼴이 되고, 「풀린 경로의 진입점이 설치본의 스크립트를 부른다」 사례는 풀린 실행기가 설치본 진입점으로 넘겨 스크립트를 부르는지 본다.
- `skills/orch/references/hooks.md` 의 핸들러 예시를 `skills/orch/tests/orch-loop-stall.spec.ts` 180~187줄 근처가 실제 핸들러로 돌린다. 이 테스트는 `CLAUDE_CONFIG_DIR` 을 고정하지 않아, 예시가 `$ORCH_BIN` 을 부르면 진입점이 이 머신의 설치본(이 기능 이전 번들)으로 넘겨 로컬에서만 실패한다. 테스트가 `ORCH_SCRIPTS_DIR` 을 이 체크아웃으로 고정한다.
- `docs/data-schema.md` 19줄 근처의 핸들러 환경 목록에 `ORCH_BIN` 을 더한다.
- README 「공용 도구」 절(273줄 근처)의 `bin/` 문장은 phase 03 이 고쳤다. 「고치는 동안」 절(306~312줄 근처)에 `orch` 로 체크아웃을 돌리려면 `ORCH_SCRIPTS_DIR=$(git rev-parse --show-toplevel)/skills/orch/scripts` 를 준다고 더한다. 설치 기록에 user 범위 항목이 있으면 `--plugin-dir` 만으로는 실행기가 설치본으로 넘긴다.
- `skills/orch/references/hooks.md` 의 핸들러 예시는 phase 04 가 더한 `ORCH_BIN` 으로 `node "$ORCH_BIN" worker nudge …` 꼴로 쓴다. `ORCH_SCRIPTS` 는 계속 있다고 적는다.
- `extensions/work-board/hooks/register.js` 1422줄 근처의 요청문이 코디네이터에게 `skills/orch/scripts/send-to-worker.ts` 직접 경로를 지시한다. `extensions/work-board/tests/prompts.spec.ts` 19줄 근처가 그 문자열을 본다.
- `skills/orch/SKILL.md` 39줄 근처의 첫 점검이 `python3 "$SKILL_DIR/scripts/orch-doctor.py"` 를 부른다. 설계 「PATH 가 없는 셸」 의 셸 함수 한 줄을 이 자리 하나에 둔다.
- `docs/code-architecture.md` 232줄의 실행 행은 실행기 → 진입점 → 명령 표 구조로 고친다(원본은 `bin/orch`, `skills/orch/bin/orch.ts` 머리 주석).

## 의도 메모

- 틀은 `orch worker ask …` 로 쓰고 `command -v orch` 가 없을 때 쓸 한 줄(설치 기록에서 진입점을 풀어 `orch` 셸 함수로 두기)을 함께 둔다(설계 DECISION10). `install-cli` 를 하지 않은 머신의 Codex worker 셸에도 `orch` 가 없을 수 있다.
- 호환을 설명하는 자리(`waiting.md` 의 옛 `NEXT_WAIT`, `SKILL.md` 의 옛 꼴 안내)에는 옛 꼴이 남는다. 그 줄이나 바로 윗줄에 표지를 둔다. Markdown 본문은 `<!-- orch-compat -->`, 코드 블록 안은 셸 주석 `# orch-compat` 다. 검사와 doctor 가 같은 표지로 건너뛰고, 검사와 doctor 가 같은 표지로 건너뛴다(설계 「옛 꼴과 직접 경로 판정」).
- 짧은 출력은 PR2 이므로 문서가 읽으라고 적은 출력 줄(`LAST_DELIVERY`, `LAUNCHED` 같은 것)은 이 phase 에서 바꾸지 않는다.

## 작업 항목

### 1. 문서 호출 바꾸기

위 목록의 호출을 스펙 「명령 표」 의 새 꼴로 바꾼다. 문맥으로 채워지는 `--repo`, `--run`, `--specs-dir`, `--loop-repo` 는 지운다(스펙 DECISION18). 코디네이터가 다른 저장소에 대해 부르는 예시처럼 값이 문맥과 다른 자리는 남긴다. `SKILL.md` 의 첫 점검에 `command -v orch >/dev/null || orch() { node "$SKILL_DIR/../../bin/orch" "$@"; }` 와 `orch doctor` 를 한 블록으로 두고(실행기를 불러 낮은 node 에서도 `NODE-TOO-OLD` 가 나온다), `CLI-MISSING` 이면 `orch doctor install-cli` 를 한 번 돌리라고 적는다. 다른 문서는 이 자리를 가리킨다.

`extensions/work-board/hooks/register.js` 의 요청문(1422줄과 1426줄 근처의 `send-to-worker.ts` 둘)을 `orch worker send --dispatch <id> --body …` 로 바꾸고 `extensions/work-board/tests/prompts.spec.ts` 의 기대 문자열을 고친다.

### 2. 틀 `skills/orch/templates/spec-common.md`

네 블록을 모두 `orch worker ask --from "$FROM" --question "$QUESTION"`, `orch queue reserve …`, `orch study add …` 로 바꾸고, `command -v orch >/dev/null || orch() { node --disable-warning=ExperimentalWarning "$(node -e '<설치 기록에서 진입점을 푸는 식>')" "$@"; }` 한 줄을 블록 머리에 둔다. 푸는 식의 고르기 규칙은 phase 01 의 `selectBundle` 과 같게 한다(user 항목이 있으면 그것만, 그 번들에 진입점이 없으면 실패).

### 3. 검사

- `skills/orch/tests/template-script-path.spec.ts`: 틀에서 진입점을 푸는 식을 꺼내 `skills/orch/tests/fixtures/install-records.json` 의 행마다 돌리고 기대와 같은지 본다(진입점 경로가 나오거나 실패). `orch` 가 PATH 에 없을 때 셸 함수가 정의되는지 `sh -c` 로 본다.
- `scripts/tests/test_doc_script_refs.py`: 저장소 문서(`skills/**/*.md`, `docs/**/*.md`, `README.md`, 단 `docs/features/orch-cli/`, `skills/orch/CHANGELOG.md`, `docs/adr/` 와 `orch-compat` 표지 줄 제외)에 위 grep 꼴의 호출이 없다는 테스트를 더한다. work-board 요청문(`extensions/work-board/hooks/register.js`)도 본다. `skills/orch/scripts/<이름>.ts` 꼴은 register.js 에만 쓴다. Markdown 에 쓰면 `docs/code-architecture.md` 185줄 근처의 파일 배치 줄(호출이 아니다)이 걸린다. `template-script-path.spec.ts` 는 `reserve-migration` 블록 사례도 새 꼴로 고친다.
- doctor 문서 판정(phase 05)이 새 꼴을 모두 명령 표에서 찾는다: `python3 -m unittest scripts/tests/test_doc_script_refs.py` 가 이것을 돈다.

### 4. 버전과 변경 이력 조각

README 「버전과 변경 이력」 대로 버전과 CHANGELOG 는 직접 올리지 않고 조각을 남긴다(ADR-023). orch 는 `skills/orch/changes/orch-cli-short-command.minor.md`, 바꾼 mac-cleanup 과 work-board 는 각자 `changes/orch-cli-short-command.patch.md` 다.

### 5. 문서 교체 중 찾은 것

- `--sweep-arg --run` 처럼 값을 따로 준 Run 도 명시로 본다(`skills/orch/scripts/lib/context.ts` 의 `explicit`, 설계 「명령 표 항목」 의 `explicit`). 문서의 `orch queue merge --sweep-arg --run …` 예시가 Run 을 두 번 받지 않게 한다.
- 코디네이터 추가 범위(2026-11-05): `SKILL.md` 가 가리키는 `cleanup.md` 의 「다음 PR 은 새 worker 로 띄운다」 는 절이 아니라 「정리」 절의 문단이라 그렇게 적는다. `replying.md` 의 `references/interview.md` 는 spec 스킬로 가는 상대 링크로 바꾼다. 틀 110줄 근처의 오버레이 이름에 옛 이름(`planning-overlay.md`, `build-with-teams-overlay.md`)을 더한다.

## 검증

```bash
node --test skills/orch/tests/template-script-path.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/orch-loop-stall.spec.ts skills/orch/tests/events-doc.spec.ts skills/orch/tests/lib-context.spec.ts extensions/work-board/tests/prompts.spec.ts
python3 -m unittest scripts/tests/test_doc_script_refs.py scripts/tests/test_skill_docs.py
python3 scripts/check-skill-docs.py
python3 export-only-skills/korean-check/scripts/korean-style-check.py skills/orch/SKILL.md skills/orch/references/waiting.md skills/orch/references/cleanup.md skills/orch/templates/spec-common.md skills/orch/CHANGELOG.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/SKILL.md` | 수정 |
| `skills/orch/changes/orch-cli-short-command.minor.md` | 신규 |
| `skills/orch/references/*.md` | 수정 |
| `skills/orch/templates/spec-common.md` | 수정 |
| `skills/orch/tests/template-script-path.spec.ts` | 수정 |
| `skills/orch/tests/orch-entry.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-stall.spec.ts` | 수정 |
| `skills/orch/scripts/lib/context.ts` | 수정 |
| `skills/orch/tests/lib-context.spec.ts` | 수정 |
| `skills/mac-cleanup/changes/orch-cli-short-command.patch.md` | 신규 |
| `skills/mac-cleanup/references/git-and-sessions.md` | 수정 |
| `extensions/work-board/hooks/register.js` | 수정 |
| `extensions/work-board/tests/prompts.spec.ts` | 수정 |
| `extensions/work-board/changes/orch-cli-short-command.patch.md` | 신규 |
| `docs/code-architecture.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `README.md` | 수정 |
| `scripts/tests/test_doc_script_refs.py` | 수정 |
