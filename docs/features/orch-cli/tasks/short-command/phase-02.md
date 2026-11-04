# Phase 02. 새 꼴의 문맥 기본값

**Execution profile**: deep

## 목표

새 꼴 명령에서 `--repo`, `--run`, `--specs-dir`, `--loop-repo` 를 생략하면 진입점이 「명시 > 문맥 > 설정」 순서로 채우고 출처를 stderr 한 줄로 남긴다.

**범위 외**: `NEXT_WAIT` 가 `orchContext()` 를 쓰는 일(phase 04). 옛 꼴은 문맥을 읽지 않는다(스펙 DECISION18).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/orch-cli/spec.md` 의 REQ3, DECISION2·DECISION18. `docs/features/orch-cli/design.md` 의 「문맥 `lib/context.ts`」, 「명령 표 항목」 의 문맥 칸 표, 「문맥 풀기」, 「문맥 신호 `ORCH_CONTEXT`」, 「실패와 일관성」 의 신호 누수, 결정 DECISION3·DECISION4·DECISION9.

- 명령 표 `skills/orch/scripts/lib/commands.ts`(phase 01)의 `context`, `explicit` 필드가 명령마다 채울 인자를 정한다.
- 재사용 함수: `skills/orch/scripts/lib/git.ts` 의 `mainCheckout(repo)`(git 밖이면 받은 폴더의 realpath 를 돌려준다. git 저장소인지는 `git rev-parse` 로 따로 본다), `lib/paths.ts` 의 `pathOf('specs', repo)`, `lib/config.ts` 의 `loadConfig(repo)` 와 `section(config, 'finish', FINISH_KEYS)`(`lib/finish-options.ts` 의 `FINISH_KEYS`, 쓰는 예: `skills/orch/scripts/orch-loop.ts` 578줄), `lib/loop.ts` 의 `isRegistered(repo, run)`, `lib/orca.ts` 의 `orca(args, opts)`(실행 파일은 `ORCA` 환경 변수).
- `loadConfig` 는 설정이 잘못되면 `ConfigError` 나 `RemovedConfigError` 를 던진다. 문맥 풀기는 명령을 막지 않으므로 잡아서 설정 출처를 건너뛴다. 오류 판정은 스크립트가 지금처럼 한다.
- `skills/orch/scripts/lib/bundle.ts` 는 `lib/args.ts`, `lib/proc.ts` 가 import 해 모든 진입 스크립트가 먼저 지나는 모듈이다. 여기서 `ORCH_CONTEXT` 를 읽고 지운다.

## 의도 메모

- 진입점이 빠진 인자를 명령줄에 더하고 스크립트의 인자 처리는 고치지 않는다(설계 DECISION3).
- 새 꼴에서 문맥 칸 인자의 줄여 쓰기(`--re`, `--ru`)는 사용법 오류다(설계 DECISION4). 그 값을 진입점이 모르면 같은 인자가 둘 들어간다.
- `--ack` 가 있는 `wait` 은 `run-current` 를 못 읽으면 설정의 `finish.run` 으로 대신하지 않는다. 15초 제한으로 한 번 더 읽고, 그래도 못 읽으면 사용법 오류와 `--run <Run>` 을 붙이라는 줄을 낸다. 다른 Run 의 delivery 를 ack 하지 않게 한다.

## 작업 항목

### 1. `skills/orch/scripts/lib/context.ts` 신규

- `fillContext(command: Command, args: string[], cwd: string, opts?: { orcaTimeoutMs?: number }): { args: string[]; note: string | null; filled: Record<string, string> } | { error: string }`
- 설계 「문맥 풀기」 그대로: 저장소는 git 저장소 안일 때만 `mainCheckout(cwd)`. Run 은 `orca orchestration run-current --json --full` 의 `run.id`(5초 제한), 못 읽으면 `finish.run`(명령 표의 `runFrom` 이 `run-current` 인 `worker send` 는 설정으로 대신하지 않는다). 지시서 폴더는 `finish.specs_dir`, 없으면 `pathOf('specs', repo)`. 루프 저장소는 `isRegistered(repo, run)` 이 참이면 그 저장소.
- 기준 저장소: 설정, 지시서 폴더, 루프 저장소는 명시한 `--repo` 가 하나면 그 저장소에서 읽는다. `--repo` 가 둘 이상이면 지시서 폴더를 채우지 않는다. `cleanup-sweep.ts` 는 지시서 폴더에서 워크트리 이름과 같은 지시서를 지우므로(908~913줄 근처) 다른 저장소의 폴더가 채워지면 지시서를 잘못 지운다.
- 필수 문맥: `required` 에 든 인자(실측: `wait` 의 run. 구현 때 각 스크립트의 `Usage` 판정을 `git grep -n "이 필요하다" skills/orch/scripts/*.ts` 로 다시 본다)를 채우지 못하면 error 로 `--run <Run> 이 필요하다. 코디네이터 터미널에서 부르거나 --run 을 준다` 꼴을 낸다.
- 넣는 자리는 `prepend` 바로 뒤, 첫 `--` 앞이다. 명시 판정은 첫 `--` 앞의 `--<이름>`, `--<이름>=…`, `explicit` 의 꼴, 그 문맥으로 바꾼 위치 인자(`worker worktree <저장소>` → `--repo`)다.
- 설계 「문맥 칸」 표의 예외는 명령 표의 `skip(args)` 로 구현한다: `wait ack-lost` 는 run 만, `wait triage` 는 `--live` 일 때만 run, `loop stop --all` 은 run 을 채우지 않는다, `worker launch` 는 `--worktree` 가 있으면 repo 를 채우지 않는다, `worker adopt` 는 `--apply` 일 때만 run, `cleanup sweep` 은 `--repo` 가 하나라도 있으면 repo 를 채우지 않는다, `queue merge` 는 `--finish-arg`·`--sweep-arg` 안의 `--run` 도 명시로 본다.
- `note` 는 `orch: 문맥 repo=<경로>(작업 폴더) run=<id>(run-current) specs-dir=<경로>(설정)` 꼴이고 채운 값이 없으면 null.
- `filled` 는 채운 인자와 출처다. 진입점이 자식 환경 `ORCH_CONTEXT` 에 `run=run-current loop-repo=registered` 꼴로 넘긴다(phase 04 가 읽는다).

### 2. `skills/orch/bin/orch.ts` 연결

새 꼴에서만 `fillContext` 를 부르고, error 면 사용법(2)으로 끝낸다. `note` 를 stderr 에 내고, 자식 환경에 `ORCH_CONTEXT` 를 넣는다. 옛 꼴에서는 부르지 않고 `ORCH_CONTEXT` 를 지운다.

### 3. `skills/orch/scripts/lib/bundle.ts` 의 신호 읽기

import 될 때 `process.env.ORCH_CONTEXT` 를 읽어 지우고 `orchContext(): Record<string, string>` 으로 export 한다(`run=run-current loop-repo=registered` → `{ run: 'run-current', 'loop-repo': 'registered' }`). 스크립트가 띄우는 자식, 상주 루프, 핸들러로 새지 않는다.

### 4. 테스트 `skills/orch/tests/lib-context.spec.ts` 신규

임시 git 저장소(주 checkout 과 `git worktree add` 한 워크트리)와 가짜 `orca`(ORCA 환경 변수로 가리킨 작은 node 스크립트, `run-current` 에 고정 JSON 을 내거나 실패)를 만든다.

- 워크트리 안에서 `loop start` 를 인자 없이 풀면 repo 는 주 checkout, run 은 run-current 값, specs-dir 은 `.orch/specs` 이고 note 에 세 출처가 있다.
- 명시한 `--run` 은 그대로 두고 채우지 않는다. `--finish-arg=--run` 이 있는 `queue merge` 도 같다.
- run-current 가 실패하면 `finish.run` 을 쓴다. 둘 다 없으면 run 을 채우지 않는다. `wait --ack x` 는 run-current 실패 때 error.
- `--re x` 처럼 줄인 문맥 인자는 error. `--` 뒤의 `--repo` 는 명시로 보지 않고 건드리지 않는다.
- `cleanup sweep --repo a` 는 repo 를 더하지 않는다. `loop stop --all` 은 run 을 더하지 않는다.
- git 저장소 밖 cwd 에서는 repo 를 채우지 않는다.
- 작업 폴더가 저장소 A 이고 `cleanup sweep --repo B` 이면 지시서 폴더는 B 의 것이다. `cleanup sweep --repo B --repo C` 이면 지시서 폴더를 채우지 않는다. `queue merge --repo B` 의 run 설정은 B 의 `finish.run` 이다.
- run-current 와 설정이 모두 없을 때 `wait` 은 error 이고 메시지에 `--run` 이 있다. `loop status` 는 error 가 아니다.
- run-current 가 실패하고 `finish.run` 이 있을 때 `worker send` 는 run 을 채우지 않는다.
- `doctor` 와 `loop stalled` 는 run-current 가 있어도 run 을 채우지 않는다.
- git 저장소 밖 cwd 에서 `loop status` 를 새 꼴로 부르면 진입점은 repo 를 채우지 않고, 스크립트가 지금처럼 `--repo 가 필요하다` 와 2 로 끝난다(`orch-entry.spec.ts` 에 진입점을 거친 사례로 둔다. REQ3 의 실패 인수 조건)
- `worker worktree /x --name n` 은 repo 를 더하지 않는다. 잘못된 `config.json` 이 있어도 error 가 아니고 설정 출처만 건너뛴다.
- run-current 가 첫 5초에 늦고 15초 안에 답하는 가짜 orca 에서 `wait --ack x` 가 run 을 채운다.

`skills/orch/tests/orch-entry.spec.ts` 에 새 꼴이 채운 인자를 자식에 넘기고 stderr 에 note 를 내며, 옛 꼴은 채우지 않는 사례를 더한다. 같은 값을 명시한 옛 꼴과 새 꼴의 stdout 과 종료 코드가 같다.
`skills/orch/tests/lib-bundle.spec.ts` 에 `ORCH_CONTEXT` 를 받은 스크립트가 띄운 자식의 환경에 그 값이 없고 `orchContext()` 가 값을 돌려주는 사례를 더한다.

## 검증

```bash
node --test skills/orch/tests/lib-context.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/lib-bundle.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/context.ts` | 신규 |
| `skills/orch/bin/orch.ts` | 수정 |
| `skills/orch/scripts/lib/bundle.ts` | 수정 |
| `skills/orch/tests/lib-context.spec.ts` | 신규 |
| `skills/orch/tests/lib-bundle.spec.ts` | 수정 |
| `skills/orch/tests/orch-entry.spec.ts` | 수정 |
