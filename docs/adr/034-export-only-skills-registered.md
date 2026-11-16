# ADR-034: 내보내기 원본 폴더의 두 스킬도 플러그인 스킬 목록에 등록한다

- **status**: `accepted`
- **decision-type**: `architecture`
- **areas**: `plugin`
- **결정**: `export-only-skills/content-preview` 와 `export-only-skills/korean-check` 를 `.claude-plugin/plugin.json` 과 `.codex-plugin/plugin.json` 의 `skills` 배열에 등록한다. 폴더는 옮기지 않는다. 제외 목록 `scripts/export-only-skills.json` 과 그 목록을 읽던 테스트 분기는 없앤다. 팀 저장소 내보내기(`scripts/export-to-team.ts`)는 이 목록을 읽지 않아 그대로 동작한다.
- **맥락**: 개인 맥에는 팀 저장소의 플러그인을 설치할 수 없어서, 이 플러그인에서 두 스킬이 보이지 않으면 `content-preview` 를 쓸 수 없었다([ADR-003](superseded/003-export-only-skills.md) 의 결과에 적힌 제약).
  `content-preview` 는 `../korean-check` 를 상대 경로로 읽는다. 두 폴더가 같은 `export-only-skills/` 아래에 있어 폴더를 그대로 두면 경로가 깨지지 않는다.
- **대안 기각**:
  - 두 폴더를 `skills/` 로 옮긴다. 배열은 같아지지만 내보내기 원본 경로, 형제 참조, 개인 링크를 함께 고쳐야 해서 변경이 크다.
  - 제외 목록을 비워 둔 채 남긴다. 쓰지 않는 분기와 테스트가 남는다.
- **결과**:
  - 얻는 것: 이 플러그인만 설치해도 `fos-skills:content-preview` 와 `fos-skills:korean-check` 가 뜬다.
  - 감당할 것: 팀 저장소의 플러그인도 설치한 환경에서는 같은 스킬이 접두사만 다르게 두 번 뜬다.
- **확인 방법**: `scripts/tests/plugin-manifest.spec.ts` 와 `scripts/test-plugin-install.ts` 의 스킬 인식 검사.
