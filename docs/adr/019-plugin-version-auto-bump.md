# ADR-019: 플러그인 version 을 두고 main 에 머지될 때마다 GitHub Actions 가 올린다

- **status**: `accepted`
- **결정**: `.claude-plugin/plugin.json` 에 `version`(X.Y.Z)을 둔다. 1.0.0 에서 시작한다.
  main push 마다 `.github/workflows/plugin-version.yml` 이 `scripts/bump-plugin-version.py` 로 version 을 올리고 `.claude-plugin/CHANGELOG.md` 에 한 줄을 더한 커밋을 main 에 push 한다.
  등급은 그 push 범위(push 전 커밋..push 뒤 커밋)에서 바뀐 스킬 CHANGELOG 의 더한 줄로 정한다. `- 호환성:` 줄이 있으면 major, 새 버전 절(`## X.Y.Z (날짜)`)이 있으면 minor, 그 밖은 patch 다.
  CHANGELOG 줄은 「orch 5.16.0, work-board 1.5.0 (#286)」 처럼 새 스킬 버전과 PR 번호다. 스킬 버전이 없으면 「바뀐 곳: docs, scripts (#287)」 다.
  push 범위가 version 을 이미 바꿨으면 올리지 않는다. 사람이 직접 정한 version 이 우선한다.
  마켓플레이스 항목과 `.codex-plugin/plugin.json` 에는 version 을 쓰지 않는다.
  [ADR-002](superseded/002-plugin-version-is-commit-sha.md) 를 대체한다. 사용자 결정 2026-11-02.
- **맥락**: 사용자가 보드에서 설치본과 main 의 버전을 비교하고 싶어 했다. 커밋 SHA 12자리는 어느 쪽이 새것인지 읽히지 않는다.
  version 을 두면 그 문자열이 바뀌어야 `claude plugin update` 가 새 복사본을 받는다([ADR-002](superseded/002-plugin-version-is-commit-sha.md) 의 2026-10-01 실측). 사람이 올리면 빠뜨린 머지가 설치한 쪽에 가지 않는다.
  main 에는 보호 규칙이 없고, 여러 worker 의 PR 이 동시에 열리며, 외부 기여자 PR 은 GitHub 화면에서 머지된다.
- **대안 기각**:
  - orch 자동 머지 도구가 머지 직후 올린다. GitHub 화면과 외부 기여자의 머지가 빠진다.
  - PR 에서 올리고 CI 가 올리지 않은 PR 을 막는다. 동시에 열린 PR 끼리 같은 줄에서 충돌해 머지할 때마다 다시 올려야 한다.
  - version 을 두지 않고 커밋 SHA 를 버전으로 쓴다([ADR-002](superseded/002-plugin-version-is-commit-sha.md)). 버전을 사람이 읽고 비교할 수 없다.
- **결과**:
  - 얻는 것: 설치본과 main 의 버전을 「1.4.0」 처럼 읽고 비교한다. 보드가 이 값으로 최신 여부를 정한다.
  - 얻는 것: 누가 어디서 머지해도 version 이 오른다. PR 끼리 version 줄로 충돌하지 않는다.
  - 감당할 것: main 에 머지마다 봇 커밋이 하나씩 생긴다. GITHUB_TOKEN 으로 push 해 CI 와 이 workflow 가 다시 돌지 않는다.
  - 감당할 것: workflow 가 실패하면 그 머지는 version 이 오르지 않아 `update` 가 받지 않는다. 다음 머지가 올리면 함께 받는다.
  - 감당할 것: 설치 캐시 폴더 이름이 커밋 SHA 대신 version 이 된다. `claude plugin validate` 의 version 경고가 없어진다.
  - 감당할 것: main 에 보호 규칙을 걸면 봇의 push 를 허용해야 한다.
- **적용 범위**: 스킬 버전과 CHANGELOG 절을 머지 때 조각으로 정하는 규칙은 [ADR-023](023-version-at-merge.md) 이 소유한다. 스킬 버전의 등급 기준과 CHANGELOG 형식은 저장소 README 「버전과 변경 이력」 이 소유한다. 갱신 순서는 [flow.md](../flow.md) 가 소유한다.
