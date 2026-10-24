# ADR 목록

- [ADR-001](001-plugin-from-repo-root.md): 저장소 루트를 플러그인으로 삼고 스킬 디렉터리는 옮기지 않는다 (`accepted`)
- [ADR-002](002-plugin-version-is-commit-sha.md): 플러그인 버전을 쓰지 않고 커밋 SHA 를 버전으로 삼는다 (`accepted`)
- [ADR-003](003-export-only-skills.md): 내보내기 전용 원본을 플러그인 스킬 목록에서 제외한다 (`accepted`)
- [ADR-004](004-no-plugin-bin.md): 공용 도구의 PATH 명령은 이 플러그인에 두지 않는다 (`accepted`)
- [ADR-005](005-plugin-hooks-under-skill.md): 플러그인 훅 정의는 그 훅을 소유한 스킬 아래에 두고 매니페스트로 가리킨다 (`accepted`)
- [ADR-006](006-work-board-in-plugin.md): 작업 현황 창(work-board)을 이 플러그인의 구성 요소로 싣는다 (`accepted`)
- [ADR-007](007-codex-manifest-without-hooks.md): Codex 용 매니페스트를 따로 두고 hook 을 싣지 않는다 (`accepted`)
- [ADR-008](008-orch-own-dir.md): orch 는 자기 작업 폴더 `.orch/` 를 갖고 `.omc` 에 기대지 않는다 (`accepted`)
- [ADR-009](009-orch-event-handlers.md): orch 는 단계마다 이벤트를 내고, 저장소 고유 일은 저장소의 이벤트 핸들러가 맡는다 (`accepted`)
- [ADR-010](010-orch-typescript.md): orch 와 work-board 의 Python 스크립트를 빌드 없는 TypeScript 로 한 번에 옮긴다 (`accepted`)
