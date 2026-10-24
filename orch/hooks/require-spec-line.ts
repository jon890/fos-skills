// PreToolUse(Bash) hook: `worker-start --spec` 값이 `spec-line` 이 만드는 한 줄 꼴이 아니면 거부한다.
//
// `--spec` 에 지시 본문을 직접 넣으면 길이 제한과 따옴표에서 잘리고, 지시서의 `허락:` 줄이 빠져
// Codex worker 가 push 와 PR 생성을 사용자의 허락으로 보지 않고 멈춘다.
// `spec-line` 은 `지시서 <경로> 를 끝까지 읽고 수행한다. <허락 문구> 못 읽으면 escalation 으로 알린다.` 를 낸다.
//
// 판정:
//     명령에 `orchestration worker-start` 가 있고 `--spec` 값이 따옴표로 감싼 글자 그대로면,
//     그 값이 `지시서 /<경로>.md 를 끝까지 읽고 수행한다.` 로 시작하고 `못 읽으면 escalation 으로 알린다.` 로 끝나야 한다.
//
// 오탐을 피하는 기준:
//     - 따옴표 안, heredoc 본문, 주석에 든 `worker-start --spec` 문구는 명령이 아니라 보지 않는다(커밋 메시지, 문서 쓰기)
//     - `--spec` 은 `worker-start` 와 같은 명령 조각(`;`, `&&`, `|`, 줄바꿈으로 나눈 단위)에 있는 것만 본다
//     - 값에 `$` 가 들면(`"$LINE"`, `"$(node ... .../spec-line.ts ...)"`) 실행해야 알 수 있어 통과한다
//     - `launch-worker` 와 `send-to-worker` 는 스크립트 안에서 worker-start 를 부르므로 이 hook 을 거치지 않는다
//     - `worker-start` 가 아닌 명령의 `--spec` 은 보지 않는다
//
// 입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
// hooks.json 은 이 파일을 PATH 의 `node` 로 부른다. node 를 찾지 못하면 Claude Code 는 오류를 보이고 막지 않는다.

import { hookCommand, mask, pieces, stripHeredocs } from './shell-text.ts'

const WORKER_START = /\borchestration\s+worker-start\b/
const SPEC_FLAG = /--spec(?:\s+|=)/g
// sticky: 원문의 --spec 바로 뒤에서만 맞춘다
const SPEC_VALUE = /'([^']*)'|"((?:\\[^\n]|[^"\\])*)"|([^\s'"]+)/y
const SPEC_LINE = /^지시서 \/\S.*?\.md 를 끝까지 읽고 수행한다\..*못 읽으면 escalation 으로 알린다\.$/s

const REASON =
  'orch: `worker-start --spec` 에는 `spec-line` 이 만든 한 줄만 준다. ' +
  '본문을 직접 넣으면 잘리거나 `허락:` 줄이 빠진다. ' +
  '`launch-worker` 로 띄우거나, `--spec "$(node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/spec-line.ts" "$SPEC" --require-permission)"` 로 넘긴다.'

type SpecValue = { single?: string; double?: string; bare?: string }

// worker-start 조각의 --spec 값. 가린 글에서 자리를 찾고 원문에서 값을 읽는다.
function specValues(command: string): SpecValue[] {
  const text = stripHeredocs(command)
  const masked = mask(text)
  const values: SpecValue[] = []
  for (const { start, end } of pieces(masked)) {
    const piece = masked.slice(start, end)
    if (!WORKER_START.test(piece)) continue
    for (const flag of piece.matchAll(SPEC_FLAG)) {
      SPEC_VALUE.lastIndex = start + flag.index + flag[0].length
      const m = SPEC_VALUE.exec(text)
      if (m) values.push({ single: m[1], double: m[2], bare: m[3] })
    }
  }
  return values
}

function rawSpec(command: string): boolean {
  for (const { single, double, bare } of specValues(command)) {
    const value = single ?? double ?? bare ?? ''
    if (single === undefined && value.includes('$')) continue
    if (!SPEC_LINE.test(value.trim())) return true
  }
  return false
}

const command = hookCommand()
if (command !== null && rawSpec(command)) {
  const decision = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + '\n')
}
