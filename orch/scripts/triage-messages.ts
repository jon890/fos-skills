// orca orchestration 메시지를 종류별로 모아 보여 준다. heartbeat 는 보낸 쪽마다 개수만 낸다.
//
// 완료 보고(worker_done)가 heartbeat 사이에 묻혀 놓치지 않게 하는 것이 목적이다.
//
// 사용법:
//     triage-messages.ts FILE [FILE ...]          # 백그라운드 `check --wait --json` 출력 파일을 읽는다
//     triage-messages.ts --live [--run RUN_ID] [--terminal HANDLE]
//                                                 # `orca orchestration check --all --json` 을 직접 부른다
//     공통 옵션:
//       --since WHEN     이 시각 이후 메시지만. ISO 시각(2026-10-12T15:00:00Z) 또는 지금부터 거슬러 30m, 2h, 1d
//       --width N        본문을 N 자에서 자른다. 기본 3000, 0 이면 자르지 않는다
//       --json           사람이 읽는 글 대신 분류 결과를 JSON 으로 낸다
//       --completion-contract ready|none
//                        기본 ready: 앞선 PR 준비 상태 검사(lib/completion.ts). PR 없는 작업만 none 사용
//
// FILE 에는 JSON 객체가 여럿 이어져 있어도 되고, keepalive 줄과 하네스가 붙인 종료 코드 줄이 섞여 있어도 된다.
// `-` 를 주면 표준 입력에서 읽는다.
// `--live` 의 `--all` 은 읽음 표시를 하지 않는다. 대기 중인 `check --wait` 의 delivery 를 건드리지 않는다.
// ORCA 환경 변수로 orca 실행 파일을 바꾼다.
//
// 출력 순서는 완료 근거가 없는 의심스러운 worker_done, worker_done, escalation, question, 그 밖의 종류(status 등), heartbeat 개수다.
// 같은 메시지 id 는 한 번만 센다. 사람이 읽는 출력의 payload 줄은 옛 명령의 json.dumps 꼴(lib/py.ts 의 pyJson)로 앞 200자를 낸다.
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).
// 테스트가 parseObjects 를 import 한다. 명령으로 실행했을 때만 main 을 부른다.
//
// 종료 코드:
//     0  읽었다. 메시지가 없어도 0 이다
//     1  orca 호출이 실패했거나 읽을 JSON 이 하나도 없다
//     2  사용법 오류

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { classify, isoTime } from './lib/completion.ts'
import { orca } from './lib/orca.ts'
import { pyJson, pyStr as text } from './lib/py.ts'

type Json = Record<string, unknown>
type Triage = { groups: Record<string, Json[]>; heartbeats: Record<string, number> }

const USAGE = [
  '사용법: triage-messages.ts FILE [FILE ...] [--since WHEN] [--width N] [--json] [--completion-contract ready|none]',
  '       triage-messages.ts --live [--run RUN_ID] [--terminal HANDLE] [--since WHEN] [--width N] [--json]',
].join('\n')
const PRIORITY = ['suspicious_worker_done', 'worker_done', 'escalation', 'question']
const RELATIVE = /^(\d+)([mhd])$/
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
// 옛 명령은 시간 제한 없이 불렀다. 기록이 큰 Run 의 check --all 은 오래 걸려 넉넉히 준다
const LIVE_TIMEOUT_MS = 600_000
// Python 의 str.splitlines 와 같은 줄 경계다
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u

class Usage extends Error {}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 여는 중괄호에서 시작한 JSON 객체가 끝나는 자리(끝 다음 위치). 문자열 안의 중괄호는 세지 않는다. 닫히지 않으면 -1.
function objectEnd(text: string, start: number): number {
  let depth = 0
  let quoted = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') {
      quoted = true
    } else if (c === '{') {
      depth++
    } else if (c === '}' && --depth === 0) {
      return i + 1
    }
  }
  return -1
}

// 문자열에 이어 붙은 JSON 객체를 모두 꺼낸다. 객체가 아닌 줄은 건너뛴다.
export function parseObjects(text: string): Json[] {
  const found: Json[] = []
  let i = 0
  for (;;) {
    i = text.indexOf('{', i)
    if (i < 0) return found
    const end = objectEnd(text, i)
    let value: unknown
    try {
      if (end < 0) throw new Error('닫히지 않았다')
      value = JSON.parse(text.slice(i, end))
    } catch {
      i += 1
      continue
    }
    if (isObject(value)) found.push(value)
    i = end
  }
}

// epoch ms. 30m, 2h, 1d 는 지금부터 거슬러 센다. 읽지 못하면 Usage.
function parseSince(value: string): number {
  const m = RELATIVE.exec(value)
  if (m) return Date.now() - Number(m[1]) * UNIT_MS[m[2]]
  const time = isoTime(value)
  if (time === null) throw new Usage(`--since 를 읽지 못했다: ${value}`)
  return time
}

// delivery id 목록과, id 로 겹친 것을 뺀 메시지 목록
export function collect(objects: Json[]): { deliveries: string[]; messages: Json[] } {
  const deliveries: string[] = []
  const messages: Json[] = []
  const seen = new Set<unknown>()
  for (const o of objects) {
    const result = o.result
    if (!isObject(result)) continue
    if (result.deliveryId) deliveries.push(String(result.deliveryId))
    for (const m of Array.isArray(result.messages) ? result.messages : []) {
      if (!isObject(m)) continue
      const key = m.id
      if (key !== undefined && key !== null) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      messages.push(m)
    }
  }
  return { deliveries, messages }
}

function triage(messages: Json[], since: number | null, contract: string): Triage {
  const groups: Record<string, Json[]> = {}
  const heartbeats: Record<string, number> = {}
  const checked = contract === 'ready' ? classify(messages) : messages
  for (const m of checked) {
    // 시각을 읽지 못한 메시지는 뺄지 정할 수 없어 남긴다
    const created = m.created_at ? isoTime(m.created_at) : null
    if (since !== null && created !== null && created < since) continue
    const kind = m.type === undefined ? '?' : text(m.type)
    if (kind === 'heartbeat') {
      const who = String(m.from_handle || '?')
      heartbeats[who] = (heartbeats[who] ?? 0) + 1
      continue
    }
    ;(groups[kind] ??= []).push(m)
  }
  const order = [...PRIORITY.filter((k) => k in groups), ...Object.keys(groups).filter((k) => !PRIORITY.includes(k)).sort()]
  return { groups: Object.fromEntries(order.map((k) => [k, groups[k]])), heartbeats }
}

function field(m: Json, key: string, fallback = ''): string {
  return m[key] === undefined ? fallback : text(m[key])
}

function payloadText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : pyJson(value)
}

function splitLines(body: string): string[] {
  if (body === '') return ['']
  const parts = body.split(LINE_BREAK)
  // Python 의 splitlines 는 끝 줄바꿈 뒤의 빈 줄을 내지 않는다
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

function render(deliveries: string[], result: Triage, width: number): string {
  const lines: string[] = []
  if (deliveries.length) lines.push(`delivery ${deliveries.join(' ')}`)
  for (const [kind, items] of Object.entries(result.groups)) {
    const label = kind === 'suspicious_worker_done' ? '의심스러운 worker_done' : kind
    lines.push(`\n== ${label} ${items.length}건`)
    for (const m of items) {
      let body = payloadText(m.body)
      const chars = Array.from(body)
      if (width && chars.length > width) body = `${chars.slice(0, width).join('')} …(잘림)`
      lines.push(`- ${field(m, 'id', 'None')} ${field(m, 'created_at')} from=${field(m, 'from_handle')}`)
      lines.push(`  제목: ${field(m, 'subject')}`)
      const extra = payloadText(m.payload)
      if (extra) lines.push(`  payload: ${Array.from(extra).slice(0, 200).join('')}`)
      lines.push(...splitLines(body).map((b) => `  ${b}`))
    }
  }
  const hb = result.heartbeats
  const names = Object.keys(hb).sort()
  if (names.length) {
    const total = names.reduce((sum, k) => sum + hb[k], 0)
    lines.push(`\n== heartbeat ${total}건 ${names.map((k) => `${k}=${hb[k]}`).join(', ')}`)
  }
  if (Object.keys(result.groups).length === 0 && names.length === 0) lines.push('메시지 없음')
  return lines.join('\n')
}

function readLive(runId: string | undefined, terminal: string | undefined): string | null {
  const args = ['orchestration', 'check', '--all', '--json']
  if (runId) args.push('--run', runId)
  if (terminal) args.push('--terminal', terminal)
  const done = orca(args, { timeoutMs: LIVE_TIMEOUT_MS })
  if (done.code !== 0) {
    process.stderr.write(done.stderr || done.stdout)
    return null
  }
  return done.stdout
}

function main(argv: string[]): number {
  let values
  let files: string[]
  let since: number | null = null
  let width: number
  try {
    const options = {
      live: { type: 'boolean', default: false },
      run: { type: 'string' },
      terminal: { type: 'string' },
      since: { type: 'string' },
      width: { type: 'string', default: '3000' },
      json: { type: 'boolean', default: false },
      'completion-contract': { type: 'string', default: 'ready' },
      help: { type: 'boolean', short: 'h' },
    } as const
    const parsed = parseArgs({ args: expandArgs(argv, options), allowPositionals: true, options })
    values = parsed.values
    files = parsed.positionals
    if (values.help) {
      process.stdout.write(`${USAGE}\n`)
      return 0
    }
    const contract = values['completion-contract']
    if (contract !== 'ready' && contract !== 'none') throw new Usage(`--completion-contract 는 ready 나 none 이다: ${contract}`)
    if (!/^\s*[+-]?\d+\s*$/.test(values.width as string)) throw new Usage(`--width 는 정수여야 한다: ${values.width}`)
    width = Number(values.width)
    if ((files.length > 0) === values.live) throw new Usage('FILE 과 --live 중 하나만 준다')
    if (values.since) since = parseSince(values.since)
  } catch (e) {
    process.stderr.write(`${USAGE}\ntriage-messages: ${(e as Error).message}\n`)
    return 2
  }

  let input: string
  if (values.live) {
    const live = readLive(values.run, values.terminal)
    if (live === null) return 1
    input = live
  } else {
    try {
      input = files.map((f) => readFileSync(f === '-' ? 0 : f, 'utf8')).join('')
    } catch (e) {
      process.stderr.write(`triage-messages: 파일을 읽지 못했다: ${(e as Error).message}\n`)
      return 1
    }
  }
  const objects = parseObjects(input)
  const { deliveries, messages } = collect(objects)
  if (!deliveries.length && !messages.length && !objects.some((o) => 'result' in o)) {
    process.stderr.write('읽을 orca 결과 JSON 이 없다\n')
    return 1
  }
  const result = triage(messages, since, values['completion-contract'] as string)
  if (values.json) process.stdout.write(`${JSON.stringify({ deliveries, ...result }, null, 1)}\n`)
  else process.stdout.write(`${render(deliveries, result, width)}\n`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`triage-messages: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  }
}
