# ADR-036: worker 의 한국어 표기 검사는 워크트리에 건 git 커밋 훅으로 한다

- **status**: `accepted`
- **decision-type**: `architecture`
- **areas**: `orch, korean-check`
- **현재 규칙의 원본**: `skills/orch/scripts/lib/commit-check.ts`, `skills/orch/githooks/dispatch.mjs`, `export-only-skills/korean-check/scripts/check-diff.ts` 의 머리 주석. 요구사항은 [orch 단일 worker 스펙](../features/orch-single-worker/spec.md)의 REQ1 이다.
- **결정**: worker 가 커밋하는 한국어 문서의 금지어 검사는 에이전트의 hook 이 아니라 git 의 `pre-commit` 훅으로 한다. `launch-worker` 가 worker 를 띄울 때 그 워크트리에만 걸리는 `core.hooksPath` 를 두고, 훅은 korean-check 의 `check.ts --staged` 로 스테이징한 `.md` 의 더한 줄을 본다. Codex 매니페스트에는 계속 hook 을 넣지 않는다. [ADR-007](007-codex-manifest-without-hooks.md) 은 그대로 유효하다.
- **맥락**: 문서가 주 산출물인 일도 Codex worker 에게 맡기려면 Codex 가 쓴 한국어 문서도 금지어 검사를 받아야 한다(스펙 DECISION5).
  Claude worker 는 편집 직후 도는 hook 으로 검사받지만, Codex 는 [ADR-007](007-codex-manifest-without-hooks.md) 에서 hook 을 뺐다.
  2026-11-17 Codex 문서 기준으로 관리 정책이 아닌 hook 은 실행 전에 신뢰 확인을 받아야 하고, 플러그인 hook 은 정의가 같아도 번들의 스크립트가 바뀌면 다시 확인받는다.
  이 플러그인은 main 에 머지될 때마다 버전이 오르고 스크립트가 바뀐다. 확인을 건너뛰는 실행 인자는 Orca 의 `worker-start` 로 넘길 수 없다.
  검사는 이 저장소뿐 아니라 orch 로 worker 를 띄우는 다른 저장소에도 걸려야 한다.
- **대안 기각**:
  - Codex 매니페스트에 `PreToolUse` hook 을 넣어 `git commit` 을 막는다. 갱신할 때마다 신뢰 확인 화면에서 worker 가 멈춘다([ADR-007](007-codex-manifest-without-hooks.md) 의 2026-10-22 장애와 같다). 셸 명령 글자에서 커밋을 알아봐야 해서 스크립트 안의 커밋이나 `cd` 뒤의 커밋을 놓친다.
  - Codex 계정 설정에 hook 을 미리 신뢰로 적는다. [ADR-007](007-codex-manifest-without-hooks.md) 이 기각했다. 신뢰 확인을 에이전트가 대신 하지 않는다는 원칙과 부딪친다.
  - worker 의 환경 변수(`GIT_CONFIG_*`)로 훅 폴더를 넘긴다. Codex 의 `shell_environment_policy` 가 환경 변수를 빼면 조용히 꺼진다. 같은 이유로 `core.sshCommand` 도 설정 파일에 뒀다.
  - 공유 `.git/hooks` 나 공유 설정의 `core.hooksPath` 에 건다. 주 checkout 에서 사용자가 하는 커밋까지 바뀌고, 저장소가 이미 쓰는 훅 폴더(husky)와 부딪친다.
  - 커밋이 아니라 PR 준비 단계(`orch queue gate`)에서 검사한다. 스펙 REQ1 이 커밋 거절을 정했고, 늦게 걸릴수록 이력을 고쳐 써야 한다.
  - 지시서로 worker 가 커밋 전에 검사기를 직접 돌리게 한다. 지금 공통 지시서가 그렇게 시키지만 강제할 수 없어 빠뜨린 커밋이 그대로 올라간다.
  - 훅이 플러그인 번들의 검사기를 직접 부른다. 설치 경로에 버전이 들어 있어 갱신 뒤 경로가 없어지면 검사가 조용히 꺼진다. 그래서 워크트리 훅 폴더에 사본을 둔다.
- **결과**:
  - 얻는 것: 에이전트 종류와 파일을 만든 방법(편집 도구, 셸, 스크립트)에 상관없이 커밋되는 한국어 문서가 같은 검사를 받는다. Codex 의 신뢰 확인 화면이 뜨지 않는다. 다른 저장소에도 설정 없이 걸린다.
  - 감당할 것: worker 워크트리에서는 훅 폴더가 바뀌므로 저장소의 기존 훅을 훅 본체가 이어 불러야 한다. 이어 부르는 훅 이름은 정해 둔 목록뿐이다. 대상 저장소의 공유 설정에 `extensions.worktreeConfig` 가 켜진다. 검사기 사본은 워크트리를 만든 때의 규칙이라 오래 둔 워크트리는 새 금지어를 모른다. `--no-verify` 는 막지 못한다. 훅이 node 로 돌아 PATH 에 node 가 없는 프로세스가 그 워크트리에서 git 을 부르면 실패한다. `git rev-parse --git-path hooks` 가 새 훅 폴더를 가리켜, 그 값으로 훅을 설치하는 도구가 worker 워크트리에서 설치를 돌리면 검사가 꺼지거나 설치가 거부될 수 있다.
- **확인 방법**: `skills/orch/tests/lib-commit-check.spec.ts` 가 임시 저장소의 연결된 워크트리에서 실제 커밋으로 거절, 통과, 기존 훅 이어 부르기를 본다. `export-only-skills/korean-check/tests/check-diff.spec.ts` 가 `--staged` 의 판정을 본다.
