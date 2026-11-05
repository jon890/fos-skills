# Phase 04. 복구 절차 문서와 변경 조각

**Execution profile**: standard

## 목표

코디네이터가 한도나 재부팅으로 멈춘 worker 를 만났을 때 참조 문서가 `orch worker resume` 을 먼저 안내하고, 안 될 때만 지금의 새 worker 절차로 가게 한다.

**범위 외**: 스크립트와 테스트(phase-01 부터 phase-03 까지에서 끝남).

## 컨텍스트

**요구사항**: REQ5

**근거 문서**: `docs/features/limit-resume/spec.md`(DECISION13, DECISION14), `docs/features/limit-resume/design.md`(「명령」 의 출력과 단계 표)

- 고칠 절:
  - `skills/orch/references/launch.md` 「이전 세션 이어받기」 의 `LIMITED`, `RESTART` 설명과 「끊긴 worker 다시 띄우기」 표 앞
  - `skills/orch/references/waiting.md` 「사용량 한도로 멈춤」 의 명령 블록과 `WORKER-LIMITED` 설명
  - `skills/orch/references/agent-selection.md` 「사용 한도에 걸렸을 때」
- 명령의 출력 줄과 단계별 `NEXT` 의 원본은 `resume-worker.ts` 머리 주석이다. 문서에는 순서와 판단만 적고 출력 형식을 옮겨 적지 않는다.
- 변경 조각 규칙: README 「버전과 변경 이력」. 새 명령이라 minor 다.

## 의도 메모

- 제공자·모델을 바꾸는 기존 표(agent-selection.md)는 지우지 않는다. 바꿀 계정이 없거나 resume 이 실패했을 때의 길이다(스펙 DECISION13).
- Codex 는 계정을 바꾸면 기록이 보이지 않는다는 점을 적는다(스펙 DECISION14). 코디네이터가 Codex worker 에게 계정 전환 뒤 resume 을 시도하고 실패를 놀라지 않게 하려는 것이다.

## 작업 항목

### 1. `skills/orch/references/agent-selection.md` 「사용 한도에 걸렸을 때」

절 첫머리에 순서를 둔다. 1) 사용자에게 계정 전환을 요청한다. 2) 바꾼 뒤 `orch worker resume --dispatch <id>` 를 부른다. 3) 바꿀 계정이 없거나 `RESUME-FAIL` 이면 아래 표대로 제공자나 모델을 바꿔 새로 띄우고 재개 절을 쓴다(`launch.md` 「끊긴 worker 다시 띄우기」). Claude 는 `projects` 를 공유하는 프로필끼리면 계정을 바꿔도 이어지고, Codex 는 같은 계정에서만 이어진다는 한 줄을 둔다.

### 2. `skills/orch/references/launch.md`

- 「이전 세션 이어받기」 의 `LIMITED`, `RESTART` 항목을 「아래 줄의 `orch worker resume` 을 부른다」 로 바꾼다.
- 「끊긴 worker 다시 띄우기」 첫머리에 「같은 제공자로 이어 갈 수 있으면 먼저 `orch worker resume` 을 쓴다. 이 절은 resume 이 실패했거나 제공자를 바꿀 때다」 를 둔다. 명령이 100초 안팎 걸린다는 점과 Bash 도구의 전경 제한 안이라는 점을 적는다.
- `RESUME-FAIL link` 뒤에는 출력의 `NEXT` 한 줄만 따르고 같은 명령을 다시 부르지 않는다는 점을 적는다.

### 3. `skills/orch/references/waiting.md`

- 「사용량 한도로 멈춤」 의 `worker-abandon` 과 `worker-start --retry-of` 블록 앞에 1번 순서를 가리키는 줄을 두고, 블록은 「resume 이 안 될 때」 로 옮긴다.
- `WORKER-LIMITED` 설명을 새 알림 문구에 맞춘다.

### 4. `skills/orch/changes/limit-resume.minor.md`(신규)

`- ` 줄 한두 개. 예: 「`orch worker resume --dispatch <id>` 를 더했다. 사용 한도나 재부팅으로 멈춘 worker 를 같은 워크트리에서 `claude --resume` / `codex resume` 으로 다시 띄워 같은 Task 에 잇는다」, 「`orch worker adopt` 의 `LIMITED`, `RESTART` 아래 줄이 이 명령 하나를 안내한다」.

## 인수 검증

이 PR 의 인수 검증은 `verification-plan.md` 가 소유한다. 실제 Orca 를 쓰는 세 사례는 이 phase 커밋 뒤 PR 전에 돌린다.

## 검증

```bash
python3 export-only-skills/korean-check/scripts/korean-style-check.py skills/orch/references/agent-selection.md skills/orch/references/launch.md skills/orch/references/waiting.md skills/orch/changes/limit-resume.minor.md
grep -q "worker resume" skills/orch/references/agent-selection.md && grep -q "worker resume" skills/orch/references/launch.md && grep -q "worker resume" skills/orch/references/waiting.md
python3 scripts/check-skill-docs.py
python3 -m unittest discover -s scripts/tests
OUT=$(node scripts/run-node-tests.ts --background) && node scripts/run-node-tests.ts --wait "$OUT"
```

전체 node 테스트는 600초를 넘을 수 있어 `--background` 로 띄우고 `--wait` 로 끝 줄을 기다린다(`scripts/run-node-tests.ts` 머리 주석).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/references/agent-selection.md` | 수정 |
| `skills/orch/references/launch.md` | 수정 |
| `skills/orch/references/waiting.md` | 수정 |
| `skills/orch/changes/limit-resume.minor.md` | 신규 |
