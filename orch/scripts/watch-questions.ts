// Monitor 의 이벤트 소스다. 새 미답변 질문과 재알림을 한 줄씩 낸다. 메시지를 ack 하지 않는다.
//
// 사용법: watch-questions.ts [--run ID] [--repo DIR] [--interval 60] [--remind-after 600] [--once]
//     --run           볼 Run. 없으면 run-current 의 Run 이다
//     --repo          orch 작업 폴더와 이벤트 핸들러를 찾을 저장소. 없으면 작업 디렉터리다
//     --interval      조회 간격(초). 기본 60
//     --remind-after  답이 없는 질문을 다시 알리기까지의 초. 기본 600
//     --once          한 번만 조회하고 끝낸다
//
// 출력(stdout, 한 줄에 하나):
//     QUESTION <id> <type> from=<보낸 쪽>: <본문 앞 160자>   처음 보는 미답변 질문
//     REMINDER <id> <type> from=<보낸 쪽>: <본문 앞 160자>   --remind-after 초가 지나도 답이 없는 질문
//     WATCH-ERROR <이유>   조회 실패. check 실패, 질문 기록을 읽지 못함, 답변 기록 한도, state/questions-seen.json 을 읽거나 쓰지 못함,
//                         그 파일의 꼴이 틀림(최상위나 Run 의 값이 객체가 아니거나 알린 시각이 수가 아님).
//                         stderr 에도 같은 줄을 남긴다(wait-important 와 같은 꼴). 하네스는 Monitor 의 stderr 를 알림으로 보내지 않아
//                         조회가 계속 실패해도 코디네이터가 몰랐다.
//                         같은 이유는 이유가 바뀌거나 조회가 한 번 성공할 때까지 다시 내지 않는다. 조회 간격마다 코디네이터를 깨우지 않게 한다.
//                         --once 는 한 번만 조회하므로 실패하면 늘 낸다
//     질문이 100건 이상인 Run 의 조회 범위 안내는 stderr 로만 낸다(lib/questions.ts 머리 주석).
//
// 알린 시각은 Run 별로 <orch 작업 폴더>/state/questions-seen.json 에 적는다. 조회가 실패하면 그 파일을 지우거나 바꾸지 않는다.
// 파일의 바이트 꼴은 옛 명령의 json.dumps(ensure_ascii=False) 와 같다(lib/py.ts 의 pyJson). 값은 epoch 초다.
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts). 테스트가 poll 을 import 한다. 명령으로 실행했을 때만 main 을 부른다.
// 질문은 lib/questions.ts 의 snapshot 으로 읽는다. ORCA 환경 변수로 orca 실행 파일을 바꾼다.
//
// 이벤트: QUESTION 이나 REMINDER 줄을 낸 직후 worker-question 을 낸다(docs/data-schema.md 「이벤트별 필드」).
//     worker.task, worker.dispatch 는 질문 메시지에서, worker.terminal 은 보낸 쪽이다. 핸들러의 실패는 종료 코드를 바꾸지 않는다.
//
// 종료 코드: 0 --once 조회 성공, 1 --once 조회 실패, 2 사용법 오류. 반복 모드는 실패해도 다음 간격에 다시 조회한다.

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { context } from './lib/completion.ts'
import { fire } from './lib/events.ts'
import { defaultBase, mainCheckout } from './lib/git.ts'
import { makeParent, pathOf } from './lib/paths.ts'
import { pyJson, pyStr as text } from './lib/py.ts'
import { ageSeconds, snapshot } from './lib/questions.ts'
import type { Message } from './lib/questions.ts'

const USAGE = '사용법: watch-questions.ts [--run ID] [--repo DIR] [--interval 60] [--remind-after 600] [--once]'

type Seen = Record<string, Record<string, number>>
type Notice = { line: string; message: Message; reminder: boolean }

function exists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}

// Python 의 str.split() 처럼 공백 덩어리로 나눠 한 칸으로 잇고 앞 160자(코드 포인트)만 남긴다
function brief(body: unknown): string {
  const flat = String(body || '').split(/\s+/).filter(Boolean).join(' ')
  return Array.from(flat).slice(0, 160).join('')
}

// now 는 epoch 초다. 알릴 줄을 정하고 알린 시각을 state 에 적는다.
export function poll(run: string | null, state: string, now: number, remindAfter: number, repo: string): { run: string; notices: Notice[] } {
  const found = snapshot(run)
  const seen = (exists(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}) as Seen
  const isMap = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)
  const malformed = () => new Error(`알림 기록 형식이 잘못됐다: ${state}`)
  if (!isMap(seen) || (Object.hasOwn(seen, found.run) && !isMap(seen[found.run]))) throw malformed()
  const notified = (seen[found.run] ??= {})
  const key = (m: Message): [string, string] => [String(m.created_at ?? ''), String(m.id)]
  const ordered = [...found.pending].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0
  })
  const notices: Notice[] = []
  for (const message of ordered) {
    const id = String(message.id)
    const previous: unknown = notified[id]
    // 옛 명령은 수가 아닌 값에서 뺄셈이 TypeError 로 실패해 조회 실패로 끝났다. 문자열 "1000" 을 수로 읽어 넘기지 않는다
    if (previous !== undefined && previous !== null && (typeof previous !== 'number' || !Number.isFinite(previous))) throw malformed()
    if (typeof previous === 'number' && now - previous < remindAfter) continue
    const reminder = previous !== undefined && previous !== null
    notices.push({
      line: `${reminder ? 'REMINDER' : 'QUESTION'} ${id} ${text(message.type)} from=${text(message.from_handle)}: ${brief(message.body)}`,
      message,
      reminder,
    })
    notified[id] = now
  }
  makeParent(state, repo)
  // 쓰는 도중에 끊겨도 앞 기록이 깨지지 않게 옆 파일에 쓰고 바꾼다
  const temporary = state.replace(/\.json$/, '') + '.tmp'
  writeFileSync(temporary, `${pyJson(seen)}\n`)
  renameSync(temporary, state)
  return { run: found.run, notices }
}

function positive(name: string, value: string): number {
  const number = value.trim() === '' ? Number.NaN : Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} 는 양수여야 한다: ${value}`)
  return number
}

async function main(argv: string[]): Promise<number> {
  let values
  let interval: number
  let remindAfter: number
  try {
    const options = {
      run: { type: 'string' },
      repo: { type: 'string' },
      interval: { type: 'string', default: '60' },
      'remind-after': { type: 'string', default: '600' },
      once: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
    interval = positive('--interval', values.interval as string)
    remindAfter = positive('--remind-after', values['remind-after'] as string)
  } catch (e) {
    process.stderr.write(`${USAGE}\nwatch-questions: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const repo = values.repo ?? process.cwd()
  const state = join(pathOf('state', repo), 'questions-seen.json')
  let run: string | null = values.run ?? null
  let lastError: string | null = null
  for (;;) {
    let notices: Notice[] = []
    try {
      const polled = poll(run, state, Date.now() / 1000, remindAfter, repo)
      run = polled.run
      notices = polled.notices
      lastError = null
    } catch (e) {
      // 예외의 종류를 가리지 않고 모두 WATCH-ERROR 로 바꾼다. 감시는 Monitor 의 이벤트 소스라, 죽으면 그 뒤의 질문을 아무도 알리지 않는다.
      // 옛 명령은 정한 예외(OSError, ValueError 같은 것)만 잡아 그 밖의 예외로 감시가 끝났다. 반복 모드는 다음 간격에 다시 조회한다
      const reason = String((e as Error)?.message ?? e).replace(/\r?\n|\r/g, ' ')
      const line = `WATCH-ERROR ${reason}`
      if (values.once || reason !== lastError) process.stdout.write(`${line}\n`)
      process.stderr.write(`${line}\n`)
      lastError = reason
      if (values.once) return 1
    }
    for (const notice of notices) {
      process.stdout.write(`${notice.line}\n`)
      await notify(notice, repo, run)
    }
    if (values.once) return 0
    await sleep(interval * 1000)
  }
}

async function notify(notice: Notice, repo: string, run: string | null): Promise<void> {
  const { message } = notice
  const [task, dispatch] = context(message)
  const root = mainCheckout(repo)
  try {
    await fire(
      'worker-question',
      {
        worker: { task, dispatch, terminal: message.from_handle ?? null, worktree: null, spec: null },
        message: { id: message.id ?? null, type: message.type ?? null, subject: message.subject ?? null, body: message.body ?? null },
        reminder: notice.reminder,
        age_sec: Math.trunc(ageSeconds(message, Date.now() / 1000)),
      },
      { repo: root, base: defaultBase(root) ?? '', run },
    )
  } catch (e) {
    // 질문 줄은 이미 냈다. 이벤트 실행기의 오류(설정 파일 오류 포함)로 감시를 멈추면 다음 질문을 알리지 못한다
    process.stderr.write(`watch-questions: worker-question 을 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e: unknown) => {
      process.stderr.write(`watch-questions: ${(e as Error)?.stack ?? String(e)}\n`)
      process.exitCode = 1
    },
  )
}
