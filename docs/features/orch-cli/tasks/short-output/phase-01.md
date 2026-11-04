# Phase 01. 짧은 출력 신호와 공통 줄 규칙

**Execution profile**: deep

## 목표

진입점이 새 꼴과 옛 꼴 모두에서 자식에게 짧은 출력 신호를 넘기고(`--full` 이면 넘기지 않는다), 스크립트가 `lib/output.ts` 하나로 짧은 출력을 판정하고 줄을 필터링하게 한다.

**범위 외**: 명령마다의 규칙표(phase 02-05), 문서(phase 06).

## 컨텍스트

**요구사항**: REQ4, REQ5

**근거 문서**: `docs/features/orch-cli/spec.md` 의 「출력」, REQ4, REQ5, DECISION5, DECISION11, DECISION16, DECISION20. `docs/features/orch-cli/design.md` 의 「책임과 경계」 의 출력 신호, 「짧은 출력 (PR2)」 의 「신호와 공통 규칙」, 결정 DECISION5, DECISION9, DECISION18, DECISION19.

- 진입점 `skills/orch/bin/orch.ts` 의 `main` 은 새 꼴(`commands.isGroup(first)`)이면 `resolveNew` → `fillContext` → `run(file, args, childEnv)`, 옛 꼴이면 `run(file, rest, childEnv)` 다. `childEnv` 에서 `ORCH_ENTRY_HOP`, `ORCH_CONTEXT` 를 지운다.
- `skills/orch/scripts/lib/bundle.ts` 가 `ORCH_CONTEXT` 를 읽고 지우는 방식(모듈 평가 때 한 번)을 `ORCH_OUTPUT` 에도 쓴다. `lib/args.ts` 와 `lib/proc.ts` 가 `./bundle.ts` 를 import 한다. `gh-usage.ts` 는 `lib/paths.ts` → `lib/git.ts` → `lib/proc.ts` 로 닿는다. 모든 진입 스크립트가 `bundle.ts` 에 닿는지는 `skills/orch/tests/lib-bundle.spec.ts` 의 「모든 직접 실행 스크립트가 공용 경고 모듈에 닿는다」 가 이미 본다.
- `lib/commands.ts` 의 `Command.passthrough` 가 참인 행(`slot heavy`, `slot mem`)은 신호를 넘기지 않는다.

## 의도 메모

- 진입점이 자식 stdout 을 필터링하는 안은 기각했다(설계 DECISION18). `wait` 의 원문 저장과 완료 판정을 진입점이 알 수 없다.
- `short()` 는 `--help`, `-h`, `--json` 이 첫 `--` 앞에 있으면 거짓이다. 사용법과 JSON 은 짧은 출력에서도 그대로여야 한다. `process.argv.slice(2)` 를 읽는다.
- 신호를 지우지 않으면 상주 루프와 핸들러가 물려받는다. `bundle.ts` 가 지운다.

## 작업 항목

### 1. `skills/orch/scripts/lib/bundle.ts`

`ORCH_OUTPUT` 을 읽어 모듈 변수에 두고 `delete process.env.ORCH_OUTPUT` 한다. `export function orchOutput(): string` 으로 읽은 값('' 또는 'short')을 낸다.

### 2. `skills/orch/scripts/lib/output.ts` 신규

- `import { orchOutput } from './bundle.ts'`.
- `short(argv = process.argv.slice(2)): boolean` — `orchOutput() === 'short'` 이고 첫 `--` 앞에 `--help`, `-h`, `--json` 이 없다.
- `VERDICT = /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*(?=\s|$)/`, `isVerdict(line)`.
- `type Rule = [RegExp, (m: RegExpExecArray) => string | null]`.
- `emit(text: string, rules: Rule[] = [], opts: { fix?: boolean; write?: (s: string) => void } = {})` — 짧은 출력이 아니면 `text + '\n'` 을 그대로 쓴다. 짧으면 `text` 를 `\n` 으로 나눠 줄마다: 규칙표의 첫 맞는 규칙의 결과(null 이면 버림), 맞는 규칙이 없으면 판정 줄은 그대로, `opts.fix` 이고 줄이 두 칸 들여쓰기이며 `  안내:` 로 시작하지 않고 그 줄이 딸린 판정 줄(앞의 들여 쓰지 않은 마지막 줄)을 남겼으면 그대로, 나머지는 버린다. 규칙의 결과가 여러 줄(`\n`)이면 그대로 낸다. 기본 쓰기는 `process.stdout.write`.
- `shortEnv(): Record<string, string>` — 짧은 출력이면 `{ ORCH_OUTPUT: 'short' }`, 아니면 `{}`. 출력을 그대로 잇는 자식에 쓴다.
- `oneLine(text, max?)` — 줄바꿈을 공백 하나로 바꾸고 `max` 글자(Array.from 기준)에서 자른다.

### 3. `skills/orch/bin/orch.ts`

- `stripFull(args): { args: string[]; full: boolean }` — 첫 `--` 앞의 `--full` 을 모두 떼고 있었는지 낸다.
- 새 꼴: `resolveNew` 앞에서 `rest` 의 `--full` 을 뗀다(`passthrough` 행이면 떼지 않는다. 행을 알기 전이므로 `resolveNew` 결과의 `command.passthrough` 를 보고, 참이면 뗀 인자 대신 원래 인자로 다시 푼다). 감싼 명령이 아니고 `--full` 이 없으면 `childEnv.ORCH_OUTPUT = 'short'`.
- 옛 꼴: `rest` 에서 `--full` 을 떼고, 옛 이름이 감싼 명령의 행(`resolveLegacy` 의 `command.passthrough`)이 아니면 같은 규칙으로 신호를 넘긴다. `--path` 는 신호와 상관없다.
- `childEnv` 에서 바깥의 `ORCH_OUTPUT` 을 먼저 지운다(부모 셸의 값이 새지 않게).
- 머리 주석에 신호와 `--full` 을 적는다.

### 4. `skills/orch/scripts/lib/commands.ts`

`helpText()` 머리말에 「기본 출력은 판정 줄이다. `--full` 은 지금 출력을 낸다」 한 줄을 더한다.

### 5. 테스트

- `skills/orch/tests/lib-output.spec.ts` 신규: `ORCH_OUTPUT=short` 로 띄운 자식 node 에서 `emit` 이 규칙 결과, 판정 줄, 버리는 줄, `fix` 고칠 줄(`  안내:` 는 버림)을 낸다. 신호가 없으면 그대로 낸다. `--json`, `--help` 인자면 `short()` 가 거짓이다. import 뒤 `process.env.ORCH_OUTPUT` 이 없다. `shortEnv()` 가 짧을 때만 값을 낸다.
- `skills/orch/tests/orch-entry.spec.ts`: 가짜 번들의 `hello.ts` 가 `ORCH_OUTPUT` 값을 함께 찍게 하고(`out=` 값), 새 꼴과 옛 꼴은 `out=short`, `--full` 을 주면 `out=` 이고 스크립트 인자에 `--full` 이 없다. 감싼 명령(`slot heavy`)은 신호가 없고 `--full` 을 떼지 않는다. 부모 환경의 `ORCH_OUTPUT=short` 가 `--full` 호출로 새지 않는다. 기존 사례의 기대 stdout 은 `out=` 값이 더해진 것으로 고친다.

## 검증

```bash
node --test skills/orch/tests/lib-output.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/lib-bundle.spec.ts skills/orch/tests/lib-commands.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/output.ts` | 신규 |
| `skills/orch/scripts/lib/bundle.ts` | 수정 |
| `skills/orch/bin/orch.ts` | 수정 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/lib-output.spec.ts` | 신규 |
| `skills/orch/tests/orch-entry.spec.ts` | 수정 |
