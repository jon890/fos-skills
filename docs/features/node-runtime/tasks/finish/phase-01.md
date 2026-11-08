# Phase 01. Python 실행 경로와 남은 python3 안내를 정리한다

**Execution profile**: standard

## 목표

테스트 실행기, CI, 문서에서 Python 을 전제하는 줄을 지운다. orch-legacy 는 남긴다.

**범위 외**: `orch-doctor.py`, `ts_shim.py` 삭제와 그에 기대는 orch 테스트(orch-cli 정리 PR), 팀 저장소 반영(스펙 REQ8, 머지 뒤 팀 PR).

## 컨텍스트

**요구사항**: REQ1, REQ4, REQ5, REQ9

**근거 문서**: `docs/features/node-runtime/design.md` 「영역별 메모」 11행, 「CI」 절

지울 자리:

| 자리 | 이유 |
| --- | --- |
| `scripts/run-tests.ts` 의 Python 묶음(발견, `pythonPhase`, 옵션 설명) | 추적되는 `tests/test_*.py` 가 없다(`git ls-files`) |
| `scripts/tests/run-tests.spec.ts` 의 Python 사례 | 위와 같다. `test_*.py` 를 더 이상 찾지 않는 사례로 바꾼다 |
| `.github/workflows/ci.yml` 의 `setup-python`, `jq` 설치 | Python 테스트가 없고 `jq` 를 쓰는 테스트·스크립트가 없다(`git grep -w jq`) |
| `scripts/test-plugin-install.ts` 의 `python3` 존재 검사 | 쓰지 않는 도구다 |
| `githooks/commit-msg.ts` 머리 주석 | 검사기가 Python 이라는 낡은 문장 |
| README, `docs/code-architecture.md` 의 Python 묶음 설명 | 실행기가 더는 돌지 않는다 |
| `skills/orch/README.md` 의 `python3` 요구, `agent-selection.md` 의 `python3 -c` | 실행 경로가 node 뿐이다 |
| `skills/presentation/README.md` 의 korean-check 검사기 `python3` 안내 | 검사기는 node 로 돈다 |

남길 자리:

| 자리 | 이유 |
| --- | --- |
| `pending` 의 `orch-legacy` 와 orch 의 `.py` 가짜 스크립트 테스트 | orch-cli 의 옛 이름 정리 PR 이 지운다(설계 DECISION14). 설계의 「PR11 에서 빈다」 를 이 사실에 맞게 고친다 |
| `legacy` 옛 이름 진입 셋 | DECISION3·17 |
| `docs/features/`, `docs/adr/`, CHANGELOG 의 `python3` | 기록과 설계 |
| `scripts/runtime-policy.ts` 의 `python3 ` 호출 검사 | 새 호출이 생기지 않게 막는 규칙 |

## 작업 항목

1. 실행기와 그 테스트에서 Python 묶음을 지운다.
2. CI 와 `test-plugin-install` 의 낡은 전제를 지운다.
3. 문서의 `python3` 안내와 설계의 `pending` 설명을 고친다. orch, presentation 변경 이력 조각을 더한다.

## 검증

```bash
node scripts/run-tests.ts
node scripts/runtime-policy.ts --pending
```

종료 코드 0, `PENDING orch-legacy 2` 한 줄. python3 이 없는 PATH 에서는 orch-legacy 에 기대는 orch 테스트 7파일만 실패한다.
