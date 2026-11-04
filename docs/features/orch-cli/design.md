# orch: 짧은 `orch` 명령과 기능별 폴더 기술 설계

스펙: [spec.md](spec.md)

## 요구사항 연결

| ID | 해결 방법 | PR |
| --- | --- | --- |
| REQ1 | 플러그인 루트 `bin/orch` 실행기(CommonJS 한 파일)를 둔다. `orch doctor install-cli`(`scripts/install-cli.ts`)가 같은 파일을 `~/.local/bin/orch` 에 복사한다. 실행기는 설치 기록에서 현재 번들을 찾아 그 번들의 `skills/orch/bin/orch.ts` 에 인자를 그대로 넘기기만 한다. Codex 와 PATH 없는 셸은 SKILL.md 한 곳의 셸 함수 한 줄로 시작한다(아래 「PATH 가 없는 셸」) | PR1 |
| REQ2 | `skills/orch/scripts/lib/commands.ts` 의 명령 표가 `<묶음> <동작>` 을 스크립트 파일과 앞에 붙일 인자로 푼다. 새 꼴에서 동작으로 바뀐 모드 플래그는 표의 `forbid` 목록으로 거부한다 | PR1 |
| REQ3 | `skills/orch/scripts/lib/context.ts` 가 명령 표의 `context` 칸에 적힌 인자만 채운다. 채운 값과 출처를 stderr 한 줄로 낸다 | PR1 |
| REQ4 | `NEXT_WAIT` 는 PR1 에서 새 꼴로 바꾼다. `--lost-state` 의 기본값은 바꾸지 않고 절대경로로 남긴다. 명령마다의 짧은 출력은 PR2 에서 `lib/output.ts` 와 스크립트별 출력 함수로 낸다 | PR1, PR2 |
| REQ5 | 진입점이 옛 이름을 명령 표의 `legacy` 칸으로 찾아 같은 스크립트를 같은 인자로 부르고 stderr 에 새 꼴을 안내한다. PR2 부터 옛 꼴도 짧은 출력이다 | PR1, PR2 |
| REQ6 | 번들 고르기의 원본 `lib/install-record.ts` 의 `selectBundle()` 이 user 범위 항목이 있으면 그 항목만 본다. 진입점, `lib/bundle.ts`, doctor 가 이것을 쓰고, 실행기와 틀의 JS 사본은 같은 사례 표 테스트로 묶는다 | PR1 |
| REQ7 | doctor 에 `CLI-MISSING`, `CLI-NOT-ON-PATH`, `CLI-STALE`, `OLD-CALL`, `DIRECT-PATH`, `WAIT-STALE` 판정을 더한다. 검사 범위와 꼴은 아래 「옛 꼴과 직접 경로 판정」 이다. `CLI-CONFLICT` 는 doctor 가 아니라 `install-cli` 의 출력이다 | PR1 |
| REQ8 | 문서의 `"$SKILL_DIR/bin/orch.ts" <이름>` 과 `python3 "$SKILL_DIR/scripts/orch-doctor.py"` 를 새 꼴로 바꾸고, doctor 의 문서 스크립트 판정이 새 꼴을 명령 표로 확인한다. work-board 의 요청문(`extensions/work-board/hooks/register.js` 의 `send-to-worker.ts` 직접 경로)도 `orch worker send` 로 바꾼다 | PR1 |
| REQ9 | 진입 스크립트를 `scripts/<묶음>/` 으로 옮긴다. 스크립트끼리 부르는 경로(`join(HERE, '<이름>.ts')` 20여 곳, `../bin/orch.ts` 같은 상대경로, doctor 의 `LOOP-STALE` 경로 꼴, work-board 프롬프트 테스트)는 명령 표의 `scriptPath(이름)` 으로 바꾼다. 이벤트 핸들러 환경의 `ORCH_SCRIPTS` 는 아래 「핸들러 환경」 을 따른다 | PR3 |
| REQ10 | `scripts/status.ts`(PR3 에서 `scripts/status/` 로 옮긴다)가 `lib/loop.ts`, `lib/movement.ts`, `lib/board.ts` 를 읽어 판정 줄을 낸다 | PR2 |
| REQ11 | `wait-important` 의 짧은 출력이 `triage-messages` 의 분류 함수를 가져다 메시지마다 한 줄을 낸다. 원문 JSON 은 `<orch 루트>/state/wait/<delivery>.json` 에 저장하고 경로 한 줄을 낸다 | PR2 |

## 책임과 경계

```text
PATH 의 orch (실행기: 플러그인 bin/orch, ~/.local/bin/orch 사본)
  └─ 설치 기록 → 현재 번들의 skills/orch/bin/orch.ts (진입점)
       ├─ lib/commands.ts  명령 표: 새 꼴과 옛 이름 → 스크립트, 앞 인자, 문맥 칸, 금지 플래그
       ├─ lib/context.ts   문맥 기본값(새 꼴만)
       └─ node <스크립트>  ORCH_OUTPUT=short 를 넘긴다(PR2)
스크립트가 다른 스크립트를 부를 때: 파일 경로로 직접. 진입점과 ORCH_OUTPUT 을 거치지 않는다
```

- **실행기 `bin/orch`(플러그인 루트)**: 번들을 찾아 넘기기만 한다. Node 내장 모듈만 쓰고 타입 문법이 없는 CommonJS 다. 확장자가 없는 파일이라 node 가 타입 제거를 하지 않고, CommonJS 라 낮은 node 에서도 읽혀 `NODE-TOO-OLD` 를 직접 낸다(최소 버전 값은 `scripts/ts_shim.py` 의 `MIN_NODE` 와 같아야 하고 테스트가 둘을 대조한다). 파일 머리에 표지 주석 `fos-skills orch launcher` 를 둔다. doctor 와 `NEXT_WAIT` 가 PATH 의 `orch` 가 이 실행기인지 이 표지로 가린다. 명령 표를 갖지 않으므로 `~/.local/bin` 사본이 낡아도 새 명령을 모르는 일은 없다. 고른 번들에 `skills/orch/scripts/lib/commands.ts` 가 없으면(이 기능 이전 번들) 넘기지 않고 이유와 플러그인 갱신 명령을 내고 3 으로 끝난다.
- **실행기와 진입점의 자식 실행**: 지금 진입점 `skills/orch/bin/orch.ts` 의 `forward` 와 같다. 표준 입출력을 상속하고, SIGINT·SIGTERM·SIGHUP 을 자식에게 전하고 자식이 끝나기를 기다리며, 종료 코드는 자식의 코드(신호로 끝나면 128 + 신호 번호)다. 대기의 「끝내기」 계약(SIGTERM 이 `wait-important` 에 닿아야 check 그룹을 정리한다)을 지키려는 것이다.
- **프로세스 사슬**: 새 꼴의 사슬은 `셸 → node bin/orch → node skills/orch/bin/orch.ts → node wait-important.ts --run R …` 이다. 실행기와 진입점의 명령줄에는 `wait-important` 와 Run id 가 없을 수 있다. `wait-important.ts` 의 고아 대기 판정 `stalePids` 는 부모가 init 인 셸에서 셸과 대기만 따라 내려가므로, 실행기와 진입점(명령줄의 스크립트 경로가 `/bin/orch` 나 `/bin/orch.ts` 로 끝나는 node)을 셸처럼 통과하는 노드로 본다. `lib/waiters.ts` 는 Run id 와 `wait-important` 가 함께 든 행만 세므로 바꾸지 않는다(자식 `wait-important` 는 진입점이 채운 `--run` 을 받는다).
- **번들 고르기의 원본 `lib/install-record.ts`(신규)**: `selectBundle(configDir, own): { bundle: string; reason: string } | { error: string }` 와 `canonical()` 을 export 한다. 내장 모듈만 쓰고 import 할 때 부수 효과가 없다. 규칙은 아래 「실패와 일관성」 의 번들 고르기다. 진입점, `lib/bundle.ts` 의 STALE-BUNDLE, doctor 의 `staleBundle` 이 이것을 쓴다. CommonJS 실행기와 `templates/spec-common.md` 의 한 줄 풀이는 import 할 수 없어 사본이다. 사본은 같은 설치 기록 사례 표(`skills/orch/tests/fixtures/install-records.json`)를 세 구현에 똑같이 돌리는 테스트로 묶는다.
- **진입점 `skills/orch/bin/orch.ts`**: 명령 해석, 옛 이름 안내, 문맥 채우기, 자식 실행을 맡는다. 먼저 `lib/install-record.ts` 만으로 고른 번들을 정한다. 자기 번들이 고른 번들과 실경로로 다르면(옛 번들 경로로 불렸으면) 고른 번들의 진입점에 인자를 그대로 넘긴다. 실측: Orca 프로필의 `home/plugins` 가 `~/.claude/plugins` 를 가리키는 링크라 문자열 비교는 늘 다르다. 넘긴 횟수를 `ORCH_ENTRY_HOP` 으로 세어 한 번 넘긴 진입점은 다시 넘기지 않는다. 스크립트 자식에게는 `ORCH_ENTRY_HOP` 을 지우고 넘긴다(핸들러가 `node $ORCH_BIN …` 을 불러도 넘기기가 막히지 않게). `ORCH_SCRIPTS_DIR` 이 있으면 그 폴더의 `../bin/orch.ts` 가 자기와 다를 때 그 진입점으로 넘긴다. 명령 표가 그 체크아웃의 것이어야 체크아웃에만 있는 새 명령과 폴더 배치(PR3 전후)가 맞는다. 넘기기를 정한 뒤에 `lib/commands.ts`, `lib/context.ts` 를 동적으로 import 한다. 그래서 옛 번들 진입점이 넘길 때 그 번들의 `lib/bundle.ts` 가 STALE-BUNDLE 을 찍지 않는다. 진입점이 lib 를 import 하므로 「파일 하나만 복사해 써도 된다」 성질은 실행기가 물려받는다. 진입점을 복사해 쓰던 저장소(스펙 부록의 gersang-lab `.orch/bin/orch.mts`)는 실행기를 복사하거나 `orch` 로 바꾼다.
- **명령 표 `lib/commands.ts`**: 이름과 경로의 유일한 원본이다. 진입점, doctor(문서 판정), 훅(대기 판정)이 이것을 읽는다. PR3 의 폴더 이동은 이 표의 경로만 바꾼다.
- **문맥 `lib/context.ts`**: 저장소, Run, 지시서 폴더, 루프 저장소를 푼다. 기존 `lib/git.ts` 의 `mainCheckout`, `lib/paths.ts` 의 `pathOf`, `lib/config.ts` 의 `loadConfig`·`section`, `lib/loop.ts` 의 `isRegistered` 를 쓴다. 새 규칙을 만들지 않는다. `loadConfig` 가 `ConfigError` 나 `RemovedConfigError` 를 던지면 설정 출처를 건너뛰고 지나간다. 오류는 스크립트가 지금처럼 알린다.
- **문맥 신호 `ORCH_CONTEXT`(PR1)**: 진입점이 채운 인자와 출처(예: `run=run-current loop-repo=registered`)를 자식 환경에 넣는다. `lib/bundle.ts` 가 import 될 때 읽어 `process.env` 에서 지우고 `orchContext()` 로 export 한다. 모든 진입 스크립트가 지나는 자리라 상주 루프와 핸들러로 새지 않는다. PR2 의 `ORCH_OUTPUT` 도 같은 자리에서 같은 방식으로 다룬다.
- **출력 신호(PR2)**: `ORCH_OUTPUT` 을 읽고 `process.env` 에서 지우는 일은 `lib/bundle.ts` 가 맡는다. `lib/args.ts` 와 `lib/proc.ts` 가 이미 import 해 모든 진입 스크립트가 먼저 지나는 자리다(실측: `gh-usage.ts` 만 둘 다 import 하지 않아 PR2 에서 더한다). 판정 함수는 `lib/output.ts` 의 `short()` 다. 출력을 그대로 넘기는 자식은 부모가 짧은 출력일 때 신호를 명시해 넘긴다: `merge-with-finish` → `merge_queue`(stdio 상속, `merge-with-finish.ts` 의 `runInherit`). 감싼 명령(`slot heavy`, `slot mem`)과 그 밖의 자식에는 넘기지 않는다. PR2 테스트가 모든 진입 스크립트가 신호를 지우는 모듈을 import 하는지 정적으로 본다.
- **스크립트**: 판정과 동작은 바꾸지 않는다. PR1 에서 고치는 것은 `wait-important.ts`(NEXT_WAIT, 고아 대기 판정의 통과 노드), `orch-doctor.ts`(판정 추가, 문서 판정), 훅 셋의 거부 문구, 그리고 사람이 읽는 안내 줄이다. 안내 줄의 범위는 목록이 아니라 규칙으로 정한다: `skills/orch/scripts` 와 `skills/orch/hooks` 의 문자열 가운데 다른 orch 스크립트를 옛 이름(`bin/orch.ts <이름>`, `<이름>.ts` 경로, `--path <이름>`)으로 부르라고 안내하는 것. `git grep -nE "orch\.ts['\"]?\)?\}? +[a-z_-]+|scripts/[a-z_-]+\.ts|[a-z_-]+\.ts --" skills/orch/scripts skills/orch/hooks` 로 찾고, 실측(2026-11-04)으로는 `launch-worker.ts`(link-claude-profile), `lib/sessions.ts`(adopt-sessions), `lib/config.ts`(migrate-orch-dir), `lib/paths.ts` 의 `warnLegacy`·`requireMigrated`(migrate-orch-dir), `orch-loop.ts`(finish-pr, `reserve-migration --prune/--again`), `remove-worktree.ts`(`cleanup-sweep --kill-holders`), `orch-doctor.ts` 의 `LOOP-DEAD`·`LOOP-STALE` 고칠 줄, `lib/bundle.ts` 의 STALE-BUNDLE 이다. 이 줄들은 판정 줄이 아니라 사람과 에이전트가 붙여 넣는 안내라 스펙 DECISION16(직접 실행은 지금 출력 그대로)의 예외로 둔다(아래 DECISION12). 앞 낱말은 `NEXT_WAIT` 와 같은 `orchWord()` 규칙을 쓴다. 각 스크립트의 `사용법:` 줄은 그 스크립트를 직접 부르는 꼴이라 바꾸지 않는다. 옛 이름을 지우는 PR(스펙 DECISION13) 전에 이 안내가 옛 꼴로 남으면 지운 뒤 안내가 사용법 오류를 부른다.
- **핸들러 환경**: `lib/events.ts` 가 핸들러에 주는 `ORCH_SCRIPTS`(스크립트 폴더)는 다른 저장소 핸들러가 쓰는 공개 계약이다(`references/hooks.md`, 실측: fos-assistant, fos-graphrag, fos-home-infra, ai-analysis 의 `.orch/hooks/worker-stalled.ts` 가 `join(ORCH_SCRIPTS, 'nudge-worker.ts')`). PR1 에서 `ORCH_BIN`(진입점 절대경로)을 더하고 hooks.md 의 예시를 `node $ORCH_BIN worker nudge …` 로 바꾼다. `ORCH_SCRIPTS` 는 PR3 뒤에도 스크립트 폴더를 가리킨다. 그 바로 아래의 스크립트 파일은 사라지므로 핸들러의 직접 경로는 스펙 DECISION17 의 직접 경로 호출과 같게 다룬다(doctor 의 `DIRECT-PATH`, 스펙 부록, PR3 머지 전 고침).

## 인터페이스와 데이터

### 명령 표 항목

```ts
type Command = {
  group: string; verb: string | null   // `orch wait` 은 verb null. 두 낱말 동작(`reserve prune`)은 공백으로 잇고 긴 것부터 맞춘다
  script: string                        // scripts 기준 상대경로. PR3 에서 `wait/wait-important.ts` 꼴
  prepend: string[]                     // 예: loop start → ['--start']
  positional: { flag: string; repeat: boolean } | null
                                        // 위치 인자를 옵션으로 바꾼다. wait ack-lost → 값마다 --ack-lost,
                                        // worker screen → --terminal <값> (prepend 의 --state 와 함께),
                                        // worker worktree → --repo <값>. 위치 인자로 준 값은 그 문맥의 명시로 본다
  context: Array<'repo' | 'run' | 'specs-dir' | 'loop-repo'>
  required: Array<'repo' | 'run' | 'specs-dir'>
                                        // 스크립트가 지금 반드시 받는 문맥 인자(실측 2026-11-04: wait 의 run).
                                        // 명시도 문맥도 설정도 없으면 진입점이 「--run <Run> 을 준다」 처럼 줄 값을 알리고 2 로 끝난다(REQ3)
  runFrom: 'any' | 'run-current'        // run 을 채울 출처. worker send 는 run-current 만 쓴다. 설정의 finish.run 이 dispatch 의
                                        // 실제 Run 보다 앞서지 않게 하려는 것이다(send-to-worker.ts 의 `a.run || described.runId`)
  allow: string[]                       // 금지 플래그의 접두지만 스크립트의 옵션인 이름(wait 의 `--ack`)
  skip: (args: string[]) => Array<'repo' | 'run' | 'specs-dir' | 'loop-repo'>
                                        // 인자에 따라 채우지 않는 문맥. 아래 표의 「예외」 칸(`--live` 없음, `--apply` 없음,
                                        // `--all`, `--worktree`, `--repo` 하나라도)을 이 함수로 적는다. 없으면 빈 배열
  explicit: Partial<Record<'repo' | 'run' | 'specs-dir', RegExp[]>>
                                        // 이 꼴이 있으면 그 문맥을 명시로 본다. queue merge 의 run:
                                        // `--run`, `--finish-arg=--run`, `--finish-arg --run`, `--sweep-arg --run`
  forbid: string[]                      // 새 꼴에서 받지 않는 옛 모드 플래그. 줄여 쓴 꼴(`--ack-l`)도 접두로 맞춰 거부한다.
                                        // 스크립트의 expandArgs 가 접두를 펼쳐 금지를 우회하기 때문이다. 단 스크립트의 다른 옵션과
                                        // 이름이 정확히 같은 낱말(`--ack` 는 `--ack-lost` 의 접두지만 옵션이다)은 금지하지 않는다.
                                        // 그 이름은 아래 `allow` 에 적는다
                                        // 금지 검사는 위치 인자 변환과 prepend 보다 먼저, 사용자가 준 인자에만 한다
  passthrough: boolean                  // slot heavy, slot mem. --full 을 떼지 않고 문맥도 채우지 않는다
  legacy: { name: string; flags: string[] } | null
                                        // 옛 이름과 그 동작을 고르는 옛 모드 플래그. orch-loop --start 는 { name: 'orch-loop', flags: ['--start'] }.
                                        // 옛 꼴 안내가 이름과 플래그 조합으로 새 꼴을 찾는다. 플래그 없는 행이 그 이름의 기본 동작이다
  usage: string                         // `orch <묶음> <동작> --help` 에 낼 새 꼴 사용법 한 줄
}
```

문맥 칸은 스크립트가 그 인자를 받을 때만 둔다. 스펙 「명령 표」 의 행마다 아래로 정한다. 비운 명령은 문맥을 읽지 않는다.

| 새 꼴 | 문맥 칸 | 예외 |
| --- | --- | --- |
| `wait` | run, loop-repo | `--ack-lost` 계열(`wait ack-lost`)은 run 만. run 은 required |
| `wait questions` | run, repo | |
| `wait triage` | run(`--live` 일 때만) | |
| `loop start`, `loop run` | repo, run, specs-dir | |
| `loop stop` | repo, run | `stop --all` 이면 run 을 채우지 않는다 |
| `loop status`, `loop stalled` | repo | `loop stalled` 는 run 을 채우지 않는다(스펙 DECISION23). 스크립트가 루프 등록 Run 을 모두 보는 지금 동작이 사람용 확인에 맞다 |
| `worker launch` | run, repo | `--worktree` 를 주면 repo 를 채우지 않는다(둘은 함께 못 쓴다) |
| `worker send`, `worker adopt` | run(adopt 는 `--apply` 일 때만), repo(adopt) | worker send 의 run 은 run-current 에서만 채운다 |
| `queue merge`, `queue conflicts`, `queue ready`, `queue finish` | repo, run(ready 빼고) | queue merge 는 `explicit` 의 `--finish-arg`, `--sweep-arg` 안의 `--run` 도 명시로 본다 |
| `queue run`, `queue overlap`, `queue reserve`, `worker worktree`, `doctor gh-usage` | repo | |
| `cleanup sweep` | repo, run, specs-dir | `--repo` 를 하나라도 주면 repo 를 채우지 않는다 |
| `cleanup handoff`, `doctor migrate`, `doctor migrate-hooks` | repo, run | |
| `doctor` | repo | run 을 채우지 않는다(스펙 DECISION23). 스킬 첫 점검(`--run` 없이 부른다)이 지금처럼 Run 별 점검과 `session-resume` 을 하지 않게 한다. Run 을 보려면 `--run` 을 준다 |
| `board sync`, `board release`, `study …`, `spec lint`, `paths` | repo | |
| `worker ask` | 없음 | worker 터미널은 Run 에 묶이지 않고, `worker-ask` 는 `check` 결과에서 Run 을 읽는다 |
| 그 밖 | 없음 | |

### 문맥 풀기

- 저장소: `mainCheckout(cwd)`. git 저장소 밖이면 채우지 않는다. 스크립트가 지금처럼 판정한다(대부분 cwd 기본값이나 사용법 오류).
- Run: `orca orchestration run-current --json --full` 의 `run.id`(5초 제한). 못 읽으면 저장소 설정의 `finish.run`. 둘 다 없으면 채우지 않는다.
- 기준 저장소: 설정(`finish.run`, `finish.specs_dir`), 지시서 폴더, 루프 저장소는 명시한 `--repo` 가 있으면 그 저장소에서, 없으면 위에서 채운 저장소에서 읽는다. `--repo` 가 둘 이상이면(`cleanup sweep`) 지시서 폴더를 채우지 않는다. 한 절대경로가 여러 저장소의 지시서 지우기에 쓰이지 않게 하려는 것이다.
- 지시서 폴더: `finish.specs_dir`, 없으면 `pathOf('specs', repo)`.
- 루프 저장소: 위 저장소의 루프 기록에 위 Run 이 등록돼 있으면(`lib/loop.ts` 의 `isRegistered`) 루프가 살았는지와 상관없이 그 저장소. 루프가 죽었으면 `wait-important` 가 `--loop-repo` 로 `LOOP-DEAD` 를 내야 하기 때문이다.
- `--ack` 가 있는 `wait` 은 `run-current` 를 읽지 못하면 설정의 `finish.run` 으로 대신하지 않는다. 다른 Run 의 delivery 를 ack 하지 않게 한다. 일시 지연으로 대기가 끊기지 않도록 이 경우만 제한을 15초로 늘려 한 번 더 읽고, 그래도 못 읽으면 사용법 오류(2)와 `--run <Run>` 을 붙이라는 줄을 낸다.
- 넣는 자리: 앞 인자(`prepend`) 바로 뒤, 첫 `--` 앞이다. `worker launch` 의 `-- WORKER_ARGS` 처럼 `--` 뒤는 다른 명령에 넘어가는 인자라 읽지도 넣지도 않는다.
- 위치 인자: 첫 옵션 앞의 낱말만 위치 인자로 바꾼다. 진입점은 스크립트의 옵션 표를 몰라 옵션 값과 위치 인자를 가리지 못하기 때문이다. 그래서 새 꼴의 사용법은 위치 인자를 옵션보다 앞에 둔다(`orch worker check <워크트리> --spec …`).
- 명시 판정: 첫 `--` 앞에서 `--<이름>`, `--<이름>=…` 과 `explicit` 의 꼴, 그 문맥으로 바꾼 위치 인자를 찾는다. 한계: 진입점은 옵션의 값과 옵션을 가리지 못한다. `--body --ru` 처럼 값이 문맥 이름의 앞부분이면 사용법 오류로 걸리고, `--sweep-arg --repo` 의 값은 명시로 본다. 값은 `--body=--ru` 꼴로 주면 피한다. 새 꼴에서는 그 명령의 문맥 칸에 든 인자를 줄여 쓰지 못한다. 첫 `--` 앞에서 그 이름의 앞부분만 준 옵션(`--re`, `--ru`)은 사용법 오류다. 문맥 칸에 specs-dir 이 있는 명령(`loop start`, `loop run`, `cleanup sweep`)에는 `--spec` 옵션이 없어 부딪치지 않는다. 줄여 쓴 옵션을 모른 채 값을 하나 더 넣으면 `cleanup-sweep` 의 여러 번 받는 `--repo` 에 저장소가 하나 더 붙는다. 옛 꼴은 지금처럼 `lib/args.ts` 가 펼친다.
- stderr: `orch: 문맥 repo=<경로>(작업 폴더) run=<id>(run-current) specs-dir=<경로>(설정)`. 채운 값이 없으면 내지 않는다.
- 필수 문맥: 명령 표의 `required` 에 든 인자를 명시도 문맥도 설정도 주지 못하면 진입점이 `orch: --run <Run> 이 필요하다. 코디네이터 터미널에서 부르거나 --run 을 준다` 꼴로 알리고 2 로 끝난다(REQ3). 그 밖의 인자는 스크립트가 지금처럼 기본값을 쓴다.

### 옛 꼴 안내와 `--help`, `--path`

- 옛 꼴은 `orch: 새 꼴: orch <묶음> <동작> …` 한 줄을 stderr 에 낸다. 옛 이름과 모드 플래그 조합으로 새 꼴을 고른다(`orch-loop --start` → `orch loop start`).
- 옛 진입점의 `--path [이름]`(스펙 DECISION3)도 옛 꼴로 받는다. 이름이 없으면 스크립트 폴더, 이름이 있으면 그 스크립트 파일 경로를 낸다. 경로는 명령 표의 `script` 로 푸므로 PR3 뒤에도 실제 파일을 가리킨다.
- `orch --help` 는 묶음과 동작 목록, `orch <묶음> --help` 는 그 묶음의 동작과 `usage` 를 낸다. `orch <묶음> <동작> --help` 는 `usage` 한 줄과 「옵션은 아래 스크립트 사용법을 따른다. 동작으로 바뀐 옛 모드 플래그(`forbid`)는 쓰지 않는다」 를 낸 뒤 스크립트의 `--help` 를 이어 낸다. 스크립트 사용법을 다시 쓰지 않으려는 것이다.

### PATH 가 없는 셸

Codex 는 플러그인 `bin/` 을 PATH 에 넣지 않는다. `install-cli` 전에는 `orch` 가 없으므로 `orch doctor` 도 `orch doctor install-cli` 도 돌지 않는다.
`skills/orch/SKILL.md` 의 첫 점검 한 곳에 `command -v orch >/dev/null || orch() { node "$SKILL_DIR/../../bin/orch" "$@"; }` 를 두고(실행기를 불러 낮은 node 에서도 `NODE-TOO-OLD` 가 나온다), 그다음 줄에서 `orch doctor` 를 부른다. 셸 함수는 그 Bash 호출 안에서만 산다. 다른 문서는 이 자리를 가리키고 같은 줄을 되풀이하지 않는다.
worker 가 읽는 공통 지시서 틀은 `$SKILL_DIR` 이 없으므로 설치 기록에서 진입점을 푸는 한 줄로 같은 셸 함수를 둔다(DECISION10).

### 옛 꼴과 직접 경로 판정

doctor 가 `--repo` 저장소(없으면 작업 폴더의 주 checkout)에서 본다. 플러그인 안의 문서는 문서 판정(REQ8)이 보고 이 판정은 보지 않는다.

| 판정 | 보는 파일 | 찾는 꼴 | 고칠 줄 |
| --- | --- | --- | --- |
| `OLD-CALL <파일>:<줄> <옛 이름>` | `.orch/overlay.md`, `.orch/config.json`, `.orch/specs/spec-common.md`, `.orch/bin/*`, `.orch/hooks/*`, `.claude/skills/**` 의 텍스트 파일 | `orch.ts` 나 `orch.mts` 뒤의 옛 이름(따옴표, `"$ORCH"` 변수 꼴 포함), `orch.ts --path <옛 이름>` 과 `orch.mts --path <옛 이름>`, `orch-doctor.py` | 명령 표의 새 꼴 한 줄 |
| `DIRECT-PATH <파일>:<줄> <스크립트>` | 같다 | `orch/scripts/<이름>.ts`, `skills/orch/scripts/<이름>.ts`, `$SKILL_DIR/scripts/<이름>.ts`, `$ORCH_SCRIPTS/<이름>.ts`, `join(ORCH_SCRIPTS, '<이름>.ts')` 꼴. `<이름>` 이 명령 표의 `script` 인 것만 | 같다 |

- 한 줄에 둘이 함께 걸리면 `OLD-CALL` 하나로 낸다.
- 예외 표지: 같은 줄이나 바로 윗줄에 `orch-compat` 가 있으면 내지 않는다(호환을 설명하는 자리). Markdown 본문은 `<!-- orch-compat -->`, 코드 블록 안은 셸 주석 `# orch-compat` 로 단다. 플러그인 문서의 예외(REQ8)도 같은 표지를 쓴다.
- 대기 출력 JSON 을 읽는 저장소 스크립트(ai-analysis `.orch/bin/wait-summary.py`)는 경로를 부르지 않아 이 판정에 걸리지 않는다. PR2 의 짧은 출력과 함께 다룬다.
- 이 판정이 0건인 것이 옛 이름을 지우는 PR(스펙 DECISION13)을 여는 조건이므로, 오탐을 줄이려고 `<이름>` 을 명령 표의 스크립트로 한정한다.

### NEXT_WAIT (PR1)

`NEXT_WAIT <앞> wait --ack <id> [기본값과 다른 인자] [--lost-state <절대경로>] --loop-repo <절대경로>...`.
`<앞>` 은 `lib/commands.ts` 의 `orchWord()` 다. PATH 를 읽으므로 테스트는 PATH 를 고정한다. PATH 의 `orch` 가 표지 주석이 있는 실행기면 `orch`, 아니면 진입점 절대경로(`'<번들>/skills/orch/bin/orch.ts'`)다.
`--run` 은 출처로만 정한다. `orchContext()` 가 run 을 run-current 에서 채웠다고 알렸을 때만 빼고, 명시했거나 설정에서 온 Run 은 값이 run-current 와 같아도 적는다.
`--lost-state` 의 기본값(시작 폴더의 주 checkout 의 `state/wait-important-lost.json`)은 바꾸지 않는다. 기본값을 쓴 대기에서 시작 폴더의 주 checkout 이 첫 `--loop-repo` 의 주 checkout 과 같으면 `--lost-state` 를 뺀다. 다음 대기를 같은 저장소의 어느 폴더(지워진 워크트리 포함, `wait-important` 가 루프 저장소로 옮긴다)에서 걸어도 같은 상태 파일이다. 다르거나, `--loop-repo` 가 하나도 없거나, `--lost-state` 를 명시했으면 절대경로로 적는다. 다른 저장소 폴더에서 빠진 꼴을 다시 걸면 그 저장소의 상태 파일을 읽어 끊긴 worker 를 한 번 더 알릴 수 있다. 판정이 아니라 알림 한 번의 차이라 받아들인다. 기본값을 루프 저장소 기준으로 바꾸면 `orch wait ack-lost` 와 상태 파일이 갈라지고 판정이 바뀐다(스펙 「범위 밖」).
`--types`, `--timeout-ms`, `--lost-interval-sec`, `--completion-contract` 는 parseArgs 의 기본값과 다를 때만 적는다. 기본값은 한 상수에서 읽는다.

### 짧은 출력 (PR2)

- 진입점이 자식에게 `ORCH_OUTPUT=short` 를 넘긴다. `--full` 은 진입점이 떼고 넘기지 않는다. 스크립트는 `lib/output.ts` 의 `short()` 가 참일 때 설명과 진행 줄을 내지 않는다.
- 판정 낱말이 이미 있는 줄은 그대로 남긴다. 판정 낱말이 없는 명령은 아래로 새로 정한다. 경로와 데이터가 결과인 명령과 감싼 명령의 출력은 그대로다(스펙 DECISION20).

| 명령 | 짧은 출력 |
| --- | --- |
| `wait` | 메시지마다 `<종류> <dispatch> <task> <본문 앞 120자>`(종류: `DONE-SUSPECT`, `DONE`, `STOPPED`, `ESCALATION`, `QUESTION`, `STATUS`). 이어서 `HEARTBEAT <개수>`, `RAW <원문 파일>`, `LAST_DELIVERY <id>`. `LOOP-EVENT`, `LOOP-DEAD`, `TIMEOUT`, `WATCH-ERROR` 줄은 그대로 |
| `loop start/stop/status` | 지금의 `LOOP-*` 줄 하나. `안내:` 줄은 `--full` 에만 |
| `loop stalled` | 지금의 `STALLED`, `STAGE` 줄. `MOVING` 은 `--full` 에만 |
| `worker launch` | `LAUNCHED <dispatch> <터미널> <워크트리>` 와 `lint-ack:`, `dirty-ack:` 줄. 단계 감시 진행 줄은 `--full` 에만 |
| `worker send` | `REPLIED`, `SENT`, `RESUMED`, `QUEUED`, `DELIVERED` 가운데 하나와 대상 id. 지금의 `closed:`, `retry:`, `fallback:` 은 `NOTE <내용>` 한 줄로 |
| `worker nudge`, `worker screen` | 지금처럼 첫 낱말 한 줄 |
| `worker ask` | 지금처럼 첫 줄 `answer: …`. ask 의 JSON 은 `--full` 에만 |
| `queue merge`, `queue run` | PR 마다 `MERGED <PR>`, `STOP <PR> <이유>`, 끝 줄 `QUEUE-DONE` 이나 `QUEUE-HELD …`. 마무리 시작은 `FINISH-STARTED <PR> <로그>` |
| `queue finish` | `FINISH-DONE` 이나 `FINISH-FAIL <이유>` 와 `LAST-PR <마지막/중간>` |
| `queue ready` | PR 마다 `READY <PR>` 이나 `HELD <PR> <이유>` |
| `queue conflicts` | 지금의 `#<PR> CONFLICTING …` 줄을 `CONFLICT <PR> <브랜치> <결과>` 로. `CONFLICT-ORPHAN` 은 그대로 |
| `cleanup sweep`, `cleanup worktree`, `cleanup handoff` | 지운 것 `REMOVED <경로>`, 남긴 것 `KEPT <경로> <이유 한 낱말>`, 끝 줄 `SWEEP <지운 수> <남긴 수>` |
| `board …`, `study …`, `spec lint`, `doctor` | 지금 줄이 이미 판정 줄이다. 설명 줄만 `--full` 로 |
| `status` | 저장소마다 `LOOP-ALIVE`/`LOOP-DEAD`, Run 마다 `RUN <id> workers=<살아 있는 수> stalled=<수>`, 보드 `BOARD doing=<수> decide=<수>`, 멈춘 것마다 `STALLED`, `STAGE` |

PR2 계획이 스크립트마다 지금 출력 줄을 위 꼴로 대응시키고, 대응이 없는 줄은 `--full` 로 보낸다.

### 저장 파일

- `<orch 루트>/state/wait/<delivery>.json`(PR2): 짧은 대기 출력의 원문. orch 루트는 `--lost-state` 와 같은 시작 폴더의 주 checkout 이다. `orch wait triage` 가 읽는다. 다음 대기가 그 delivery 를 ack 하면 지우고, ack 하지 못하고 세션이 끝난 파일은 `wait-important` 가 시작할 때 7일 지난 것을 지운다.
- 그 밖의 상태 파일은 바뀌지 않는다.

## 실패와 일관성

- 번들 고르기(원본 `lib/install-record.ts` 의 `selectBundle`, 사본은 실행기와 틀): `ORCH_SCRIPTS_DIR` 이 있으면 그 폴더의 번들. 아니면 설치 기록에 user 범위 항목이 있으면 그 항목만 보고, 그 번들에 `skills/orch/scripts` 가 없으면 다른 범위로 넘어가지 않고 3 이다(REQ6). 3.x 배치(`orch/scripts`)만 있는 user 번들도 3 이고 이유에 플러그인 갱신을 적는다. user 항목이 없으면 지금처럼 다른 범위를 기록 순서대로 보고, 그래도 없으면 실행기·진입점이 든 번들(`claude --plugin-dir` 개발 설치)을 쓴다. `~/.local/bin` 사본은 든 번들이 없어 이유와 `claude plugin install fos-skills@fos-skills` 을 내고 3 이다. user 항목이 있으면 `--plugin-dir` 로 실은 체크아웃의 실행기도 설치본으로 넘긴다(지금 진입점과 같다). 체크아웃을 확인할 때는 지금처럼 `ORCH_SCRIPTS_DIR` 을 준다.
- STALE-BUNDLE 판정의 예외(설치 캐시 `plugins/cache` 밖의 체크아웃은 판정하지 않는다)는 경고에만 쓴다. 진입점의 넘기기에는 쓰지 않는다. `selectBundle` 이 오류면 STALE-BUNDLE 과 doctor 의 `staleBundle` 은 판정하지 않는다(설치 기록 문제는 doctor 의 `PLUGIN-PATH-MISSING` 과 진입점의 3 이 알린다).
- 진입점이 넘길 대상 번들에 진입점이나 `skills/orch/scripts/lib/commands.ts` 가 없으면(이 기능 이전 번들) 실행기와 같이 넘기지 않고 이유와 플러그인 갱신 명령을 내고 3 으로 끝난다.
- 루트 `bin/` 을 막는 `scripts/tests/test_plugin_manifest.py` 의 검사는 「루트 `bin/` 에는 `orch` 하나만 있고 실행 비트가 있다」 로 바꾼다. `bin/orch` 는 git 모드 100755 로 커밋하고 `install-cli` 는 복사한 뒤 0755 로 둔다.
- `CLI-MISSING` 판정: doctor 는 Claude 세션의 Bash(플러그인 `bin/` 이 PATH 에 있다)에서 돌아 사람 셸의 PATH 를 볼 수 없다. 그래서 `~/.local/bin/orch` 가 없거나 표지가 없으면 `CLI-MISSING`, 있는데 PATH 에서 플러그인 `bin/` 폴더를 뺀 나머지에 `~/.local/bin` 이 없으면 `CLI-NOT-ON-PATH` 를 낸다. 표지가 있는데 내용이 현재 번들의 `bin/orch` 와 다르면 `CLI-STALE` 과 `orch doctor install-cli` 를 낸다. 넘기기 규칙 덕에 동작은 맞지만 실행기 자체의 고침(신호, 버전 점검)을 받으려는 것이다.
- `~/.local/bin/orch` 가 이미 있고 표지 주석이 없으면 `install-cli` 는 덮지 않고 `CLI-CONFLICT <경로>` 와 1 로 끝난다. 표지가 있으면 덮어 갱신한다.
- 문맥 조회(`run-current`)가 늦거나 실패해도 명령을 막지 않는다. 다음 출처로 넘어가고, 무엇을 썼는지 stderr 한 줄로 드러낸다.
- 옛 번들의 진입점(4.2.0 이전)이 기억된 `NEXT_WAIT` 로 불리면 지금처럼 현재 번들의 `scripts/<이름>.ts` 를 찾는다. PR3 뒤에는 그 파일이 없어 사용법 오류다. 기억된 `NEXT_WAIT` 는 PR1 설치 뒤 첫 대기부터 새 꼴이 되므로 PR3 까지 남지 않는다. PR3 의 머지 조건(스펙 부록)과 함께 본다.
- 호환: 옛 꼴은 옛 이름을 지우는 PR(스펙 DECISION13)까지 받는다. 배포 순서는 PR1 → PR2 → PR3 이고 PR 마다 홀로 돈다.
- 신호 누수: `ORCH_ENTRY_HOP` 은 진입점이 스크립트 자식에게 넘기기 전에 지운다. `ORCH_CONTEXT`(PR1)와 `ORCH_OUTPUT`(PR2)은 `lib/bundle.ts` 가 모든 진입 스크립트에서 지운다. 상주 루프와 핸들러(`lib/events.ts` 의 `{...process.env}`)로 새지 않는다.
- 문서 판정의 새 꼴 찾기: 백틱 안이나 코드 블록 안에서 `orch ` 뒤에 ASCII 소문자 낱말이 오는 것만 명령으로 본다. 산문의 「orch 루트」, 「orch 스킬」 은 보지 않는다. 그 낱말이 명령 표의 묶음이 아니면 `MISSING` 이다.
- PR3 의 Python 자리: `orch-doctor.py` 와 `ts_shim.py` 는 옛 호출의 호환 진입점이라 `scripts/` 바로 아래에 남긴다. 실행기의 Node 최소 버전은 `ts_shim.py` 의 `MIN_NODE` 와 같은 값이고 PR1 테스트가 대조한다.

## 검증 전략

- REQ11 의 「같은 분류」 는 같은 시점의 상태에서다. 원문을 나중에 `orch wait triage` 로 다시 읽으면 완료 판정(`lib/completion.ts`)을 그때의 orca 상태로 다시 하므로 의심 표시가 풀릴 수 있다. PR2 에서 `triage-messages.ts` 의 분류 함수를 export 하고, 리뷰 판정 저장소는 대기의 첫 `--loop-repo` 를 넘긴다.
- REQ1, REQ6: 임시 설정 폴더와 가짜 번들로 실행기와 진입점을 돌리는 node 테스트(`skills/orch/tests/orch-entry.spec.ts` 를 넓히고 `orch-launcher.spec.ts` 를 더한다). user 범위 번들에 스크립트가 없는 기록, user 항목이 없는 기록, `~/.local/bin` 사본(HOME 을 임시 폴더로), 이 기능 이전 번들로 넘길 때를 본다. 같은 설치 기록 사례 표를 `selectBundle`, 실행기, 틀의 한 줄 풀이에 돌려 셋의 답이 같은지 본다. 실행기와 진입점이 받은 SIGTERM 을 자식에게 전하고 128+15 로 끝나는지 본다.
- 고아 대기: 가짜 ps 로 `init → zsh → node bin/orch → node orch.ts → wait-important` 사슬을 보이면 `--kill-stale` 이 그 대기를 고아로 찾는다(`wait-important.spec.ts`).
- 신호 누수: 진입점으로 부른 스크립트가 다시 띄운 자식의 환경에 `ORCH_ENTRY_HOP`, `ORCH_CONTEXT` 가 없다.
- REQ2, REQ5: 명령 표의 행마다 새 꼴과 옛 꼴이 같은 스크립트와 인자로 풀리는지 표 기반 테스트(문맥을 끈 해석). 문맥이 더해진 뒤의 「같은 판정과 종료 코드」 는 가짜 번들의 스크립트로 새 꼴과 같은 값을 명시한 옛 꼴을 돌려 stdout 과 종료 코드를 비교한다. 금지 플래그(줄여 쓴 꼴 포함)와 줄인 문맥 인자의 사용법 오류.
- REQ3: 임시 git 저장소와 가짜 `orca`(ORCA 환경 변수)로 출처별 채우기와 stderr 줄.
- REQ4: `wait-important` 테스트에 `NEXT_WAIT` 꼴(실행기가 PATH 에 있을 때와 없을 때, run 의 출처가 run-current 일 때와 명시일 때). PR2 는 명령마다 짧은 출력과 `--full` 의 스냅숏 테스트.
- REQ7: doctor 테스트에 임시 저장소의 옛 꼴, 직접 경로, `orch-compat` 예외 표지, PATH 조작, 낡은 `~/.local/bin` 사본.
- REQ8: doctor 의 문서 스크립트 판정(`--skip-version`)이 새 꼴을 명령 표로 확인하고, 저장소 문서에 `"$SKILL_DIR/bin/orch.ts"` 호출이 남지 않았는지 보는 검사(`scripts/tests/test_doc_script_refs.py` 를 넓힌다).
- 훅: `block-background-wait.spec.ts` 에 `orch wait` 과 진입점 절대경로 꼴을 더한다. `orch wait triage` 와 `orch wait ack-lost` 는 대기가 아니다.
- REQ9(PR3): 기존 테스트 전체와 ps 명령줄 판정 테스트. REQ10, REQ11(PR2): 가짜 상태 파일과 가짜 `orca` 로 판정 줄.
- 실측: PR1 머지 뒤 이 머신에서 `orch loop status`, `orch doctor` 를 Claude 세션과 사람 셸(`install-cli` 뒤)에서 돌린다. PR 본문의 후속 검증으로 둔다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 실행기와 진입점을 나눈다 | PATH 의 `orch` 는 번들을 찾아 넘기기만 하고 명령 표는 번들의 진입점이 갖는다 | 작성자 | `~/.local/bin` 사본은 갱신되지 않는다. 표를 사본에 두면 새 명령을 모른다 |
| DECISION2 | 실행기 언어 | 확장자 없는 CommonJS JavaScript | 작성자 | 플러그인 `bin/` 은 확장자 없는 실행 파일이라야 맨 이름으로 불린다. 타입 문법이 없어야 node 가 그대로 읽고, CommonJS 라 낮은 node 에서도 `NODE-TOO-OLD` 를 낼 수 있다(ADR-011) |
| DECISION3 | 문맥을 채우는 방법 | 진입점이 빠진 인자를 명령줄에 더한다. 스크립트의 인자 처리는 고치지 않는다 | 작성자 | 「명시 > 문맥 > 설정」 이 스크립트마다 다시 구현되지 않는다. 스크립트는 지금처럼 명시 인자 > 설정 순서로 읽으므로 진입점이 더한 값이 설정보다 앞선다 |
| DECISION4 | 새 꼴의 문맥 인자 줄여 쓰기 | 받지 않는다(사용법 오류) | 작성자 | 줄여 쓴 옵션을 진입점이 모르면 같은 인자가 둘 들어간다. 옛 꼴의 줄여 쓰기 호환(lib/args.ts)은 그대로다 |
| DECISION5 | 짧은 출력 신호 | 환경 변수 `ORCH_OUTPUT=short` 를 스크립트가 시작할 때 읽고 지운다 | 작성자 | 플래그로 넘기면 `merge-with-finish` 처럼 인자를 다른 스크립트에 그대로 넘기는 명령이 그 플래그를 흘린다. 지우지 않으면 자식 스크립트가 물려받는다 |
| DECISION6 | 명령 표의 자리 | `skills/orch/scripts/lib/commands.ts` | 작성자 | 진입점, doctor, 훅이 같은 표를 읽는다. 훅은 이미 `../scripts/lib` 를 가져온다 |
| DECISION7 | 진입점이 현재 번들이 아닐 때 | 현재 번들의 진입점에 넘긴다 | 작성자 | 명령 표가 늘 현재 번들의 것이어야 폴더 이동 뒤에도 옛 경로의 진입점이 돈다 |
| DECISION9 | 진입점 신호(`ORCH_CONTEXT` 는 PR1, `ORCH_OUTPUT` 은 PR2)를 지우는 자리 | `lib/bundle.ts`(모든 진입 스크립트가 `lib/args.ts`, `lib/proc.ts` 로 먼저 import 한다). 출력을 그대로 넘기는 `merge_queue` 에만 부모가 짧은 출력 신호를 명시해 넘긴다 | 작성자 | 신호를 읽는 모듈만 지우면 출력을 바꾸지 않는 스크립트(heavy-slot)의 자식에 새고, `merge-with-finish` 는 자식 출력을 거를 수 없다 |
| DECISION10 | 템플릿의 `orch` 부르기 | `templates/spec-common.md` 는 `orch worker ask …` 로 쓰고, `command -v orch` 가 없을 때 쓸 한 줄(설치 기록에서 진입점을 풀어 `orch` 셸 함수로 두기)을 함께 둔다 | 작성자 | `install-cli` 를 하지 않은 머신의 Codex worker 셸에도 `orch` 가 없을 수 있다 |
| DECISION11 | 핸들러가 orch 를 부르는 통로 | `ORCH_BIN`(진입점 절대경로)을 더하고 문서 예시를 새 꼴로 바꾼다. `ORCH_SCRIPTS` 는 유지한다 | 작성자 | 핸들러 환경의 PATH 앞에는 가드 폴더가 있고 `orch` 가 PATH 에 있다고 볼 수 없다. 진입점 경로를 넘기면 폴더 이동과 상관없이 돈다 |
| DECISION8 | ADR | ADR-004 를 고쳐 루트 `bin/` 에 `orch` 하나만 허용한다. 새 ADR 은 만들지 않는다 | 사용자 2026-11-04 | 스펙 DECISION4 |
| DECISION12 | 스크립트의 안내 줄 | 다른 orch 스크립트를 부르라고 안내하는 줄은 PR1 에서 새 꼴로 바꾼다. 스펙 DECISION16 의 예외다. `사용법:` 줄과 판정 줄은 바꾸지 않는다 | 작성자 | 이 줄은 사람과 에이전트가 붙여 넣는 안내라 읽는 코드가 없다. 옛 꼴로 남으면 옛 이름을 지우는 PR 뒤 안내가 사용법 오류를 부른다 |
| DECISION13 | `--lost-state` 기본값 | 바꾸지 않는다. 시작 폴더와 루프 저장소가 같은 저장소면 `NEXT_WAIT` 에서 빼고, 아니면 절대경로로 남긴다 | 작성자 | 기본값을 루프 저장소 기준으로 바꾸면 `wait ack-lost` 와 상태 파일이 갈라지고 같은 입력의 판정이 바뀐다(스펙 「범위 밖」). 독립 검토(2026-11-04)의 지적이다 |
| DECISION14 | 번들 고르기 규칙의 원본 | `lib/install-record.ts` 의 `selectBundle`. 실행기와 틀의 JS 사본은 같은 사례 표 테스트로 묶는다 | 작성자 | 이 기능의 발단(3.x 진입점이 user 4.0.1 을 건너뜀)이 사본마다 규칙이 달라서 난 일이다. CommonJS 실행기와 셸 한 줄은 TS 를 import 할 수 없어 사본을 없앨 수는 없다 |
| DECISION15 | 프로세스 사슬이 늘어난 것 | 고아 대기 판정이 실행기와 진입점을 셸처럼 통과하는 노드로 본다. 진입점을 `exec` 처럼 대체하지 않는다 | 작성자 | node 는 프로세스를 바꿔치기할 수 없다. 대기 찾기(`lib/waiters.ts`)는 자식 `wait-important` 의 명령줄로 그대로 찾는다 |
| DECISION16 | PR1 의 크기 | 스펙 DECISION14 대로 PR 하나로 두고 plan 의 phase 마다 테스트를 통과한 커밋 하나로 나눈다. 변경 파일 40개 초과는 문서 일괄 교체 몫이다 | 사용자 2026-11-04 | 스펙 DECISION14 다. 독립 검토가 PR 을 둘로 나누자고 했으나 사용자 결정을 바꿀 새 근거는 아니다. 문서 교체는 명령 표가 생긴 뒤에야 검사할 수 있어 같은 PR 이 맞다 |
| DECISION17 | 필수 문맥과 doctor 의 Run | 스크립트가 지금 반드시 받는 인자만 `required` 로 두고 진입점이 알린다. `doctor` 는 Run 을 문맥으로 채우지 않는다 | 작성자 | 스펙 REQ3 의 실패 인수 조건을 스크립트를 고치지 않고 채운다. doctor 에 Run 을 채우면 스킬 첫 점검마다 Run 별 점검과 `session-resume` 핸들러가 돌아 지금 동작이 바뀐다. 계획 critic(2026-11-04)의 지적이다 |
