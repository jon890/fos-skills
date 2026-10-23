# Phase 03. reference 의 스크립트 동작 반복과 모델 관측 문장을 줄이고 README 스크립트 목록을 맞춘다

**Execution profile**: standard

## 목표

reference 문서가 스크립트 머리 주석을 옮겨 적은 부분을 지우고, 언제 어떤 옵션을 쓰는가와 사용자에게 알릴 것, 스크립트가 다루지 않는 수동 경로만 남긴다.
모델이 바뀌면 낡는 관측 문장을 지운다. README 의 스크립트 목록이 실제 파일과 어긋나지 않게 테스트로 묶는다.

**범위 외**: 스크립트 머리 주석 자체를 고치는 일. 문서에서 지운 내용이 머리 주석에 없으면 머리 주석에 옮기는 것까지만 한다.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다.

`heavy-checks.md` 에서 「자리를 잡은 뒤 `mem-gate.py` 로 메모리를 기다린다」 같은 스크립트 동작은 `heavy-slot.py` 머리 주석이 소유한다. 이 phase 는 그 문장을 지우고 언제 대기열을 쓰는지만 남긴다.

반복이 많은 문서는 `orch/references/cleanup.md`, `waiting.md`, `replying.md`, `board.md`, `heavy-checks.md` 다.
예를 들어 `cleanup.md` 「정리」 절의 스크립트가 다루는 경우 목록과 「머지」 절의 판정 설명은 `orch/scripts/cleanup-sweep.py`, `merge_queue.py` 머리 주석과 같은 내용이다.
`waiting.md` 의 `wait-important.py` 종료 코드와 끊긴 worker 판정 설명도 그 스크립트 머리 주석과 겹친다.

모델 행동 관측을 이유로 단 문장의 예: `spec-writing.md` 「worker 는 되묻지 않으면 받은 만큼만 하고 완료로 보고한다」, `verification.md` 「작은 모델일수록 이런 어긋남이 났다」, `agent-selection.md` 의 「Haiku 5.5 실측」 절과 그 결론 문장.
규칙은 남기고 이유만 바꾼다. 이유가 관측뿐이면 규칙이 막는 실패로 적는다.

`orch/README.md` 의 스크립트 목록에는 `completion_evidence.py`, `heavy-slot.py`, `merge-queue.sh`, `orca_repo.py`, `orch_process.py`, `questions.py`, `terminal_ownership.py`, `watch-questions.py` 가 빠져 있다. 목록을 다시 대조할 때는 이 이름을 그대로 믿지 말고 `ls orch/scripts` 와 비교한다.

**근거 문서**: `docs/code-architecture.md` 의 「orch 문서가 소유하는 것」

## 의도 메모

- 지울지 판단하는 기준: 그 문장을 지워도 코디네이터가 언제 무엇을 부를지 알 수 있는가. 알 수 있으면 지운다.
- 「실측」, 사고 사례처럼 규칙의 근거인 문장은 한 줄로 남긴다. 같은 사례를 두 문서에 적지 않는다.
- README 목록은 개수를 적지 않는다. 테스트가 파일과 목록을 대조한다.

## 작업 항목

### 1. 위에 든 reference 문서의 반복을 지운다

각 절에서 머리 주석과 같은 내용을 지우고 「판정과 종료 코드는 `<스크립트>` 머리 주석이 소유한다」 한 줄로 바꾼다.
지우기 전에 그 내용이 머리 주석에 있는지 확인하고, 없으면 머리 주석에 옮긴다.

### 2. 모델 관측 문장을 지운다

`agent-selection.md` 의 실측 절은 표의 선택 기준만 남기고 지운다. 선택 기준이 그 실측에 기대면 「같은 Task 결과로 판단한다」 로 바꾼다.

### 3. `orch/README.md` 스크립트 목록을 실제 파일에 맞춘다

빠진 스크립트를 한 줄씩 더한다. 다른 스크립트가 import 만 하는 모듈은 「모듈」 이라고 밝힌다.

### 4. 목록과 파일을 대조하는 `orch/tests/test_readme_script_list.py`

`orch/scripts/` 의 `*.py` 와 `*.sh` 파일 이름마다 `orch/README.md` 에 `` `scripts/<이름>` `` 이 있는지 본다.
정상 경로는 지금 파일 전부가 목록에 있는 경우다. 실패 경로는 임시 폴더에 README 와 스크립트 하나를 더 만들어 목록에 없는 이름을 실패로 내는지 본다. 검사 함수는 README 경로와 스크립트 폴더를 인자로 받게 둔다.

### 5. `orch/CHANGELOG.md` 와 `orch/SKILL.md` 의 `metadata.version`

이 plan 의 phase 들을 한 항목으로 적고 그때 main 의 버전에서 minor 를 올린다. 지시를 바꿨으므로 minor 다(저장소 루트 `README.md` 「버전과 변경 이력」). 다른 PR 이 먼저 머지해 같은 번호를 썼으면 그 위로 올린다.

## 검증

```bash
python3 -m unittest orch/tests/test_readme_script_list.py
python3 scripts/run-orch-tests.py --jobs 4
python3 -m unittest discover -s scripts/tests
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/README.md orch/references/*.md
! grep -n "Haiku 5.5 실측\|작은 모델일수록\|되묻지 않으면" orch/references/*.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/references/cleanup.md` | 수정 |
| `orch/references/waiting.md` | 수정 |
| `orch/references/replying.md` | 수정 |
| `orch/references/board.md` | 수정 |
| `orch/references/heavy-checks.md` | 수정 |
| `orch/references/spec-writing.md` | 수정 |
| `orch/references/verification.md` | 수정 |
| `orch/references/agent-selection.md` | 수정 |
| `orch/scripts/*.py` | 수정 |
| `orch/README.md` | 수정 |
| `orch/tests/test_readme_script_list.py` | 신규 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/SKILL.md` | 수정 |
