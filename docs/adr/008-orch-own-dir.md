# ADR-008: orch 는 자기 작업 폴더 `.orch/` 를 갖고 `.omc` 에 기대지 않는다

- **status**: `accepted`
- **결정**: orch 스킬의 지시서, 머지 큐 출력, 대기 기록, 저장소 포장 스크립트, 저장소 설정을 주 checkout 의 `.orch/` 아래에 둔다. 워크트리에서 불러도 같은 폴더다.
  경로는 `orch/scripts/lib/paths.ts` 한 곳이 정하고, 루트는 `ORCH_DIR` 환경 변수로 바꾼다.
  옛 위치(`.omc/handoffs/`, `.omc/orch/`, `.claude/orch-overlay.md`, `.claude/orch-finish.json`)는 `orch/bin/orch.ts migrate-orch-dir` 가 한 번 옮기고, 스크립트는 옛 위치를 찾지 않는다.
  사용자 결정 2026-10-23.
- **맥락**: `.omc` 는 oh-my-claudecode 의 폴더다. orch 는 그 아래 `handoffs/`, `state/` 에 자기 파일을 두었다.
  oh-my-claudecode 가 없는 환경에서는 경로 관례가 어색했고, `handoff-cleanup.py` 가 `.omc` 전체를 훑어 다른 도구의 파일까지 정리 후보로 삼았다.
  저장소 설정도 사람이 읽는 규칙은 `.claude/orch-overlay.md`, 스크립트가 읽는 값은 `.claude/orch-finish.json` 으로 흩어져 있었다.
  스크립트마다 `.omc/handoffs/board.json` 과 `.omc/board.json` 을 차례로 찾는 분기를 따로 가졌다.
- **대안 기각**:
  - `.omc/orch/` 를 표준으로 굳힌다. 폴더 이름만 정리될 뿐 oh-my-claudecode 에 기대는 문제가 그대로다.
  - 스크립트마다 새 위치가 없으면 옛 위치를 읽는다. 옮긴 뒤에도 분기가 남고, 두 위치에 파일이 함께 생기면 어느 쪽이 맞는지 알 수 없다.
  - 설정 이름을 `.orch/AGENTS.md` 로 한다. Codex 같은 에이전트가 그 폴더의 일반 지침으로 읽는 관례와 겹친다.
  - 보드(`board.json`)도 `.orch/` 로 옮긴다. 보드는 사용자의 업무 보드라 work-board 가 소유한다. orch 는 설정의 `board` 값이나 work-board 의 기본 위치를 받기만 한다.
  - 미리보기 폴더(`.omc/previews/`)를 orch 가 계속 정리한다. 미리보기는 content-preview 의 산출물이라 `bin/orch.ts handoff-cleanup` 은 설정으로 폴더를 줄 때만 본다.
- **결과**:
  - 얻는 것: oh-my-claudecode 가 없는 저장소에서도 orch 스크립트가 같은 경로로 돈다. 정리 스크립트는 `.orch` 와 설정이 지정한 폴더만 건드린다.
  - 얻는 것: 저장소 설정이 `.orch/overlay.md` 와 `.orch/config.json` 두 파일로 모인다.
  - 감당할 것: 쓰던 저장소는 머지 큐와 worker 가 돌지 않을 때 `migrate-orch-dir.ts --apply` 를 한 번 돌려야 한다. 옮기기 전에는 스크립트가 옛 위치의 설정과 지시서를 읽지 않는다.
  - 감당할 것: `.orch/` 는 스크립트가 `.git/info/exclude` 에 더해 git 이 무시한다. 오버레이와 설정을 저장소에 커밋하려면 `git add -f` 로 추적한다.
  - 감당할 것: 저장소 코드나 옮긴 포장 스크립트가 옛 경로를 직접 적은 곳은 옮기는 스크립트가 보이기만 하고 고치지 않는다. 그 저장소가 고친다.
- **적용 범위**: 폴더 구조와 옮기는 방법은 [`orch/references/overlay.md`](../../orch/references/overlay.md) 가 소유한다.
