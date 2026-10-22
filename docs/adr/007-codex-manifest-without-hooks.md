# ADR-007: Codex 용 매니페스트를 따로 두고 hook 을 싣지 않는다

- **status**: `accepted`
- **결정**: `.codex-plugin/plugin.json` 을 두고 `.claude-plugin/plugin.json` 과 같은 `name` 과 `skills` 배열만 담는다. `hooks` 와 `version` 은 넣지 않는다.
- **맥락**: Codex 0.163.0 은 플러그인에 `.codex-plugin/plugin.json` 이 없으면 `.claude-plugin/plugin.json` 을 읽고, 그 `hooks` 가 가리키는 명령 hook 을 싣는다.
  Codex 는 새 hook 이나 바뀐 hook 을 실행 전에 신뢰 확인 화면으로 묻는다.
  fdf53e1 이 orch hook 3개를 더한 뒤 Codex 설치본이 2026-10-22 에 316ea9e 로 갱신되자, Codex worker 가 시작 때 「Hooks need review, 3 hooks are new or changed」 에서 멈추고 dispatch 가 failed 가 됐다.
  orch hook 은 Claude Code 의 Bash 호출을 막는 것이라 Codex worker 에는 쓸모가 없다. work-board 의 hooks 모듈도 Codex 는 읽지 못하고 경고만 낸다.
- **실측**: 임시 CODEX_HOME 에서 `codex app-server` 의 `hooks/list`, `skills/list` 로 확인했다.
  - `.claude-plugin` 만 있으면 orch hook 4개가 잡힌다. `hooks` 가 문자열이던 때도 같다
  - `.codex-plugin` 을 더하면 hook 은 0개이고 스킬 8개는 그대로 읽힌다. `skills` 는 배열과 문자열을 모두 받는다
  - `.codex-plugin` 에 `version` 을 넣으면 설치 캐시 경로가 `local/` 에서 버전 폴더로 바뀐다
  - `hooks` 가 없어도 Codex 는 플러그인 루트의 `hooks/hooks.json` 을 기본으로 읽는다. 루트 `hooks/` 에는 `post-commit` 만 둔다
- **대안 기각**:
  - Orca launch 가 hook 확인 화면을 알아보고 대신 승인한다. 신뢰 확인을 에이전트가 대신 하지 않는 원칙(`orch/references/launch.md` 「첫 화면에서 멈춤」)과 부딪치고, Claude 전용 hook 을 Codex 에서 돌리게 된다.
  - Codex 계정 설정에 hook 해시를 미리 신뢰로 적는다. hook 이 바뀔 때마다 다시 적어야 한다.
- **결과**:
  - 얻는 것: Claude 쪽 hook 을 더하거나 고쳐도 Codex worker 의 시작이 막히지 않는다.
  - 감당할 것: 스킬을 더하면 두 매니페스트의 `skills` 배열을 함께 고친다. `scripts/tests/test_plugin_manifest.py` 가 두 배열이 같은지, Codex 쪽에 `hooks` 가 없는지, 루트에 `hooks/hooks.json` 이 없는지 확인한다.
- **전환**: main 에 머지된 뒤 Codex 설치본을 갱신한다. 갱신 전에는 옛 설치본이 그대로 hook 을 싣는다.

  ```bash
  codex plugin marketplace upgrade fos-skills
  ```

  갱신한 뒤 `~/.codex/plugins/cache/fos-skills/fos-skills/local/.codex-plugin/plugin.json` 이 있는지 본다.
  Orca 가 계정별로 두는 Codex 홈(`~/Library/Application Support/orca/codex-accounts/*/home`)도 같은 설치본을 쓰는지 함께 본다.
