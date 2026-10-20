# ADR-005: 플러그인 훅 정의는 그 훅을 소유한 스킬 아래에 두고 매니페스트로 가리킨다

- **status**: `accepted`
- **결정**: 플러그인이 싣는 Claude Code 훅의 정의 파일은 그 훅이 지키는 절차를 가진 스킬 아래(`<스킬>/hooks/hooks.json`)에 둔다.
  `.claude-plugin/plugin.json` 의 `hooks` 필드가 그 파일을 가리킨다. 첫 훅은 orch 의 `check --wait` 백그라운드 실행 차단이다.
- **맥락**: Claude Code 는 플러그인 루트의 `hooks/hooks.json` 을 기본 훅 정의로 읽는다.
  이 저장소는 루트를 플러그인으로 싣고([ADR-001](001-plugin-from-repo-root.md)), 루트 `hooks/` 는 git 훅(`post-commit`)의 자리다.
  [code-architecture.md](../code-architecture.md) 의 「다음 차수」 가 훅 정의를 `hooks/` 와 다른 경로에 두라고 정해 두었다.
  orch 의 `references/waiting.md` 는 `orca orchestration check --wait` 를 셸의 `&` 로 띄우지 말라고 산문으로 적었지만, 코디네이터가 두 번 `&` 로 띄워 완료 알림을 받지 못했다.
  산문으로는 막히지 않아 명령 단계에서 거부하는 PreToolUse 훅이 필요해졌다.
  2026-10-20 에 `claude --plugin-dir <작업 트리> -p` 세션에서 그 명령을 실행하게 해 보니 이 배치의 훅이 발화해 거부했다.
  `claude plugin validate` 도 `hooks` 필드를 오류 없이 받았다.
- **대안 기각**:
  - 루트 `hooks/hooks.json` 에 둔다. 매니페스트를 고치지 않아도 되지만 git 훅과 Claude Code 훅이 한 폴더에 섞이고, `scripts/install-hooks.sh` 가 그 파일을 git 훅으로 오해할 여지가 생긴다.
  - 저장소마다 `.claude/settings.json` 에 훅을 넣는다. orch 를 쓰는 저장소마다 같은 줄을 복사해야 하고, 빠뜨린 저장소에서는 다시 막히지 않는다.
- **결과**:
  - 얻는 것: 플러그인을 설치하면 모든 세션에서 훅이 켜진다. 훅 코드와 그 근거 문서가 같은 스킬 안에 있다.
  - 감당할 것: 훅은 이 플러그인을 켠 모든 세션의 Bash 호출마다 돈다. 그래서 판정 대상이 아닌 명령은 출력 없이 통과시키고, 입력을 읽지 못해도 통과시킨다.
  - 감당할 것: 둘째 훅을 더할 때 `hooks` 필드는 파일 하나만 가리키므로 같은 파일에 더하거나 배열로 바꾼다.
- **적용 범위**: 훅의 판정 규칙은 각 훅 스크립트의 머리 주석이 소유한다.
