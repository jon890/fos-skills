# Phase 06. 문서를 새 짧은 출력에 맞추기

**Execution profile**: standard

## 목표

코디네이터와 worker 가 읽는 문서의 「읽으라고 적은 줄」 을 새 짧은 출력에 맞추고, 기능 루프의 단계 인계 표를 `feature-docs.md` 를 가리키는 한 줄로 줄이며, 변경 이력 조각을 더한다.

**범위 외**: 스크립트 동작(phase 01-05), 저장소 밖 문서(코디네이터가 고친다).

## 컨텍스트

**요구사항**: REQ4

**근거 문서**: `docs/features/orch-cli/spec.md` 의 「출력」 의 읽는 쪽 표, REQ4, REQ8. `docs/features/orch-cli/design.md` 의 「짧은 출력 (PR2)」 표의 「읽는 쪽」 칸.

- 문서는 진입점으로 부른 출력을 읽는 자리만 고친다. 스크립트 머리 주석(직접 실행 출력)은 phase 01-05 에서 짧은 출력 문장만 더했다.
- 하네스 감사 B(#340)의 후속(지시서가 이 PR 에 넣으라고 정했다): `skills/orch/references/feature-loop.md` 47-55줄의 단계 인계 표(순서, 실행할 스킬, 넘길 것, 다음 단계 조건)는 `skills/spec/references/feature-docs.md` 의 「인계」 표와 겹친다.
- 변경 이력 조각은 README 「버전과 변경 이력」 을 따른다(`skills/orch/changes/<슬러그>.minor.md`, `- ` 줄 1-5개).

## 작업 항목

### 1. `skills/orch/references/waiting.md`

- 대기 출력 읽기(5, 10, 27, 116, 131, 136줄 근처와 「대기 결과는 `triage-messages` 로 읽는다」 절)를 새 출력으로 고친다: 메시지마다 판정 줄(`DONE`, `DONE-SUSPECT`, `STOPPED`, `ESCALATION`, `QUESTION`, `STATUS`), `RAW <파일>`, `LAST_DELIVERY`. 본문 전체는 `orch wait triage --full <RAW 파일>`. `orch wait triage` 를 따로 부를 필요가 없다는 것(스펙 DECISION21).
- 63줄 근처의 「4 와 함께 `안내:` 줄이 오면」 은 짧은 출력에서 안내 줄 대신 `LOOP-LEGACY <pid> run=<Run>` 줄이 오므로 그 줄로 고친다.
- `건너뜀` 줄(205줄 근처)은 루프 로그(경로 호출, 지금 출력)라 그대로다.

### 2. `skills/orch/references/launch.md`, `replying.md`, `verification.md`, `cleanup.md`, `board.md`

- `launch.md`: `LAUNCHED <dispatch> <터미널> <워크트리>` 와 `REFUSED`. `worker adopt` 의 `SESSION` 한 줄.
- `replying.md`: `sent:`, `delivered` 같은 줄 이름을 `SENT`, `DELIVERED`, `REPLIED`, `ENDED`, `NOTE` 로. 깨우기 줄 `NUDGED`.
- `verification.md`: `일치`, `불일치` 를 `MATCH`, `MISMATCH` 로. `triage-messages` 언급을 `orch wait` 의 `DONE-SUSPECT` 로.
- `cleanup.md`: 머지 큐의 `MERGED <PR>`, `FINISH-STARTED`, `FINISH-FAIL <이유>`(로그 파일 `finish-<PR>.out` 은 지금 출력이라 마지막 줄이 이유 없는 `FINISH-FAIL` 이고 이유는 앞 줄이다), `READY`/`HELD`, `CONFLICT <PR> <브랜치> <결과>`, 정리의 `REMOVED`/`KEPT`/`SWEEP`. `Docker 정리 건너뜀` 은 `KEPT docker <이유>`.
- `board.md`: `BOARD …`, `BOARD-SYNC`, `GOAL`.
- `overlay.md`: `orch doctor migrate` 의 「추적 파일」 줄(211줄 근처)을 `TRACKED` 로.

### 3. `skills/orch/SKILL.md`

- 첫 점검과 「기다리기」 행(105-106, 132줄 근처)의 `triage-messages` 읽기를 `orch wait` 의 메시지 판정 줄로 고친다.
- 상태를 한 번에 보는 `orch status` 를 한 줄로 더한다.
- 「출력」 한 줄: 기본 출력은 판정 줄이고 `--full` 이 지금 출력이다.

### 4. worker 가 읽는 문서

- `skills/orch/templates/spec-common.md` 70줄 근처: 「4 면 출력의 메시지 ID 로」 를 「4 면 `TIMEOUT <질문 id>` 줄의 id 로」, 「3 이면 … 아니면 Run 메일함」 을 「3 이면 첫 줄이 `answer: ` 면 status 답, `SENT-RUN <id>` 면 Run 메일함」 으로.
- `skills/spec/references/interview.md`: `worker-ask` 의 `answer: ` 읽기가 그대로인지 보고, 시간 초과 문장이 있으면 `TIMEOUT` 으로 고친다.

### 5. `skills/orch/references/feature-loop.md`

47-55줄의 표를 「단계마다 넘길 것과 다음 단계 조건은 `../../spec/references/feature-docs.md#인계` 로 링크한 「기능 문서와 단계 인계」 가 소유한다. docs-consolidate 뒤는 아래 「worker 와 PR」 과 orch 의 PR·머지·정리 절차다.」 한 줄로 바꾼다.

### 6. 전역 문서와 변경 이력

- `docs/code-architecture.md` 「실행 규칙」 의 「실행」 행에 짧은 출력 신호 한 문장(`ORCH_OUTPUT=short`, `--full`, 원본은 `scripts/lib/output.ts` 와 진입점 머리 주석)을 더한다.
- `skills/orch/changes/orch-cli-short-output.minor.md` 신규: 기본 출력이 판정 줄, `--full`, `orch wait` 의 메시지 판정 줄과 `RAW`, `orch status`, doctor 의 `WAIT-READER`.
- `skills/spec/changes/feature-loop-handoff-pointer.patch.md` 는 만들지 않는다. 고치는 파일이 orch 스킬의 것이라 orch 조각에 한 줄로 적는다.

### 7. 검사

- 이 phase 의 문서 파일을 `python3 export-only-skills/korean-check/scripts/korean-style-check.py` 로 점검한다.
- `python3 scripts/check-skill-docs.py` 가 변경 이력 조각을 받는다.
- 문서 스크립트 판정(`orch-doctor.ts --skip-version`)이 `MISSING` 없이 `OK-SCRIPTS` 를 낸다. 새 꼴 `orch status` 를 명령 표가 안다.

## 검증

```bash
node --test skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/template-script-path.spec.ts skills/orch/tests/spec-lint.spec.ts
python3 -m unittest discover -s scripts/tests
python3 scripts/check-skill-docs.py
python3 export-only-skills/korean-check/scripts/korean-style-check.py skills/orch/references/waiting.md skills/orch/references/launch.md skills/orch/references/replying.md skills/orch/references/verification.md skills/orch/references/cleanup.md skills/orch/references/board.md skills/orch/references/overlay.md skills/orch/references/feature-loop.md skills/orch/SKILL.md skills/orch/templates/spec-common.md docs/code-architecture.md skills/orch/changes/orch-cli-short-output.minor.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/references/waiting.md` | 수정 |
| `skills/orch/references/launch.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `skills/orch/references/verification.md` | 수정 |
| `skills/orch/references/cleanup.md` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/references/overlay.md` | 수정 |
| `skills/orch/references/feature-loop.md` | 수정 |
| `skills/orch/SKILL.md` | 수정 |
| `skills/orch/templates/spec-common.md` | 수정 |
| `skills/spec/references/interview.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `skills/orch/changes/orch-cli-short-output.minor.md` | 신규 |
