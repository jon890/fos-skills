// 입력 대기로 쉬는 worker 에게 코디네이터 메시지를 읽으라고 터미널에 입력하고, 턴이 시작됐는지 확인한다.
//
// worker 는 `orca orchestration send` 나 `reply` 로 보낸 메시지를 다음 턴에 `check` 를 부를 때 읽는다.
// 입력 대기로 멈춘 worker 에게는 다음 턴이 오지 않아 메시지가 읽히지 않는다.
// 이 명령은 메시지를 보낸 뒤에 부른다. 화면 마지막 줄들로 입력 대기인지 보고,
// 입력 대기일 때만 「코디네이터 메시지를 check 로 읽어라」 를 넣는다.
// 작업 중이면 그 worker 가 다음 `check` 에서 읽으므로 입력하지 않는다.
//
// `terminal send --wait-submit` 이 턴 시작(`turn_started`)을 보지 못하면 Enter 가 삼켜졌을 수 있다.
// 그 receipt 의 request id 로 `--retry-request` 를 한 번 더 보낸다. 같은 id 는 같은 입력을 두 번 넣지 않고 receipt 를 다시 확인한다.
//
// 사용법:
//     nudge-worker.ts --terminal HANDLE --msg-id MSG_ID [--wait-submit 15]
//     nudge-worker.ts --terminal HANDLE --text TEXT [--wait-submit 15]
//     nudge-worker.ts --terminal HANDLE --state
//     nudge-worker.ts --classify < screen.txt
//
//     --terminal     worker 의 터미널 handle
//     --msg-id       방금 보낸 코디네이터 메시지 id. 입력 문구에 넣는다
//     --text         메시지 대신 이 글을 그대로 넣는다. dispatch 가 닫혀 check 로 읽을 메시지가 없을 때 send-to-worker 가 쓴다.
//                    작업 중이어도 넣는다. 에이전트는 작업 중 입력을 대기열에 두었다가 다음 턴에 읽는다
//     --wait-submit  턴 시작을 기다릴 초. 기본 15
//     --state        그 터미널 화면을 판정만 하고 상태 한 낱말을 낸다
//     --classify     표준 입력의 화면 문자열을 판정만 하고 상태 한 낱말을 낸다
//
// 화면 상태:
//     working     작업 중이다. Claude 의 「✳ Thinking… (」 줄, Codex 의 「• Working (」 줄, 「esc to interrupt」
//     idle        입력란이 비어 있다. Claude 의 「❯」 만 있는 줄, Codex 의 「›」 줄이 비었거나 기본 안내 문구다
//     draft       입력란에 누가 쓰다 만 글이 있다. 덧붙여 보내면 그 글과 섞인다
//     permission  권한 확인 창에서 기다린다. 코디네이터가 대신 고르지 않는다
//     unknown     어느 것도 아니다
//
// ORCA 환경 변수로 orca 실행 파일을 바꾼다.
//
// 종료 코드:
//     0  입력해서 턴이 시작됐거나, 작업 중이라 입력할 필요가 없다. 표준 출력 첫 낱말이 nudged 또는 working 이다.
//        --text 로 작업 중인 터미널에 넣었으면 queued 다
//     1  입력했지만 다시 확인해도 턴 시작을 보지 못했다. 화면을 직접 본다
//     4  입력란에 글이 있거나 권한 확인 창이거나 화면을 판정하지 못해 입력하지 않았다
//     5  orca 가 오류를 냈다. 그 출력을 그대로 낸다
//     2  사용법 오류

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { orca } from './lib/orca.ts'

const USAGE = [
  '사용법: nudge-worker.ts --terminal HANDLE --msg-id MSG_ID [--wait-submit 15]',
  '        nudge-worker.ts --terminal HANDLE --text TEXT [--wait-submit 15]',
  '        nudge-worker.ts --terminal HANDLE --state',
  '        nudge-worker.ts --classify < screen.txt',
].join('\n')
// 상태 줄과 입력란은 화면 아래에 있다. 위쪽 대화 기록의 「›」 와 「❯」 는 보지 않는다
const BOTTOM = 12
// terminal send --wait-submit 은 그 초만큼 기다린 뒤 답한다. 기다리는 시간 위에 orca 자체의 여유를 더한다
const ORCA_SLACK_MS = 60_000

const PERMISSION = /Do you want to (proceed|make this edit|create)|Would you like to (run|make|apply)|Allow command\?/u
const WORKING = /esc to interrupt|^\s*• Working \(|^\S\s+[A-Z][a-z]+…/u
const CLAUDE_INPUT = /^\s*❯(?:\s(.*))?$/u
const CODEX_INPUT = /^\s*›(?:\s(.*))?$/u
// Codex 는 빈 입력란에 안내 문구를 흐리게 보여 준다. 화면 문자열로는 입력한 글과 구분되지 않아 알려진 문구만 빈 것으로 본다
const CODEX_PLACEHOLDERS = new Set([
  'Ask Codex to do anything',
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
])
// Python 의 str.splitlines 와 같은 줄 경계다. 화면 문자열에 \r 이나 \u2028 이 섞여도 같은 줄로 나눈다
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u

type Prompt = { stages?: unknown; observation?: unknown; requestId?: unknown }

function classify(lines: string[]): string {
  const tail = lines.filter((line) => line.trim()).map((line) => line.trimEnd()).slice(-BOTTOM)
  if (tail.some((line) => PERMISSION.test(line))) return 'permission'
  if (tail.some((line) => WORKING.test(line))) return 'working'
  for (const line of [...tail].reverse()) {
    const claude = CLAUDE_INPUT.exec(line)
    if (claude) {
      // 선택 창의 「❯ 1. Yes」 는 위에서 권한 확인으로 판정했다. 남은 「❯ 글」 은 입력란의 글이다
      return (claude[1] ?? '').trim() ? 'draft' : 'idle'
    }
    const codex = CODEX_INPUT.exec(line)
    if (codex) {
      const text = (codex[1] ?? '').trim()
      return !text || CODEX_PLACEHOLDERS.has(text) ? 'idle' : 'draft'
    }
  }
  return 'unknown'
}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

// 실패하면 orca 의 출력을 그대로 내고 null 이다. 종료 코드가 아니라 응답의 ok 로 판정한다
function orcaJson(args: string[], timeoutMs?: number): Record<string, unknown> | null {
  const done = orca([...args, '--json'], { timeoutMs })
  let data: unknown
  try {
    data = JSON.parse(done.stdout)
  } catch {
    data = null
  }
  const body = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { ok?: unknown; result?: unknown }) : null
  if (!body || !body.ok) {
    out((done.stdout + done.stderr).trim() || `nudge-worker: orca ${args[0]} ${args[1]} 출력이 JSON 이 아니다`)
    return null
  }
  return (body.result as Record<string, unknown>) || {}
}

function screenLines(terminal: string): string[] | null {
  const result = orcaJson(['terminal', 'read', '--terminal', terminal, '--screen'])
  if (result === null) return null
  const tail = ((result.terminal as { tail?: unknown }) || {}).tail || []
  return Array.isArray(tail) ? tail.map(String) : String(tail).split(LINE_BREAK)
}

function send(terminal: string, text: string, waitSubmit: number | null, retry?: string): Prompt | null {
  const args = ['terminal', 'send', '--terminal', terminal, '--text', text, '--enter']
  if (waitSubmit) args.push('--wait-submit', String(waitSubmit))
  if (retry) args.push('--retry-request', retry)
  const result = orcaJson(args, (waitSubmit ?? 0) * 1000 + ORCA_SLACK_MS)
  if (result === null) return null
  return (((result.send as { prompt?: unknown }) || {}).prompt as Prompt) || {}
}

function nudge(terminal: string, msgId: string | undefined, waitSubmit: number, text: string | undefined): number {
  const lines = screenLines(terminal)
  if (lines === null) return 5
  const state = classify(lines)
  if (state === 'working' && text !== undefined) {
    // 작업 중에는 턴이 새로 시작하지 않으므로 턴 시작을 기다리지 않는다
    if (send(terminal, text, null) === null) return 5
    out('queued: 작업 중인 터미널에 넣었다. 다음 턴에 읽는다')
    return 0
  }
  if (state === 'working') {
    out('working: 작업 중이라 다음 check 에서 읽는다. 입력하지 않았다')
    return 0
  }
  if (state !== 'idle') {
    out(`${state}: 입력하지 않았다. terminal read --screen 으로 화면을 직접 본다`)
    return 4
  }

  const body = text ?? `코디네이터 메시지 ${msgId} 를 orca orchestration check 로 읽고 수행한다`
  let prompt = send(terminal, body, waitSubmit)
  if (prompt === null) return 5
  for (const attempt of ['first', 'retry']) {
    const stages = Array.isArray(prompt.stages) ? prompt.stages : []
    if (stages.includes('turn_started')) {
      out(`nudged: 턴이 시작됐다 (${prompt.requestId ?? 'None'})`)
      return 0
    }
    if (prompt.observation === 'permission') {
      out(`permission: 권한 확인 창이 떠 입력이 확인되지 않았다 (${prompt.requestId ?? 'None'})`)
      return 4
    }
    const request = typeof prompt.requestId === 'string' ? prompt.requestId : ''
    if (attempt === 'retry' || !request || request === 'unsupported-old-host') break
    prompt = send(terminal, body, waitSubmit, request)
    if (prompt === null) return 5
  }
  out(`unobserved: 입력했지만 턴 시작을 보지 못했다 (${prompt.requestId ?? 'None'}). 화면을 직접 본다`)
  return 1
}

// `--text "-x"` 처럼 값이 - 로 시작해도 값으로 받는다. parseArgs 는 그런 값을 옵션으로 보고 거부한다
function joinValues(argv: string[], names: string[]): string[] {
  const joined: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i]) && i + 1 < argv.length) joined.push(`${argv[i]}=${argv[++i]}`)
    else joined.push(argv[i])
  }
  return joined
}

function main(argv: string[]): number {
  let values
  try {
    values = parseArgs({
      args: joinValues(argv, ['--terminal', '--msg-id', '--text', '--wait-submit']),
      options: {
        terminal: { type: 'string' },
        'msg-id': { type: 'string' },
        text: { type: 'string' },
        'wait-submit': { type: 'string', default: '15' },
        state: { type: 'boolean', default: false },
        classify: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch (e) {
    process.stderr.write(`${USAGE}\nnudge-worker: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    out(USAGE)
    return 0
  }
  const waitText = (values['wait-submit'] as string).trim()
  if (!/^[-+]?\d+$/.test(waitText)) {
    process.stderr.write(`${USAGE}\nnudge-worker: --wait-submit 은 정수다: ${waitText}\n`)
    return 2
  }
  const waitSubmit = Number(waitText)
  if (values.classify) {
    out(classify(readFileSync(0, 'utf8').split(LINE_BREAK)))
    return 0
  }
  if (values.state && values.terminal) {
    const lines = screenLines(values.terminal)
    if (lines === null) return 5
    out(classify(lines))
    return 0
  }
  if (!values.terminal || Boolean(values['msg-id']) === Boolean(values.text) || waitSubmit <= 0) {
    process.stderr.write('nudge-worker: --terminal 과 --msg-id 나 --text 중 하나가 필요하고 --wait-submit 은 0 보다 커야 한다\n')
    return 2
  }
  return nudge(values.terminal, values['msg-id'], waitSubmit, values.text)
}

process.exitCode = main(process.argv.slice(2))
