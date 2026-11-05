# 스크립트 폴더 이동 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ9 | 이 브랜치의 체크아웃 | `node scripts/run-tests.ts` | 결과 끝 줄의 실패 0. 기존 테스트가 모두 통과한다 | 로컬 node 24, python3 | 없음(앞선 커밋: phase-01, phase-02) | PR 전 |
| REQ9 | 이 브랜치의 체크아웃 | `skills/orch/scripts` 를 `ls` 하고 `node scripts/run-tests.ts skills/orch/tests/script-folders.spec.ts` | 바로 아래는 묶음 폴더, `lib`, `handlers`, `orch-doctor.py`, `ts_shim.py` 뿐이다. 옛 배치 경로 검사가 통과한다 | 로컬 | 없음(앞선 커밋: phase-02) | PR 전 |
| REQ9 | 이 브랜치의 체크아웃, `ORCH_SCRIPTS_DIR=<체크아웃>/skills/orch/scripts` | 옛 꼴 표본 `node skills/orch/bin/orch.ts orch_paths specs`, `node skills/orch/bin/orch.ts --path merge_queue`, `node skills/orch/bin/orch.ts spec-line <임시 지시서>` 와 새 꼴 표본 `orch paths specs`, `orch spec line <임시 지시서>`, `orch queue overlap --help`, `orch doctor --help` | 옛 꼴은 stderr 에 `orch: 새 꼴: …` 한 줄을 내고 지금과 같은 결과다. `--path merge_queue` 가 `…/scripts/queue/merge_queue.ts` 를 낸다. 새 꼴은 종료 코드 0 | 로컬 | 없음(앞선 커밋: phase-01) | PR 전 |
| REQ9 | 이 브랜치의 체크아웃과 폴더 이동 전 배치의 설치본(user 범위) | `ORCH_SCRIPTS_DIR` 없이 `node skills/orch/bin/orch.ts paths specs`, 그리고 `ORCH_SCRIPTS_DIR=<체크아웃>/skills/orch/scripts node <설치본>/skills/orch/bin/orch.ts paths specs` | 앞은 설치본 진입점으로 넘겨 설치본 배치의 스크립트로 같은 경로를 낸다. 뒤는 체크아웃 진입점으로 넘겨 새 배치의 스크립트로 같은 경로를 낸다. 둘 다 종료 코드 0 | 로컬 | 없음(앞선 커밋: phase-01) | PR 전 |
| REQ9 | 이 브랜치의 체크아웃 | 덮어쓰기 환경 변수 없이 `orch worker launch --spec <임시 지시서> --name x --repo <임시 저장소> -- --agent claude --model m` 을 orca 없는 환경에서 부른다 | spec-lint 단계가 돌고(「파일이 없다」 가 아니다) 그 뒤 단계의 실패로 끝난다 | 로컬 | 없음(앞선 커밋: phase-01) | PR 전 |
| REQ9 | ps 명령줄 판정 테스트 | `node scripts/run-tests.ts extensions/work-board/tests/merge-queue.spec.ts skills/orch/tests/orch-loop-auto-merge.spec.ts skills/orch/tests/merge-with-finish.spec.ts` | 통과. `merge_queue.`, `merge-with-finish.` 판정이 새 경로의 프로세스를 가린다(`orch-loop-auto-merge.spec.ts` 의 전체 경로 사례) | 로컬 | 없음(앞선 커밋: phase-01) | PR 전 |
| REQ9 | 임시 저장소의 `.orch/hooks/worker-stalled.ts` 가 `join(ORCH_SCRIPTS, 'nudge-worker.ts')` 를, `.orch/overlay.md` 가 `$SKILL_DIR/scripts/queue/merge-with-finish.ts` 를 부른다 | `orch doctor --skip-version --repo <임시 저장소>`(체크아웃의 진입점) | 두 줄 모두 `DIRECT-PATH <파일>:<줄> <파일 이름>` 과 `새 꼴:` 줄이 나온다 | 로컬 | 없음(앞선 커밋: phase-01) | PR 전 |
| REQ9 | 설치본 | `python3 <설치본>/skills/orch/scripts/orch-doctor.py --skip-version` 와 체크아웃의 `python3 skills/orch/scripts/orch-doctor.py --skip-version` | 둘 다 `doctor/orch-doctor.ts` 로 넘겨(체크아웃) 또는 지금 배치로(설치본) 판정 줄을 내고 이 PR 로 생긴 MISSING 이 없다 | 로컬 | 없음(앞선 커밋: phase-01) | PR 전 |
| REQ9 | 다른 저장소의 직접 경로(스펙 부록) | 코디네이터가 부록의 행을 다시 찾는다 | 모든 행이 새 꼴이다. 이것이 머지 조건이다(스펙 DECISION17) | 코디네이터 | push(코디네이터가 다른 저장소의 고침을 마쳤다) | PR 뒤 |
