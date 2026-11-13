# Phase 01. 번들 판정 helper 와 루프 상태의 번들 버전

**Execution profile**: standard

## 목표

`lib/bundle.ts` 에 번들 경로·지금 설치본·버전을 읽는 helper 를 더하고, 루프가 `loop.json` 에 자기 번들 버전을 적어 `orch loop status` 와 `orch status` 의 `LOOP-ALIVE` 줄 끝에 `bundle=<버전>` 을 보인다.

**범위 외**: 옛 번들 판정과 다시 뜨기(phase 03, 04), 틱 실패 알림(phase 02), 참조 문서(phase 05).

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/loop-self-update/spec.md` REQ7·DECISION14, `docs/features/loop-self-update/design.md` 「책임과 경계」 의 `lib/bundle.ts`, 「상태 출력」

- `skills/orch/scripts/lib/bundle.ts` 23-26행이 모듈 상수 `bundle`(이 파일이 든 번들 루트)을 계산하고, 12-18행 `staleBundleWarning` 이 `selectBundle`(`lib/install-record.ts`)로 지금 설치본을 고른다. 이 파일은 모든 진입 스크립트가 import 하므로 import 할 때의 부수 효과(경고 한 줄, `ORCH_CONTEXT`·`ORCH_OUTPUT` 지우기)를 바꾸지 않는다.
- `bundleRoot()`(19행)은 이름과 달리 스킬 폴더(`skills/orch`)를 낸다. 쓰는 곳이 있으니 그대로 두고 새 함수 이름을 `ownBundle` 로 한다.
- 플러그인 버전의 원본은 번들 루트의 `.claude-plugin/plugin.json` 의 `version` 이다(저장소 루트에서 `cat .claude-plugin/plugin.json` 으로 확인).
- 루프 상태 쓰기는 `skills/orch/scripts/loop/lifecycle.ts` 의 `foreground` 가 만드는 `state` 객체(526-541행)다. 출력은 `status()`(445-454행)다.
- `orch status` 는 `skills/orch/scripts/status/orch-status.ts` 99행의 `LOOP-ALIVE` 줄이다.
- 상태 타입은 `skills/orch/scripts/core/loop.ts` 의 `LoopState` 다. core 는 lib 를 import 하지 못한다(ADR-028).

## 의도 메모

- 상태 출력에서 ps 로 프로세스 명령줄을 읽어 버전을 알아내는 방법은 쓰지 않는다. 루프가 시작할 때 한 번 적는 값이 더 싸고, 키가 없는 옛 루프는 `-` 로 충분하다(옛 번들 여부는 `orch status` 의 `LOOP-STALE` 줄이 따로 알린다).
- `staleBundleWarning` 의 출력은 바이트 그대로 둔다. `lib-bundle.spec.ts` 의 기존 사례가 그대로 통과해야 한다.

## 작업 항목

### 1. `skills/orch/scripts/lib/bundle.ts`

- `export function ownBundle(): string` — 모듈 상수 `bundle` 을 낸다.
- `export function currentBundle(own: string, configDir: string): string | null` — `own` 이 `plugins/cache` 안이 아니면 null. `selectBundle(configDir, own)` 이 오류거나 `source === 'own'` 이거나 `canonical` 이 같으면 null. 아니면 고른 번들 경로.
- `staleBundleWarning` 을 `currentBundle` 로 다시 쓴다. 문구는 그대로다.
- `export function bundleVersion(bundle: string): string | null` — `<bundle>/.claude-plugin/plugin.json` 을 읽어 `version` 이 비지 않은 문자열이면 그 값, 아니면 null. 예외를 던지지 않는다.
- 파일 맨 위 설명에 세 함수의 한 줄 설명을 더한다.

### 2. `skills/orch/scripts/core/loop.ts`

`LoopState` 에 `bundle_version?: string | null` 을 더한다.

### 3. `skills/orch/scripts/loop/lifecycle.ts`

- `foreground` 의 `state` 에 `bundle_version: bundleVersion(ownBundle())` 을 더한다.
- `status()` 의 줄 끝에 ` bundle=${state.bundle_version || '-'}` 를 더한다.
- 파일 맨 위 설명 「loop.json」 의 키 목록에 `bundle_version` 을 더한다.

### 4. `skills/orch/scripts/loop/orch-loop.ts`

머리 주석 46행 `--status` 출력 줄에 ` bundle=<버전 또는 ->` 를 더한다. 코드는 바꾸지 않는다. 같은 파일을 보드 업무 링크 작업(`feat/board-task-link`)이 고친다. 이 줄만 고쳐 겹침을 줄인다.

### 4-1. `skills/orch/scripts/status/orch-status.ts`

99행 `LOOP-ALIVE` 줄 끝에 ` bundle=${loop.state.bundle_version || '-'}` 를 더하고, 파일 맨 위 설명(출력 줄 표)을 같은 꼴로 고친다.

### 5. 테스트

- `skills/orch/tests/lib-bundle.spec.ts`: `currentBundle` 이 다른 캐시면 그 경로, 같은 캐시·체크아웃·깨진 기록이면 null 인지. `bundleVersion` 이 `plugin.json` 이 있으면 버전, 없거나 깨졌거나 `version` 이 숫자면 null 인지.
- `skills/orch/tests/orch-loop.spec.ts` 840행: 기대 정규식 끝을 `alive_at=\\S+ bundle=\\S+$` 로 바꾸고, 같은 테스트에서 값이 저장소 `.claude-plugin/plugin.json` 의 버전과 같은지 본다(테스트는 체크아웃에서 돌아 개발용 설치의 경우다).
- `skills/orch/tests/orch-status.spec.ts` 100행: 끝을 `last_tick=\\S+ bundle=-$` 로 바꾼다(이 테스트가 직접 쓴 `loop.json` 에는 키가 없다). 키를 넣은 사례 하나를 더해 `bundle=<값>` 을 본다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-bundle.spec.ts skills/orch/tests/orch-status.spec.ts skills/orch/tests/orch-loop.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/bundle.ts` | 수정 (`ownBundle`, `currentBundle`, `bundleVersion`) |
| `skills/orch/scripts/core/loop.ts` | 수정 (`bundle_version` 타입) |
| `skills/orch/scripts/loop/lifecycle.ts` | 수정 (`bundle_version` 쓰기, `status` 줄) |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 (머리 주석 `--status` 줄) |
| `skills/orch/scripts/status/orch-status.ts` | 수정 (`LOOP-ALIVE` 줄) |
| `skills/orch/tests/lib-bundle.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 (840행 기대값) |
| `skills/orch/tests/orch-status.spec.ts` | 수정 |
