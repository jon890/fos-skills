# ADR 목록

결정이 필요하면 이 목록을 먼저 읽고 필요한 파일만 연다. 이 파일은 plan 스킬의 `adr-docs.ts write-index` 가 만든다. 직접 고치지 않는다.

## 현행

| 번호 | 결정 | 상태 | 대체 관계 |
| --- | --- | --- | --- |
| [ADR-003](003-export-only-skills.md) | 내보내기 전용 원본을 플러그인 스킬 목록에서 제외한다 | accepted | - |
| [ADR-004](004-no-plugin-bin.md) | 루트 bin/ 에는 orch 실행기 하나만 두고, 공용 도구의 PATH 명령은 두지 않는다 | accepted | - |
| [ADR-005](005-plugin-hooks-under-skill.md) | 플러그인 훅 정의는 그 훅을 소유한 스킬 아래에 두고 매니페스트로 가리킨다 | accepted | - |
| [ADR-006](006-work-board-in-plugin.md) | 작업 현황 창(work-board)을 이 플러그인의 구성 요소로 넣는다 | accepted | - |
| [ADR-007](007-codex-manifest-without-hooks.md) | Codex 용 매니페스트를 따로 두고 hook 을 넣지 않는다 | accepted | - |
| [ADR-008](008-orch-own-dir.md) | orch 는 자기 작업 폴더 `.orch/` 를 갖고 `.omc` 에 기대지 않는다 | accepted | - |
| [ADR-009](009-orch-event-handlers.md) | orch 는 단계마다 이벤트를 내고, 저장소 고유 일은 저장소의 이벤트 핸들러가 맡는다 | accepted | - |
| [ADR-010](010-orch-typescript.md) | orch 와 work-board 의 Python 스크립트를 빌드 없는 TypeScript 로 한 번에 옮긴다 | accepted | [ADR-011](011-node-24-minimum.md), [ADR-030](030-plugin-npm-dependencies.md) |
| [ADR-011](011-node-24-minimum.md) | orch 와 work-board 의 최소 Node 를 24 로 올린다 | accepted | - |
| [ADR-012](012-orch-loop-multi-run.md) | 상주 루프는 저장소마다 하나로 두고 여러 Run 을 맡는다 | accepted | [ADR-027](027-orca-message-wake.md) |
| [ADR-013](013-orch-worker-stalled.md) | 상주 루프는 멈춘 worker 를 이벤트로 알리고, 다시 시도시키는 일은 저장소 핸들러가 맡는다 | accepted | [ADR-027](027-orca-message-wake.md) |
| [ADR-014](014-orch-auto-last-pr.md) | 업무의 마지막 PR 은 마무리가 머지와 배포 뒤에 판정하고, 충돌한 PR 은 머지 큐를 멈추지 않는다 | accepted | - |
| [ADR-015](015-board-decide-clear.md) | 보드의 결정 필요는 남은 줄과 남은 질문만 세고, 중간 과정은 보드 항목을 만들지 않는다 | accepted | - |
| [ADR-016](016-orch-auto-merge.md) | 상주 루프가 머지할 수 있는 PR 을 스스로 머지 큐에 건다 | accepted | - |
| [ADR-017](017-orch-migration-reserve.md) | 마이그레이션 번호는 worker 가 만들기 전에 잠금을 걸고 예약한다 | accepted | - |
| [ADR-018](018-board-milestone-steps.md) | 보드 단계는 사건 꼬리표가 붙은 마일스톤이고, 스크립트가 PR, 머지, 배포, 릴리스로 끝낸다 | accepted | - |
| [ADR-019](019-plugin-version-auto-bump.md) | 플러그인 version 을 두고 main 에 머지될 때마다 GitHub Actions 가 올린다 | accepted | - |
| [ADR-020](020-orch-loop-refresh.md) | 상주 루프가 뒤처진 PR 의 최신화를 머지 차례 전에 PR 마다 걸고, 머지는 머지 큐가 하나씩 한다 | accepted | - |
| [ADR-021](021-skill-directory-layout.md) | 스킬 원본과 저장소 관리 영역을 나눈다 | accepted | - |
| [ADR-022](022-extension-directory-layout.md) | 보드를 확장 기능 디렉터리에 둔다 | accepted | - |
| [ADR-023](023-version-at-merge.md) | 스킬 버전과 CHANGELOG 절은 PR 이 아니라 머지 때 정한다 | accepted | - |
| [ADR-024](024-decision-record-classification.md) | 결정 기록은 종류를 나누고 현재 규칙의 원본을 연결한다 | accepted | - |
| [ADR-025](025-script-runtime-typescript.md) | 저장소의 스크립트와 테스트를 TypeScript(Node 24) 하나로 둔다 | accepted | [ADR-030](030-plugin-npm-dependencies.md) |
| [ADR-026](026-docs-checks-at-authoring-time.md) | 문서 링크와 ADR 검사는 plan 번들 검사기 하나가 작성 단계에서 맡는다 | accepted | - |
| [ADR-027](027-orca-message-wake.md) | 코디네이터 깨우기는 Orca 메시지를 쓴다 | accepted | - |
| [ADR-028](028-orch-core-layer.md) | 값 판정과 외부 실행을 폴더로 나눈다 | accepted | - |
| [ADR-029](029-board-write-lock.md) | 보드 쓰기는 `board.ts` 의 파일 잠금을 지나고, 통째 저장은 읽을 때의 줄 지문으로 거절한다 | accepted | - |
| [ADR-030](030-plugin-npm-dependencies.md) | 플러그인 루트의 package.json 으로 npm 의존을 두고 설치는 Claude Code 에 맡긴다 | accepted | - |
| [ADR-031](031-board-task-adapter.md) | 업무 도구 어댑터는 orch 가 갖고, 보드는 업무 번호와 주소만 저장한다 | accepted | - |
| [ADR-032](032-loop-bundle-handover.md) | 옛 번들의 상주 루프는 잠금 파일을 새 루프의 pid 로 바꿔 넘기고, 새 루프가 상태를 쓴 뒤에 끝난다 | accepted | - |
| [ADR-033](033-board-item-worker-rows.md) | 보드 항목은 worker 줄 목록을 갖고, 후속 PR 의 사건 단계는 그 줄이 갖는다 | accepted | - |

## 대체됨

| 번호 | 결정 | 상태 | 대체 관계 |
| --- | --- | --- | --- |
| [ADR-001](superseded/001-plugin-from-repo-root.md) | 저장소 루트를 플러그인으로 삼고 스킬 디렉터리는 옮기지 않는다 | superseded | [ADR-021](021-skill-directory-layout.md) |
| [ADR-002](superseded/002-plugin-version-is-commit-sha.md) | 플러그인 버전을 쓰지 않고 커밋 SHA 를 버전으로 삼는다 | superseded | [ADR-019](019-plugin-version-auto-bump.md) |
