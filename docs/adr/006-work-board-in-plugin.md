# ADR-006: 작업 현황 창(work-board)을 이 플러그인의 구성 요소로 싣는다

- **status**: `accepted`
- **결정**: `~/.claude/mods/work-board` 에 있던 mod 를 저장소 루트의 `work-board/` 로 옮기고, `.claude-plugin/plugin.json` 의 `hooks` 배열에 `./work-board/hooks/hooks.json` 을 더한다.
  별도 플러그인으로 나누지 않는다. 사용자 결정 2026-10-22.
- **맥락**: orch 의 `board-sync.py`, `finish-pr.py`, `goal-progress.py` 는 보드를 고칠 때 mod 의 `bin/board.py` 를 부른다.
  mod 는 홈 폴더 저장소에, orch 는 이 저장소에 있어 두 쪽이 따로 버전을 갖고, 진행률 규칙처럼 함께 바뀌어야 하는 변경을 한 PR 로 낼 수 없었다.
  orch 스크립트는 board.py 를 `~/.claude/mods/work-board/bin/board.py` 라는 홈 폴더 고정 경로로 찾았다.
- **대안 기각**:
  - 같은 marketplace 에 `work-board` 플러그인을 따로 둔다. 창만 따로 끌 수 있지만, 설치 캐시 경로(`cache/fos-skills/work-board/<버전>/`)에 버전이 들어가 orch 스크립트가 board.py 를 찾을 고정 경로가 없다.
  - 홈 폴더의 mod 로 남긴다. 위의 버전 문제가 그대로 남는다.
- **결과**:
  - 얻는 것: orch 스크립트가 board.py 를 자기 위치 기준 상대 경로로 찾는다. 체크아웃과 설치 캐시에서 같은 코드로 돌고, 창과 orch 가 같은 커밋으로 묶인다.
  - 얻는 것: `claude plugin validate .` 가 명령 훅과 mod 모듈을 한 플러그인에서 함께 받는다. mod 테스트는 저장소 루트의 `claude plugin test .` 로 돈다.
  - 감당할 것: 창을 고친 결과는 main 머지와 `claude plugin update` 뒤에 보인다. 고치는 동안은 `claude --plugin-dir` 로 작업 트리를 싣는다.
  - 감당할 것: 창만 끄려면 플러그인 전체를 꺼야 한다.
  - `work-board/bin/` 은 플러그인 루트의 `bin/` 이 아니므로 PATH 에 실리지 않는다. [ADR-004](004-no-plugin-bin.md) 와 부딪치지 않는다.
- **전환**: 기존 mod 와 `/board` 명령 이름이 겹친다. 이 결정을 담은 커밋을 받은 뒤 기존 mod 를 끄고, 홈 폴더 저장소에서 `~/.claude/mods/work-board` 를 지운다.

  ```bash
  claude plugin update fos-skills@fos-skills
  claude plugin uninstall work-board@local-mods --scope user
  claude plugin uninstall work-board@local-mods --scope project
  ```

  `local-mods` marketplace 에 다른 mod 가 없으면 `claude plugin marketplace remove local-mods` 로 함께 지운다.
  board.json 의 위치와 형식은 바뀌지 않는다.
- **적용 범위**: 창의 동작과 보드 명령은 [`work-board/README.md`](../../work-board/README.md) 가 소유한다.
