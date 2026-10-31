// 읽지 않은 메시지를 먼저 확인하고 코디네이터에게 질문한다.
//
// 사용: worker-ask.ts --from HANDLE (--question TEXT | --resume ID)
//                    [--options CSV] [--run ID] [--timeout-ms N] [--force] [--decision]
// --decision: 사용자가 정할 결정 질문이다. 본문이 docs/data-schema.md 「사용자 결정 질문 형식」
// (첫 줄 `결정:` 과 비지 않은 제목, `- ` 선택지 둘 이상, `권장:` 줄 하나)을 따르는지 보고, 어긋나면 묻지 않고 줄마다 stderr 에 낸다.
// `--resume` 으로 재개할 때는 검사하지 않는다.
// 종료: 0 답 수신, 2 사용법·실행 오류(--decision 형식 위반 포함), 3 status 답 또는 Run 메일함으로 대신 보냄,
// 4 시간 초과(출력의 ID로 재개), 5 읽지 않은 코디네이터 메시지가 있어 묻지 않음.
// ORCA로 CLI, ORCH_ASK_SEEN으로 읽은 메시지 기록 경로를 바꾼다.
//
// 출력: 답을 받으면 첫 줄이 `answer: <답 본문>` 이고 그 뒤에 ask 의 출력이 온다.
//
// status 답 기다리기: ask 를 기다리는 동안 ORCH_ASK_POLL_MS(기본 30000)마다 check --peek 을 다시 읽는다. 아래 「status 답」 이 오면
// ask 를 끊고 시간 초과 뒤의 status 답과 같게 3 으로 끝난다(첫 줄 `answer: <본문>`). 코디네이터가 reply 대신 status 로 답해도
// 시간 제한(기본 600초)을 다 기다리지 않게 하려는 것이다. 끊은 ask 의 질문은 Orca 에 답 없이 남는다.
// 기다리는 동안에는 질문 메시지 ID 를 모르므로 스레드가 아니라 받는 곳으로만 판정하고, ask 를 부르기 전에 이미 있던 status 는 뺀다.
//
// 시간 초과: ask 출력의 timedOut 이나 `timed out` 말고도, ask 가 --timeout-ms 에 여유(2분)를 더한 시간 안에 끝나지 않아
// 이 명령이 끊은 경우도 시간 초과(4, status 답이 있으면 3)다. 실패로 보고 Run 메일함으로 대신 보내면 같은 질문이 두 번 간다.
//
// 옵션은 고유 접두로 줄여 쓸 수 있고 `--question "- 선택지"` 처럼 값이 - 로 시작해도 받는다(lib/args.ts).
//
// orca 의 JSON 출력에서 값을 꺼내는 규칙:
//     답 본문       ask 결과의 answer, reply, response 차례. 값이 객체면 그 안의 answer, body, text 차례
//     질문 메시지 ID ask 결과의 messageId, 없으면 id
//     Run           check 결과의 runId
//     읽지 않은 메시지 check --peek 결과에서 heartbeat 와 자기가 보낸 것을 뺀 메시지. ORCH_ASK_SEEN 파일에 든 ID 는 건너뛰고,
//                   보인 ID 를 그 파일에 더한다. worker 가 `check` 로 읽어도 ack 하지 않으면 --peek 에 계속 남아(실측),
//                   한 번 보여 준 메시지로 다시 막지 않으려는 것이다
//     status 답     check --peek 결과에서 스레드가 그 질문이거나 받는 곳이 이 dispatch 인 status 의 본문. 받는 곳으로 찾은 것은
//                   ask 를 부르기 직전의 check --peek 에 이미 있던 ID 를 뺀다. 앞서 받은 다른 지시를 이 질문의 답으로 읽지 않게 한다
//     출력 앞뒤에 다른 줄이 섞여도 마지막 JSON 객체를 읽는다. JSON 이 없으면 값이 없는 것으로 본다

import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { orcaBin } from './lib/orca.ts'
import { run, runAsync } from './lib/proc.ts'
import { pyStr as text } from './lib/py.ts'

const USAGE = [
  '사용: worker-ask.ts --from HANDLE (--question TEXT | --resume ID)',
  '                   [--options CSV] [--run ID] [--timeout-ms N] [--force] [--decision]',
].join('\n')
// ask 는 --timeout-ms 만큼 기다린다. 그 위에 orca 자체의 여유를 더해, orca 가 시간 초과를 알리기 전에 끊지 않게 한다.
// ORCH_ASK_SLACK_MS 는 이 여유를 바꾼다. 테스트만 쓴다
const ASK_SLACK_MS = Number(process.env.ORCH_ASK_SLACK_MS) || 120_000
const DEFAULT_TIMEOUT_MS = '600000'
// ask 를 기다리는 동안 status 답을 찾는 간격. ORCH_ASK_POLL_MS 로 바꾼다(테스트가 줄인다)
const POLL_MS = Number(process.env.ORCH_ASK_POLL_MS) || 30_000
// Python 의 str.splitlines 와 같은 줄 경계다. 결정 질문 형식 판정이 옛 명령과 같게 한다
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u

type Json = Record<string, unknown>

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
}

// 출력 전체, 그다음 마지막 줄부터 차례로 JSON 객체를 찾는다. 그 result 를 낸다(없으면 객체 자체).
function load(text: string): Json {
  const lines = text.split(LINE_BREAK)
  for (const candidate of [text, ...lines.reverse()]) {
    let data: unknown
    try {
      data = JSON.parse(candidate)
    } catch {
      continue
    }
    const found = obj(data)
    if (found) return obj('result' in found ? found.result : found) ?? {}
  }
  return {}
}

function bodyOf(value: unknown): string {
  if (typeof value === 'string') return value
  const found = obj(value)
  if (found) {
    for (const key of ['answer', 'body', 'text']) if (typeof found[key] === 'string') return found[key] as string
  }
  return ''
}

function messages(result: Json): Json[] {
  const list = Array.isArray(result.messages) ? result.messages : []
  return list.map(obj).filter((m): m is Json => m !== null && m.type !== 'heartbeat')
}

function answerOf(output: string): string {
  const result = load(output)
  for (const key of ['answer', 'reply', 'response']) {
    const found = bodyOf(result[key])
    if (found) return found.trim()
  }
  return ''
}

function messageIdOf(output: string): string {
  const result = load(output)
  return String(result.messageId || result.id || '').trim()
}

function runIdOf(output: string): string {
  return String(load(output).runId || '').trim()
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function unreadOf(output: string, sender: string, seenFile: string): string {
  const seen = new Set(isFile(seenFile) ? readFileSync(seenFile, 'utf8').split(/\s+/).filter(Boolean) : [])
  const lines: string[] = []
  const shown: string[] = []
  for (const m of messages(load(output))) {
    if (m.from_handle === sender || seen.has(String(m.id))) continue
    lines.push(`[${text(m.type)}] ${m.subject || ''} (${text(m.id)}, ${m.created_at || ''})`)
    lines.push(String(m.body || ''))
    shown.push(text(m.id))
  }
  if (shown.length) {
    try {
      appendFileSync(seenFile, shown.map((id) => `${id}\n`).join(''))
    } catch {
      // 기록하지 못해도 메시지는 보였다. 다음 호출이 같은 메시지로 한 번 더 멈출 뿐이다
    }
  }
  return lines.join('\n').trim()
}

// before 는 ask 를 부르기 전에 있던 메시지 ID 다. 받는 곳으로만 맞은 status 가운데 여기 든 것은 답으로 보지 않는다
function replyOf(output: string, sender: string, question: string, before: ReadonlySet<string>): string {
  const result = load(output)
  const dispatch = result.dispatchId
  for (const m of messages(result)) {
    if (m.from_handle === sender || m.type !== 'status') continue
    const toMe = Boolean(dispatch) && m.to_handle === `dispatch:${dispatch}` && !before.has(String(m.id))
    if ((question && m.thread_id === question) || toMe) return String(m.body || '').trim()
  }
  return ''
}

function idsOf(output: string): Set<string> {
  return new Set(messages(load(output)).map((m) => String(m.id)))
}

function decisionProblems(question: string): string[] {
  const lines = question === '' ? [] : question.replace(new RegExp(`(?:${LINE_BREAK.source})$`, 'u'), '').split(LINE_BREAK).map((line) => line.trim())
  const problems: string[] = []
  if (lines.length === 0 || !lines[0].startsWith('결정:')) problems.push('첫 줄이 `결정:` 으로 시작해야 한다')
  else if (!lines[0].slice('결정:'.length).trim()) problems.push('`결정:` 뒤에 무엇을 정하는지 제목이 있어야 한다')
  const choices = lines.filter((line) => line.startsWith('- ')).length
  if (choices < 2) problems.push(`\`- \` 로 시작하는 선택지 줄이 둘 이상이어야 한다(지금 ${choices}개)`)
  const advice = lines.filter((line) => line.startsWith('권장:')).length
  if (advice !== 1) problems.push(`\`권장:\` 줄이 정확히 하나여야 한다(지금 ${advice}개)`)
  return problems
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

async function main(argv: string[]): Promise<number> {
  let values
  try {
    const optionSpec = {
      from: { type: 'string' },
      question: { type: 'string', default: '' },
      resume: { type: 'string', default: '' },
      options: { type: 'string', default: '' },
      run: { type: 'string', default: '' },
      'timeout-ms': { type: 'string', default: DEFAULT_TIMEOUT_MS },
      force: { type: 'boolean', default: false },
      decision: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    } as const
    // `--question "- 선택지"` 처럼 값이 - 로 시작해도 값으로 받는다
    const joined = ['from', 'question', 'resume', 'options', 'run', 'timeout-ms']
    values = parseArgs({ args: expandArgs(argv, optionSpec, joined), options: optionSpec }).values
  } catch (e) {
    err(`${USAGE}\nworker-ask: ${(e as Error).message}`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const sender = values.from
  if (sender === undefined) {
    err(`${USAGE}\nworker-ask: --from 이 필요하다`)
    return 2
  }
  const question = values.question as string
  const resume = values.resume as string
  const options = values.options as string
  const timeoutMs = values['timeout-ms'] as string
  if (!question && !resume) {
    err(`${USAGE}\nworker-ask: --question 이나 --resume 중 하나가 필요하다`)
    return 2
  }
  if (values.decision && !resume) {
    const problems = decisionProblems(question)
    if (problems.length) {
      for (const problem of problems) err(`worker-ask: --decision 형식 위반: ${problem}`)
      return 2
    }
  }
  const orca = orcaBin()
  const peekArgs = [orca, 'orchestration', 'check', '--terminal', sender, '--peek', '--json']
  const peek = () => run(peekArgs).stdout
  const first = peek()
  if (!resume && !values.force) {
    const seen = process.env.ORCH_ASK_SEEN || join(process.env.TMPDIR || '/tmp', `orch-worker-ask-${sender}.seen`)
    const unread = unreadOf(first, sender, seen)
    if (unread) {
      process.stdout.write(`${unread}\n`)
      err('worker-ask: 읽지 않은 코디네이터 메시지가 있어 묻지 않았다. 위 메시지를 읽고도 물어야 하면 같은 명령을 다시 부른다')
      return 5
    }
  }
  const before = idsOf(first)
  const args = [orca, 'orchestration', 'ask', '--from', sender, '--timeout-ms', timeoutMs, '--json']
  args.push(...(resume ? ['--resume', resume] : ['--question', question]))
  if (options && !resume) args.push('--options', options)
  const limitMs = (Number(timeoutMs) || Number(DEFAULT_TIMEOUT_MS)) + ASK_SLACK_MS
  // ask 를 기다리는 동안 status 답을 찾는다(머리 주석의 「status 답 기다리기」). 찾으면 ask 를 끊는다
  const stop = new AbortController()
  let early = ''
  const watching = (async () => {
    while (!stop.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS)
        stop.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      if (stop.signal.aborted) return
      const polled = await runAsync(peekArgs)
      if (stop.signal.aborted) return
      const reply = replyOf(polled.stdout, sender, resume, before)
      if (reply) {
        early = reply
        stop.abort()
      }
    }
  })()
  const asked = await runAsync(args, { timeoutMs: limitMs, signal: stop.signal })
  stop.abort()
  await watching
  const output = asked.stdout + asked.stderr
  if (early) {
    process.stdout.write(`answer: ${early}\n${output}\n`)
    err('worker-ask: ask 를 기다리는 동안 코디네이터가 status 로 답해 ask 를 끊었다. 첫 줄이 그 본문이다')
    return 3
  }
  // 끊은 ask 는 질문을 이미 보냈을 수 있다. 아래 실패 경로(Run 메일함으로 대신 보내기)로 가지 않게 시간 초과를 먼저 본다
  if (asked.timedOut) err(`worker-ask: ask 가 ${limitMs}ms 안에 끝나지 않아 끊었다`)
  if (asked.timedOut || /"timedOut"\s*:\s*true|timed out/.test(output)) {
    const reply = replyOf(peek(), sender, messageIdOf(output) || resume, before)
    if (reply) {
      process.stdout.write(`answer: ${reply}\n${output}\n`)
      err('worker-ask: ask 에는 답이 없지만 코디네이터가 status 로 답했다. 첫 줄이 그 본문이다')
      return 3
    }
    process.stdout.write(`${output}\n`)
    err('worker-ask: 시간 제한으로 답을 받지 못했다. 위 출력의 메시지 ID 로 --resume 한다')
    return 4
  }
  if (asked.code === 0) {
    process.stdout.write(`answer: ${answerOf(output)}\n${output}\n`)
    return 0
  }
  err(output)
  if (resume) {
    err('worker-ask: --resume 이 실패했다. 대신 보낼 질문 본문이 없어 멈춘다')
    return 2
  }
  err('worker-ask: ask 가 실패했다. Dispatch 가 끝났을 수 있어 Run 메일함으로 대신 보낸다')
  const runId = (values.run as string) || runIdOf(peek())
  if (!runId) {
    err('worker-ask: Run 을 찾지 못했다. --run 으로 준다')
    return 2
  }
  const body = question + (options ? `\n선택지: ${options}` : '')
  const sent = run([orca, 'orchestration', 'send', '--from', sender, '--to', `run:${runId}`, '--type', 'question', '--subject', '질문 (ask 대신 보냄)', '--body', body, '--json'])
  process.stdout.write(sent.stdout)
  process.stderr.write(sent.stderr)
  if (sent.code !== 0) {
    err('worker-ask: 대신 보내기도 실패했다')
    return 2
  }
  err(`worker-ask: run:${runId} 으로 보냈다. 답은 orca orchestration check --terminal ${sender} 로 읽는다`)
  return 3
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    err(`worker-ask: ${(e as Error)?.stack ?? String(e)}`)
    process.exitCode = 2
  },
)
