# Phase 03. 이벤트 실행기와 핸들러용 가드 shim 을 만든다

**Execution profile**: deep

## 목표

명령이 `fire('before-merge', input)` 한 줄로 저장소의 핸들러를 부르게 하는 실행기를 만든다.
핸들러 찾기, 잠금, 시간 제한, 실행 기록, 종료 코드 해석, 가드 환경을 이 모듈 한 곳이 소유한다.

**범위 외**: 명령에서 이벤트를 내는 일. 그 일은 명령을 전환하는 plan 들이 한다. 옛 설정 칸을 핸들러로 돌리는 어댑터는 여기서 만들지만, 그 칸을 읽어 넘기는 일은 머지 명령 plan 이 한다.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다. `lib/proc.ts`, `lib/paths.ts`, `lib/config.ts`, `lib/process.ts` 를 쓴다.

핸들러 계약(위치, 이벤트당 한 파일, 실행 명령, 작업 디렉터리, stdin JSON, 환경, 출력 접두, 거부 이유, 시간 제한 기본값, 잠금, 종료 코드 0·10·그 밖, 공통 필드, 기록 파일과 회전)은 `docs/data-schema.md` 의 「orch 이벤트 핸들러 입력」 이 소유한다. 그 표의 값을 그대로 구현한다.
이벤트 이름, 거부할 수 있는지, 실패 때의 갈래는 `docs/flow.md` 의 「이벤트 목록」 과 「갈래」 가 소유한다.
가드 shim 이 거부할 호출은 `docs/code-architecture.md` 의 「공통 안전 장치」 가 정한다.

**근거 문서**: `docs/data-schema.md` 의 「orch 이벤트 핸들러 입력」 과 「orch 루트에 더하는 파일」, `docs/flow.md` 의 「orch 이벤트」, `docs/code-architecture.md` 의 「공통 안전 장치」, `docs/adr/009-orch-event-handlers.md`

## 의도 메모

- 거부를 10 으로 둔 이유: node 는 잡지 않은 예외에 1 을 낸다. 1 을 거부로 읽으면 죽은 핸들러를 의도한 거부로 보고하게 된다.
- 거부할 수 있는 이벤트의 실패는 거부처럼 멈춘다. 모르는 실패로 머지하거나 지우는 것보다 멈추는 쪽이 안전하다.
- 가드 shim 은 PATH 앞 폴더의 확장자 없는 파일이다. Node 는 확장자 없는 파일을 CommonJS 로 읽어 타입 문법을 지우지 않는다. shim 은 타입 문법 없이 `import()` 로 `guard.ts` 를 부른다.
- 진짜 실행 파일은 실행기가 `ORCH_REAL_ORCA`, `ORCH_REAL_GH` 로 넘긴다. shim 이 PATH 를 다시 찾으면 자기 자신을 부른다.

## 작업 항목

### 1. `orch/scripts/lib/events.ts`

```ts
export const EVENTS: Readonly<Record<string, { rejectable: boolean; timeoutSec: number }>>
export type FireResult = { result: 'none' | 'pass' | 'reject' | 'fail' | 'timeout'; code: number | null; reason: string; durationMs: number }
export function fire(event: string, input: Record<string, unknown>, ctx: {
  repo: string; base: string; run: string | null; cwd?: string;
  legacy?: { command: string; env: Record<string, string>; args?: string[] };
  out?: (line: string) => void
}): FireResult
export function unknownHandlers(repo: string): string[]
```

- `EVENTS` 는 `docs/flow.md` 의 이벤트 목록 전부다. 시간 제한 기본값은 `docs/data-schema.md` 의 값이고 `config.json` 의 `hooks.timeouts` 가 덮는다
- 핸들러 파일과 `legacy` 가 함께 있으면 `ConfigError` 를 던진다. 명령은 사용법 오류(종료 코드 2)로 바꾼다
- 핸들러가 없고 `legacy` 가 있으면 `bash -c <command>` 를 `legacy.env` 와 함께 같은 시간 제한, 잠금, 기록으로 돌리고 `DEPRECATED <키> → hooks/<이벤트>.ts` 한 줄을 `out` 으로 낸다
- 출력 줄은 `out` 으로 보낸다. 기본은 stdout 이다. 핸들러의 stdout 과 stderr 줄에 `[hook <이벤트>] ` 를 붙인다
- 결과마다 `HOOK-REJECT <이벤트> <이유>` 나 `HOOK-FAIL <이벤트> <종료 코드|timeout>` 줄을 낸다. `pass` 와 `none` 은 줄을 내지 않는다
- 잠금은 `state/hooks/<이벤트>.lock` 에 pid 를 쓴다. 죽은 pid(`alive` 가 false)의 잠금은 회수한다
- 기록은 `state/hooks.jsonl` 에 한 줄씩 더하고, 1MB 를 넘으면 `.1` 로 돌린다
- `unknownHandlers` 는 `hooks/` 에서 `EVENTS` 에 없는 이름의 `.ts` 를 낸다. doctor 가 쓴다

### 2. 가드 shim `orch/scripts/lib/guard/orca`, `orch/scripts/lib/guard/gh`, `orch/scripts/lib/guard/guard.ts`

`guard.ts` 의 `check(tool: 'orca' | 'gh', argv: string[]): string | null` 이 거부 이유나 null 을 낸다.

| 도구 | 거부 |
| --- | --- |
| orca | `terminal send` |
| gh | `pr merge`, `pr update-branch`, `api` 의 경로가 `/pulls/<번호>/update-branch` 이거나 `/merges` 로 끝나는 호출 |

거부하면 stderr 에 이유와 「코어 명령을 쓴다」 를 내고 종료 코드 126 이다. 통과면 `ORCH_REAL_ORCA` 나 `ORCH_REAL_GH` 를 같은 인자와 stdin 으로 실행하고 그 종료 코드를 낸다.
두 shim 파일은 실행 권한을 준다(`git update-index --chmod=+x`).

### 3. 이 phase 의 테스트

| 파일 | 정상 | 실패 |
| --- | --- | --- |
| `orch/tests/lib-events.spec.ts` | 핸들러 없음은 `none`. 0 은 `pass`, 입력 JSON 과 환경 변수가 핸들러에 간다. 기록 한 줄 | 거부할 수 있는 이벤트의 10 은 `reject` 와 마지막 stdout 줄이 이유. 거부할 수 없는 이벤트의 10 은 `fail`. 시간 초과는 `timeout`. 핸들러와 `legacy` 가 함께면 `ConfigError`. 모르는 핸들러 이름 |
| `orch/tests/lib-guard.spec.ts` | 허용 호출이 진짜 실행 파일(가짜 bin)에 그대로 간다 | 표의 호출마다 126 과 진짜 실행 파일이 불리지 않음 |

시간 초과 테스트는 `hooks.timeouts` 로 1초를 준다.

### 4. `orch/CHANGELOG.md` 와 `orch/SKILL.md` 의 `metadata.version`

이 plan 의 phase 들을 한 항목으로 적는다. 코디네이터 지시가 바뀌지 않으므로 patch 를 올린다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-events.spec.ts orch/tests/lib-guard.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
test -x orch/scripts/lib/guard/orca && test -x orch/scripts/lib/guard/gh
claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/events.ts` | 신규 |
| `orch/scripts/lib/guard/orca` | 신규 |
| `orch/scripts/lib/guard/gh` | 신규 |
| `orch/scripts/lib/guard/guard.ts` | 신규 |
| `orch/tests/lib-events.spec.ts` | 신규 |
| `orch/tests/lib-guard.spec.ts` | 신규 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/SKILL.md` | 수정 |
