# Phase 01. 업무 도구 어댑터와 `board.task` 설정

**Execution profile**: standard

## 목표

설정 `board.task` 로 어댑터(`dooray`, `url-template`)를 고르고, 번호 맞추기·주소 만들기를 core 와 lib 의 어댑터 모듈이 맡게 한다. `orch config set` 과 `orch doctor` 가 같은 기준으로 틀린 설정을 거절한다.

**범위 외**: 보드 칸과 `orch board set`(phase 02), 어댑터를 부르는 쪽(phase 03~06).

## 컨텍스트

**요구사항**: REQ3, REQ8(설정 문서 몫)

**근거 문서**: `docs/features/board-task-link/spec.md` REQ3·DECISION7·DECISION10·DECISION15·DECISION16·DECISION17·DECISION19, `docs/features/board-task-link/design.md` 「설정 `board.task`」·「core 어댑터」·「lib 어댑터」, `docs/adr/031-board-task-adapter.md`, `docs/adr/028-orch-core-layer.md`

- 값 판정은 `skills/orch/scripts/core/`, 파일과 외부 명령은 `skills/orch/scripts/lib/` 가 맡는다. core 는 core 안의 상대 모듈과 `node:path`, `node:crypto` 만 import 한다(`skills/orch/tests/core-boundary.spec.ts`).
- `board` 절의 아는 키는 `skills/orch/scripts/core/config.ts` 의 `BOARD_KEYS` 다. `section(config, 'board', BOARD_KEYS)` 가 모르는 키를 `ConfigError` 로 거절한다. `boardSettingsFromConfig`(`core/milestones.ts`)는 `task` 를 읽지 않는다.
- 검사표는 `skills/orch/scripts/core/config-schema.ts` 의 `KEYS` 다. `board` 의 다른 키는 `viaConfig('board', <키>, <판정>)`(140행) 꼴이다. `names` 인자가 `knownPath` 의 아래 이름을 정한다.
- 키별 표본은 `skills/orch/tests/fixtures/config-samples.ts` 다. `core-config-schema.spec.ts` 가 검사표의 모든 키가 표본에 있는지, `config-schema-readers.spec.ts` 가 good 값을 읽는 쪽이 받는지 본다.
- 설정 문서 검사 `skills/orch/tests/config-docs.spec.ts` 가 `skills/orch/references/overlay.md` 와 `docs/data-schema.md` 의 키 표를 본다.
- `dooray` CLI 의 업무 조회는 `dooray --json post get <프로젝트> <번호>` 다. inbox 스킬(`skills/inbox/scripts/adapters/dooray.ts` 84-91, 118-120행)이 같은 CLI 를 `--json` 을 앞에 두고 부르고, 주소를 `<webUrl>/project/tasks/<postId>` 로 만든다. inbox 스킬은 import 하지 않는다(ADR-031).
- 외부 명령은 `skills/orch/scripts/lib/proc.ts` 의 `run(command, { timeoutMs })` 로 부른다.

## 의도 메모

- 새 최상위 절을 만들지 않는다(설계 DECISION1). 옛 번들이 모르는 절 때문에 설정 전체를 거절하는 범위를 `board` 절 하나로 줄인다.
- `taskAdapterOf` 는 판정 하나가 소유한다. 검사표는 이 함수를 감싸기만 한다. 같은 기준을 두 곳에 두지 않는다.
- `dooray` 의 `project` 는 필수, `url-template` 의 `name` 은 선택이다(설계 DECISION9).

## 작업 항목

### 1. `skills/orch/scripts/core/task-adapters.ts`(신규)

- 타입 `TaskAdapter = { kind: 'dooray'; name: '두레이'; host: string; webUrl: string; project: string } | { kind: 'url-template'; name: string; host: string; url: string }`.
- `taskAdapterOf(config: Config): TaskAdapter | null`. `section(config, 'board', BOARD_KEYS).task` 를 읽는다. 없으면 `null`. 객체가 아니거나, `adapter` 가 `TASK_ADAPTERS` 의 이름이 아니거나, 그 어댑터의 필수 키가 빠졌거나 틀렸거나, 그 어댑터의 키가 아닌 키가 있으면 `ConfigError`(`core/config.ts`)다. 메시지는 `설정 파일의 board.task.<키> …` 꼴이다. `web_url` 과 `url` 은 `http`·`https` 로 시작하고 `new URL` 로 호스트를 읽을 수 있어야 한다. `url` 에는 `{number}` 가 있어야 한다. `web_url` 끝의 `/` 는 뗀다.
- `TASK_ADAPTER_KEYS: Record<'dooray' | 'url-template', readonly string[]>`: `dooray` 는 `adapter`, `web_url`, `project`, `url-template` 은 `adapter`, `url`, `name`.
- `normalizeRef(adapter, ref)`: `dooray` 이고 `ref` 에 `/` 가 없으면 `${project}/${ref}`. 나머지는 그대로.
- `urlFromLine(adapter, line)`: 아래 정규식으로 주소를 찾고, 호스트가 `adapter.host` 와 같은 첫 주소. 끝의 `.`·`,` 는 뗀다. 어댑터가 `null` 이면 `null`.

  ```text
  /https?:\/\/[^\s<>()「」`'"]+/g
  ```

- `templateUrl(adapter, ref)`: `{number}` 를 모두 `encodeURIComponent(ref).replaceAll('%2F', '/')` 로 바꾼다.
- `doorayParts(ref)`: 마지막 `/` 로 나눠 `{ project, number }`. 프로젝트가 비었거나 번호가 `^\d+$` 가 아니면 `null`.
- 파일 맨 위 설명에 내보내는 것과 어댑터를 더하는 법(표의 줄 하나, lib 의 주소 만들기 하나)을 적는다.

### 2. `skills/orch/scripts/core/config.ts`

`BOARD_KEYS` 에 `'task'` 를 더한다. 위 설명 줄에 `task` 는 `core/task-adapters.ts` 의 `taskAdapterOf` 가 판정한다고 적는다.

### 3. `skills/orch/scripts/core/config-schema.ts`

`KEYS.board.task = viaConfig('board', 'task', taskAdapterOf, ['adapter', 'web_url', 'project', 'url', 'name'])`. `RESTART_KEYS` 에 `'board.task'` 를 더한다. 설치 전에 띄운 옛 번들 루프가 이 키를 모르는 키로 거절하므로 `orch config set` 이 루프 재시작을 안내하게 한다(설계 「호환과 배포 순서」).

### 4. `skills/orch/scripts/lib/task-adapters.ts`(신규)

- `taskAdapter(repo: string): TaskAdapter | null`: `loadConfig(repo)`(`lib/config.ts`) 뒤 `taskAdapterOf`. `ConfigError` 는 던진다.
- `resolveTaskUrl(adapter: TaskAdapter, ref: string, opts?: { dooray?: string }): Promise<string>`: `url-template` 은 `templateUrl`. `dooray` 는 `doorayParts` 가 `null` 이면 `Error('업무 번호를 프로젝트와 번호로 나누지 못했다: <ref>')`. 아니면 `runAsync([opts?.dooray ?? process.env.DOORAY_BIN ?? 'dooray', '--json', 'post', 'get', project, number], { timeoutMs: 15000 })`(`lib/proc.ts`. 동기 `run` 은 TERM 을 무시하는 자식에서 제한을 지키지 못한다). 종료 코드 127(명령 없음)이면 `Error('dooray 명령을 찾지 못했다')`, 그 밖의 실패면 `Error('dooray post get: <stderr 나 stdout 의 첫 줄>')`. 응답 JSON 의 `id` 가 비지 않은 문자열이나 수가 아니면 `Error('dooray post get: 응답에 id 가 없다')`. 맞으면 `${webUrl}/project/tasks/${id}`.
- `DOORAY_BIN` 은 테스트용이라고 파일 맨 위 설명에 적는다.

### 5. `skills/orch/tests/core-task-adapters.spec.ts`(신규)

- `taskAdapterOf`: 두 어댑터의 good 설정, 절 없음(`null`), 모르는 어댑터, `dooray` 에 `project` 없음, `url-template` 에 `{number}` 없는 `url`, `dooray` 에 `url` 키, `ftp://` 주소가 모두 기대대로다.
- `normalizeRef`: `458` → `<project>/458`, `X/458` 그대로, `url-template` 과 `null` 그대로.
- `urlFromLine`: `두레이 업무: X/458 https://<호스트>/project/tasks/1 https://<호스트>/wiki/2` 에서 첫 업무 주소, 다른 호스트만 있는 줄은 `null`, 어댑터 `null` 은 `null`.
- `templateUrl`: `PROJ-12` 와 `X/458` 의 결과.
- `doorayParts`: `AI-스마트홈-AI/458`, `458`, `X/abc`.

### 6. `skills/orch/tests/lib-task-adapters.spec.ts`(신규)

임시 폴더에 가짜 `dooray` 실행 파일을 두고 `DOORAY_BIN` 으로 가리킨다. 성공(`{"id":"123"}` → 주소), 종료 코드 1(첫 줄 이유), `id` 없음, 없는 명령(127), 제한을 넘는 가짜(`timeoutMs` 를 줄이는 테스트용 인자를 둔다)를 본다. 사내 `dooray` 의 실제 응답 꼴(맨 위 `id`)은 PR 전에 코디네이터 머신에서 한 번 확인해 머리 주석에 CLI 버전과 함께 적는다(인수 검증 계획). `taskAdapter` 는 임시 저장소의 `.orch/config.json` 으로 좋은 값·틀린 값(`ConfigError`)을 본다.

### 7. 표본과 읽는 곳 대조

- `skills/orch/tests/fixtures/config-samples.ts` 의 `board` 에 `task` 표본을 더한다. good 은 두 어댑터의 객체, bad 는 `{}`, `{ adapter: 'jira' }`, `{ adapter: 'dooray', web_url: 'https://x.dooray.com' }`, `{ adapter: 'url-template', url: 'https://x/browse' }`, `'dooray'`.
- `skills/orch/tests/config-schema-readers.spec.ts` 의 읽는 곳 목록에 `board.task` → `core/task-adapters.ts` 의 `taskAdapterOf` 를 더하고 good 표본을 부른다.
- `skills/orch/tests/orch-config.spec.ts` 에 사례 둘: `orch config set board.task.adapter dooray board.task.web_url https://x.dooray.com board.task.project P` 는 `CONFIG-SET` 이고, `orch config set board.task.adapter jira` 는 거절(종료 코드 1)이며 파일이 그대로다.

### 8. 설정 문서

- `docs/data-schema.md` 「config.json 에 더하는 절」 표에 `board` `task` 행을 더한다. 타입은 설계 「설정 `board.task`」 표의 두 꼴, 기본값은 「없음(주소를 만들지 않는다)」, 담는 것은 「보드 항목의 업무 번호를 맞추고 주소를 만드는 어댑터. 칩의 도구 이름도 정한다」 다.
- `skills/orch/references/overlay.md` 의 board 키 표(115-118행 근처)에 `task` 행을 더하고, 「알림 필터 설정」 절 근처에 「업무 도구 설정」 소절을 둔다. 두 어댑터의 예시, 세 키를 한 `orch config set` 호출에 짝으로 주는 법, 어댑터를 바꿀 때는 `orch config set board.task --json '{…}'` 로 통째 바꾸는 법, 새 번들을 설치하고 상주 루프를 다시 띄운 뒤에만 넣는다는 안내(옛 번들은 `board` 절 전체를 설정 오류로 읽는다)를 적는다.
- `skills/orch/tests/config-docs.spec.ts` 에 두 문서의 표에 `board` `task` 행이 있는지 보는 단언을 더한다. 지금 테스트는 `board` 키를 보지 않는다.

### 9. 변경 이력 조각

`skills/orch/changes/board-task-link.minor.md` 를 만든다. `- ` 줄로 「설정 board.task 로 업무 도구 어댑터(dooray, url-template)를 고른다」 를 적는다. 다음 phase 가 같은 파일에 줄을 더한다. 꼴은 `README.md` 「버전과 변경 이력」 의 조각 규칙을 따른다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-task-adapters.spec.ts skills/orch/tests/lib-task-adapters.spec.ts skills/orch/tests/core-config-schema.spec.ts skills/orch/tests/config-schema-readers.spec.ts skills/orch/tests/orch-config.spec.ts skills/orch/tests/config-docs.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/task-adapters.ts` | 신규 |
| `skills/orch/scripts/lib/task-adapters.ts` | 신규 |
| `skills/orch/scripts/core/config.ts` | 수정 (`BOARD_KEYS` 에 task) |
| `skills/orch/scripts/core/config-schema.ts` | 수정 (`board.task` 검사) |
| `skills/orch/tests/core-task-adapters.spec.ts` | 신규 |
| `skills/orch/tests/lib-task-adapters.spec.ts` | 신규 |
| `skills/orch/tests/fixtures/config-samples.ts` | 수정 |
| `skills/orch/tests/config-schema-readers.spec.ts` | 수정 |
| `skills/orch/tests/orch-config.spec.ts` | 수정 |
| `skills/orch/tests/config-docs.spec.ts` | 수정 |
| `docs/data-schema.md` | 수정 (`board.task` 행) |
| `skills/orch/references/overlay.md` | 수정 (`task` 행, 업무 도구 설정) |
| `skills/orch/changes/board-task-link.minor.md` | 신규 |

| `skills/orch/tests/core-config-schema.spec.ts` | 수정 (재시작 키 기대값) |
