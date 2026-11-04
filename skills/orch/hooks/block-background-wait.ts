// PreToolUse(Bash) hook: `orca orchestration check --wait`, `wait-important`, 새 꼴 `orch wait` 를 셸의 `&` 나 `nohup` 으로 띄우면 거부한다.
//
// 셸의 `&` 로 띄운 대기는 끝나도 하네스가 완료 알림을 주지 않아 코디네이터가 깨어나지 못하고, 고아 프로세스로 남는다.
// 둘째 대기는 `waiter_exists` 로 바로 끝나 그 뒤의 대기까지 망가진다(코디네이터 2회).
// `references/waiting.md` 의 산문만으로는 같은 실수가 되풀이돼 명령 단계에서 막는다.
//
// 판정:
//     한 줄(역슬래시 줄 잇기는 한 줄로 본다)에 `orchestration check` 와 `--wait` 가 함께 있거나 `wait-important` 가 있거나
//     새 꼴 대기(`orch wait`, 진입점·실행기 경로 뒤의 `wait`)가 있고,
//     그 줄에 `nohup`, `setsid`, `disown` 이 있거나 리다이렉션과 `&&` 가 아닌 `&` 가 있으면 거부한다.
//     `run_in_background` 로 돌리는 명령과 앞에서 기다리는 명령은 통과한다.
//     `orch wait` 묶음의 다른 동작(`orch wait triage`, `orch wait ack-lost` 같은 것)은 대기가 아니라 보지 않는다. 동작 이름은 명령 표에서 읽는다.
//
// 입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
// hooks.json 은 이 파일을 PATH 의 `node` 로 부른다. node 를 찾지 못하면 Claude Code 는 오류를 보이고 막지 않는다.

import { COMMANDS } from '../scripts/lib/commands.ts'
import { hookCommand, QUOTED, stripHeredocs } from './shell-text.ts'

// wait-important 는 안에서 check --wait 를 부르므로 같은 규칙으로 막는다
const CHECK_WAIT = /\borchestration\s+check\b.*\s--wait\b|\bwait-important\b/
// 새 꼴 대기. `orch wait`, `.../bin/orch wait`, `'.../orch.ts' wait` 이고 뒤에 wait 묶음의 다른 동작이 오지 않는 것
const WAIT_VERBS = COMMANDS.filter((c) => c.group === 'wait' && c.verb !== null).map((c) => c.verb as string)
const NEW_WAIT = new RegExp(`(?:^|[\\s/'"])orch(?:\\.ts)?['"]?\\s+wait(?=\\s|$)(?!\\s+(?:${WAIT_VERBS.join('|')})(?:\\s|$))`)
const DETACH = /(^|[\s;|&(])(nohup|setsid|disown)\b/
// 리다이렉션(`2>&1`, `>&2`, `&>`, `&>>`)과 `&&` 를 지운 뒤 남은 `&` 가 백그라운드 실행이다
const NOT_BACKGROUND = /\d*>&\d*-?|&>>?|&&|\|&/g
// Python 의 str.splitlines 가 나누는 줄 경계
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/

const REASON =
  'orch: `orch wait`(옛 `wait-important`)와 `orca orchestration check --wait` 를 셸의 `&` 나 nohup 으로 띄우지 않는다. ' +
  '끝나도 완료 알림이 오지 않고 고아 프로세스가 남는다. ' +
  'Bash 도구의 run_in_background 로 `&` 없이 돌린다. 근거와 명령은 orch 스킬의 references/waiting.md 에 있다.'

function backgroundedWait(command: string): boolean {
  // heredoc 본문은 명령이 아니라 입력이라 보지 않는다
  for (const line of stripHeredocs(command.replaceAll('\\\n', ' ')).split(LINE_BREAK)) {
    if (!CHECK_WAIT.test(line) && !NEW_WAIT.test(line)) continue
    // 따옴표 안의 `&` 는 인자라 백그라운드 실행이 아니다
    const bare = line.replace(QUOTED, "''")
    if (DETACH.test(bare) || bare.replace(NOT_BACKGROUND, ' ').includes('&')) return true
  }
  return false
}

const command = hookCommand()
if (command !== null && backgroundedWait(command)) {
  const decision = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + '\n')
}
