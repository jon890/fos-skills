// 읽지 않은 메시지를 먼저 확인하고 코디네이터에게 질문을 보낸 뒤, 답을 기다리지 않고 끝난다.
//
// 사용: worker-ask.ts --from HANDLE --question TEXT
//                    [--options CSV] [--run ID] [--force] [--decision]
// 질문을 보내면 worker 는 턴을 끝낸다. 답이 오면 Orca 가 worker 를 깨우고, 깬 뒤 orca orchestration check 로 읽는다.
// --decision: 사용자가 정할 결정 질문이다. 본문이 docs/data-schema.md 「사용자 결정 질문 형식」
// (첫 줄 `결정:` 과 비지 않은 제목, `- ` 선택지 둘 이상, `권장:` 줄 하나)을 따르는지 보고, 어긋나면 묻지 않고 줄마다 stderr 에 낸다.
// `결정:` 줄이 여럿이면 그 줄마다 블록을 나눠 블록마다 같은 규칙을 보고, 위반 줄 앞에 `결정 블록 N:` 을 붙인다.
// 없어진 옵션: `--resume` 은 orca 를 부르지 않고 안내 한 줄과 2 로 끝난다. `--timeout-ms`, `--max-wait` 는 값을 보지 않고
// 안내 한 줄만 내고 무시한다. 옛 규칙대로 도는 worker 가 어떤 값을 넘겨도 멈추지 않게 하려는 것이다.
// 종료: 0 보냈다(`ASKED <질문 id>`) 또는 바로 답을 받았다(`answer: `), 2 사용법·실행 오류(--decision 형식 위반, --resume, 다시 불러도 바쁜 Orca,
// 끝난 dispatch 가 아닌 ask 실패 포함), 3 Run 메일함으로 대신 보냄, 5 읽지 않은 코디네이터 메시지가 있어 묻지 않음.
// 2 에는 질문이 닿았는지 확인하지 못한 경우도 든다. ask 가 0 으로 끝났는데 답도 질문 ID 도 없거나, 시간 초과인데 질문 ID 가 없거나,
// Run 메일함으로 대신 보낸 send 가 메시지 ID 를 내지 않은 경우다. 답 없이 0 을 내면 worker 가 물었다고 믿고 넘어간다.
// ORCA로 CLI, ORCH_ASK_SEEN으로 읽은 메시지 기록 경로를 바꾼다.
// orca orchestration 명령에는 --full 을 붙인다(lib/orca.ts 의 withFull). 줄인 보기는 from_handle, thread_id 를 빼 답을 찾지 못한다.
//
// ask 호출: `--timeout-ms ASK_RETURN_MS`(기본 5000, ORCH_ASK_RETURN_MS 로 바꾼다. 테스트용)로 한 번 부른다. `--wait` 는 주지 않는다.
// Orca 는 살아 있는 worker 의 새 질문은 바로 돌려주고 끝난 worker 의 ask 는 답이 올 때까지 막아 두므로, 짧게 끊고 질문은 남긴다.
//
// 출력: 답이 바로 오면 첫 줄이 `answer: <답 본문>` 이고 그 뒤에 ask 의 출력이 온다.
// 질문만 보냈으면 첫 줄이 `ASKED <질문 id>` 이고 그 뒤에 ask 의 출력이 온다. 짧은 출력(진입점의 orch worker ask, lib/output.ts)은 첫 줄만 낸다.
// 질문이 닿았는지 모르면 `NO-ANSWER -`, Run 메일함으로 대신 보내면 `SENT-RUN <보낸 id>` 다. 종료 코드 5 의 읽지 않은 메시지는 그대로다.
//
// ask 실패의 종류: 실패한 ask 출력의 `error.code`(JSON 이 없으면 글 속의 코드 낱말)로 구분한다.
//     바쁨(BUSY_CODES, 글에 `retry with backoff` 가 든 것)  Orca 가 요청을 받지 않았다. dispatch 는 살아 있다.
//                 ORCH_ASK_BUSY_MS(기본 5000)부터 두 배씩 늘려 BUSY_TRIES 번까지 같은 ask 를 다시 부른다. 그래도 바쁘면 2 다
//     끝난 dispatch(DISPATCH_GONE)이거나 코드를 읽지 못함  Run 메일함으로 대신 보낸다(아래 「대신 보내기」). 코드 없는 옛 출력도 여기다
//     그 밖의 코드  대신 보내지 않고 2 다. 살아 있는 dispatch 의 질문을 메일함으로 보내면 답이 ask 스레드에 오지 않는다(2026-11-02)
//
// 시간 초과: ask 출력의 timedOut 이나 `timed out`, 또는 이 명령이 ask 를 끊은 경우다. 질문 ID 가 있으면 질문이 남은 것이라 `ASKED` 로 끝난다.
// 없으면 닿았는지 몰라 `NO-ANSWER -` 와 2 이고, 실패로 보고 Run 메일함으로 대신 보내지 않는다. 질문이 이미 저장됐으면 같은 질문이 두 번 간다.
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
//     출력 앞뒤에 다른 줄이 섞여도 마지막 JSON 객체를 읽는다. JSON 이 없으면 값이 없는 것으로 본다

import { objectOr } from '../core/json.ts'
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { orcaBin, withFull } from '../lib/orca.ts'
import { run, runAsync } from '../lib/proc.ts'
import { short } from '../lib/output.ts'
import { pyStr as text } from '../lib/py.ts'
import { senderOf } from '../core/message-fields.ts'

// 답을 받은 출력. 첫 줄이 `answer: <답>` 이고, 지금 출력은 그 뒤에 ask 의 출력을 잇는다. 짧은 출력은 첫 줄만이다

function answered(answer: string, output: string): void {
  process.stdout.write(short() ? `answer: ${answer}\n` : `answer: ${answer}\n${output}\n`)
}

// 질문만 보낸 출력. 첫 줄이 `ASKED <질문 id>` 이고, 지금 출력은 그 뒤에 ask 의 출력을 잇는다. 짧은 출력은 첫 줄만이다
function asked(id: string, output: string): void {
  process.stdout.write(short() ? `ASKED ${id}\n` : `ASKED ${id}\n${output}\n`)
}

const USAGE = [
  '사용: worker-ask.ts --from HANDLE --question TEXT',
  '                   [--options CSV] [--run ID] [--force] [--decision]',
].join('\n')
// ask 가 바로 돌아오게 주는 --timeout-ms. 끝난 worker 의 ask 는 Orca 가 답이 올 때까지 막아 두므로 짧게 끊는다(머리 주석).
// ORCH_ASK_RETURN_MS 는 이 값을 바꾼다. 테스트만 쓴다
const ASK_RETURN_MS = Number(process.env.ORCH_ASK_RETURN_MS) || 5_000
// ask 호출 제한은 ASK_RETURN_MS 에 orca 자체의 여유를 더한 시간이다. ORCH_ASK_SLACK_MS 는 이 여유를 바꾼다. 테스트만 쓴다
const ASK_SLACK_MS = Number(process.env.ORCH_ASK_SLACK_MS) || 120_000
// Python 의 str.splitlines 와 같은 줄 경계다. 결정 질문 형식 판정이 옛 명령과 같게 한다
// Orca 가 요청을 받지 않고 돌려보낸 바쁨 코드. 받지 않았으니 같은 질문을 다시 보내도 두 번 가지 않는다
const BUSY_CODES = new Set(['runtime_busy', 'remote_runtime_busy', 'runtime_rpc_queue_overloaded'])
// 이 코드로 실패한 ask 만 끝난 dispatch 로 보고 Run 메일함으로 대신 보낸다
const DISPATCH_GONE = new Set(['dispatch_inactive', 'dispatch_not_found'])
const BUSY_TRIES = 5
// 바쁨 재시도의 첫 대기. ORCH_ASK_BUSY_MS 로 바꾼다(테스트가 줄인다)
const BUSY_MS = Number(process.env.ORCH_ASK_BUSY_MS) || 5_000
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u

type Json = Record<string, unknown>

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
    const found = objectOr(data, null)
    if (found) return objectOr('result' in found ? found.result : found, null) ?? {}
  }
  return {}
}

function bodyOf(value: unknown): string {
  if (typeof value === 'string') return value
  const found = objectOr(value, null)
  if (found) {
    for (const key of ['answer', 'body', 'text']) if (typeof found[key] === 'string') return found[key] as string
  }
  return ''
}

function messages(result: Json): Json[] {
  const list = Array.isArray(result.messages) ? result.messages : []
  return list.map(value => objectOr(value, null)).filter((m): m is Json => m !== null && m.type !== 'heartbeat')
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

// send 결과의 메시지 ID. 전체 기록은 message.id, 줄인 보기는 messageId 다
function sentIdOf(output: string): string {
  const result = load(output)
  return String(objectOr(result.message, null)?.id || result.messageId || result.id || '').trim()
}

// 실패한 ask 의 오류 코드. JSON 의 error.code, 없으면 글 속의 알려진 코드 낱말이다. 못 읽으면 빈 문자열이다
function errorCodeOf(output: string): string {
  const code = objectOr(load(output).error, null)?.code
  if (typeof code === 'string' && code) return code
  const word = /\b(?:remote_)?runtime_busy\b|\bruntime_rpc_queue_overloaded\b|\bdispatch_(?:inactive|not_found)\b/.exec(output)
  if (word) return word[0]
  return /retry with backoff/i.test(output) ? 'runtime_busy' : ''
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
    if (senderOf(m) === sender || seen.has(String(m.id))) continue
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

function decisionProblems(question: string): string[] {
  const lines = question === '' ? [] : question.replace(new RegExp(`(?:${LINE_BREAK.source})$`, 'u'), '').split(LINE_BREAK).map((line) => line.trim())
  const problems: string[] = []
  if (lines.length === 0 || !lines[0].startsWith('결정:')) {
    problems.push('첫 줄이 `결정:` 으로 시작해야 한다')
    return problems.concat(blockProblems(lines))
  }
  // 결정 블록 여러 개를 한 질문으로 보낼 수 있다(spec 인터뷰). `결정:` 줄마다 블록을 나눠 각각 검사한다
  const blocks: string[][] = []
  for (const line of lines) {
    if (line.startsWith('결정:')) blocks.push([line])
    else blocks[blocks.length - 1].push(line)
  }
  if (blocks.length === 1) return blockProblems(blocks[0])
  blocks.forEach((block, i) => {
    for (const problem of blockProblems(block)) problems.push(`결정 블록 ${i + 1}: ${problem}`)
  })
  return problems
}

function blockProblems(lines: string[]): string[] {
  const problems: string[] = []
  if (lines[0]?.startsWith('결정:') && !lines[0].slice('결정:'.length).trim()) problems.push('`결정:` 뒤에 무엇을 정하는지 제목이 있어야 한다')
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
      // 없어진 옵션. 모르는 옵션 오류가 나지 않게 받기만 한다
      resume: { type: 'string', default: '' },
      options: { type: 'string', default: '' },
      run: { type: 'string', default: '' },
      'timeout-ms': { type: 'string' },
      'max-wait': { type: 'string' },
      force: { type: 'boolean', default: false },
      decision: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    } as const
    // `--question "- 선택지"` 처럼 값이 - 로 시작해도 값으로 받는다
    const joined = ['from', 'question', 'resume', 'options', 'run', 'timeout-ms', 'max-wait']
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
  if (values.resume) {
    err('worker-ask: --resume 은 없어졌다. 질문을 보낸 뒤 턴을 끝내면 Orca 가 답과 함께 깨운다. 읽을 문서: 공통 지시서의 worker-ask 규칙')
    return 2
  }
  if (values['timeout-ms'] !== undefined || values['max-wait'] !== undefined) {
    err('worker-ask: --timeout-ms, --max-wait 는 없어진 옵션이라 무시했다')
  }
  const question = values.question as string
  const options = values.options as string
  if (!question) {
    err(`${USAGE}\nworker-ask: --question 이 필요하다`)
    return 2
  }
  if (values.decision) {
    const problems = decisionProblems(question)
    if (problems.length) {
      for (const problem of problems) err(`worker-ask: --decision 형식 위반: ${problem}`)
      return 2
    }
  }
  const orca = orcaBin()
  const peek = () => run([orca, ...withFull(['orchestration', 'check', '--terminal', sender, '--peek', '--json'])]).stdout
  const first = peek()
  if (!values.force) {
    const seen = process.env.ORCH_ASK_SEEN || join(process.env.TMPDIR || '/tmp', `orch-worker-ask-${sender}.seen`)
    const unread = unreadOf(first, sender, seen)
    if (unread) {
      process.stdout.write(`${unread}\n`)
      err('worker-ask: 읽지 않은 코디네이터 메시지가 있어 묻지 않았다. 위 메시지를 읽고도 물어야 하면 같은 명령을 다시 부른다')
      return 5
    }
  }
  let busy = 0
  while (true) {
    const askArgs = ['orchestration', 'ask', '--from', sender, '--question', question, '--timeout-ms', String(ASK_RETURN_MS), '--json']
    if (options) askArgs.push('--options', options)
    const limitMs = ASK_RETURN_MS + ASK_SLACK_MS
    // 동기 run 은 TERM 을 무시하는 자식을 끝까지 기다린다(lib/proc.ts). runAsync 는 유예 뒤 KILL 을 보내 시간 초과로 돌아온다
    const done = await runAsync([orca, ...withFull(askArgs)], { timeoutMs: limitMs })
    const output = done.stdout + done.stderr
    const messageId = messageIdOf(output)
    // 끊은 ask 는 질문을 이미 보냈을 수 있다. 아래 실패 경로(Run 메일함으로 대신 보내기)로 가지 않게 시간 초과를 먼저 본다.
    // run 이 끊으면 출력이 비어 코드 없는 실패로 보이기 때문이다
    if (done.timedOut) err(`worker-ask: ask 가 ${limitMs}ms 안에 끝나지 않아 끊었다`)
    if (done.timedOut || /"timedOut"\s*:\s*true|timed out/.test(output)) {
      if (messageId) {
        asked(messageId, output)
        err(`worker-ask: 질문 ${messageId} 를 보냈다. 턴을 끝낸다. 답이 오면 Orca 가 깨우고, 깬 뒤 orca orchestration check 로 읽는다`)
        return 0
      }
      process.stdout.write(short() ? 'NO-ANSWER -\n' : `${output}\n`)
      err('worker-ask: 질문이 닿았는지 알 수 없다. 코디네이터 답을 기다리지 말고 같은 명령을 다시 부르기 전에 orca orchestration check 로 확인한다')
      return 2
    }
    if (done.code === 0) {
      const answer = answerOf(output)
      if (answer) {
        answered(answer, output)
        return 0
      }
      if (messageId) {
        asked(messageId, output)
        err(`worker-ask: 질문 ${messageId} 를 보냈다. 턴을 끝낸다. 답이 오면 Orca 가 깨우고, 깬 뒤 orca orchestration check 로 읽는다`)
        return 0
      }
      process.stdout.write(short() ? 'NO-ANSWER -\n' : `${output}\n`)
      err('worker-ask: ask 가 답도 질문 ID 도 내지 않았다. 질문이 코디네이터에 닿았는지 알 수 없어 실패로 끝낸다')
      return 2
    }
    const code = errorCodeOf(output)
    if (BUSY_CODES.has(code)) {
      if (busy < BUSY_TRIES) {
        const delay = BUSY_MS * 2 ** busy
        busy++
        err(`worker-ask: Orca 가 바빠(${code}) ask 를 받지 않았다. ${delay}ms 뒤 같은 ask 를 다시 부른다(${busy}/${BUSY_TRIES})`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      err(output)
      err(`worker-ask: Orca 가 ${BUSY_TRIES} 번 다시 불러도 바빠(${code}) 묻지 못했다. dispatch 는 살아 있어 메일함으로 보내지 않는다. 잠시 뒤 같은 명령을 다시 부른다`)
      return 2
    }
    err(output)
    if (code && !DISPATCH_GONE.has(code)) {
      err(`worker-ask: ask 가 ${code} 로 실패했다. 끝난 dispatch 의 오류가 아니라 Run 메일함으로 대신 보내지 않는다`)
      return 2
    }
    err(`worker-ask: ask 가 실패했다(${code || '코드 없음'}). Dispatch 가 끝났을 수 있어 Run 메일함으로 대신 보낸다`)
    const runId = (values.run as string) || runIdOf(peek())
    if (!runId) {
      err('worker-ask: Run 을 찾지 못했다. --run 으로 준다')
      return 2
    }
    const body = question + (options ? `\n선택지: ${options}` : '')
    const sent = run([orca, ...withFull(['orchestration', 'send', '--from', sender, '--to', `run:${runId}`, '--type', 'question', '--subject', '질문 (ask 대신 보냄)', '--body', body, '--json'])])
    if (!short()) process.stdout.write(sent.stdout)
    process.stderr.write(sent.stderr)
    if (sent.code !== 0) {
      err('worker-ask: 대신 보내기도 실패했다')
      return 2
    }
    const sentId = sentIdOf(sent.stdout)
    if (!sentId) {
      err('worker-ask: 대신 보낸 send 가 메시지 ID 를 내지 않았다. 질문이 코디네이터에 닿았는지 알 수 없어 실패로 끝낸다')
      return 2
    }
    if (short()) process.stdout.write(`SENT-RUN ${sentId}\n`)
    err(`worker-ask: run:${runId} 으로 보냈다(${sentId}). 답은 orca orchestration check --terminal ${sender} 로 읽는다`)
    return 3
  }
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
