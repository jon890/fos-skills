// 저장소의 작업 현황 파일(board.json)을 고친다. work-board mod 가 이 파일을 읽어 /board 창에 보여 준다.
//
// 파일 위치: git 루트의 .omc/board.json. 이미 .omc/handoffs/board.json 이 있으면 그것을 쓴다. --file 로 바꿀 수 있다.
// 이 기본 위치 규칙은 defaultBoardPath 한 곳이 소유한다. orch 의 lib/paths.ts 가 import 해 같은 값을 쓴다.
// import 할 때 명령이 돌지 않도록 명령 실행은 import.meta.main 안에만 둔다.
//
// 사용:
//   board.ts set <id> [<status>] [--title T] [--owner O] [--pr P] [--next N] [--worktree W] [--branch B] [--progress N/M] [--stages S] [--detail D ...]
//   --branch 와 --merged-pr 은 orch 가 브랜치와 처리한 머지 PR 을 기억하는 칸이다.
//   --stages 는 orch 가 사건과 단계 번호의 짝(「pr=1,merge=2,deploy=3,release=4」)을 기억하는 칸이다. 사건은 pr, merge, deploy, release 다
//   --pr 과 --merged-pr 은 「#555」 와 「555」 를 같게 숫자 555 로 저장한다. 여럿(「#492, #495」)은 「492, 495」 문자열이다
//   (--worktree 는 그 항목을 맡은 worker 의 워크트리 이름이다. 창이 그 worker 상태를 항목 아래에 붙인다)
//   (값을 '' 로 주면 그 칸을 지운다. --detail 은 여러 번 줄 수 있고 주면 하위 항목 전체를 바꾼다. --detail '' 은 지운다)
//   (--next 를 여러 번 주면 줄바꿈으로 잇는다. 「--next '1. 구현' --next '2. 머지'」 가 단계 두 줄이 된다)
//   doing 항목은 진행률이 있어야 한다. 단계 줄이나 --progress N/M 이 없으면 set 을 거절하고 보드를 고치지 않는다
//   board.ts step <id> <n> [--undo]   (n 번 단계 줄을 끝낸 것으로 표시한다. --undo 는 되돌린다)
//   board.ts steps <id>   (진행률을 세는 단계 줄을 JSON 목록 [{"number", "done", "text"}] 으로 낸다. 보드를 고치지 않는다)
//     단계 밖의 줄이 있으면 stderr 에 mark 번호와 함께 낸다. stdout 의 JSON 은 orch 가 읽어 단계를 판정하므로 그 줄을 넣지 않는다
//   board.ts mark <id> <n> [--undo]   (n 번 줄을 끝낸 것으로 표시한다. n 은 details 다음 next 순서로 1부터 센 줄 번호이고 번호 없는 줄도 센다. 빈 줄은 세지 않는다)
//     step 과 mark 뒤에 decide 항목의 줄이 모두 끝났으면 그 항목을 done 으로 바꾼다. --undo 는 status 를 바꾸지 않는다
//   board.ts del <id>
//   board.ts list   (항목마다 진행률 「n/m (p%)」 를 붙이고, 그 아래에 details 와 next 의 줄을 mark 번호와 끝냄 표시 ✓ 와 함께 낸다)
// status: goal(목표) | decide(결정 필요) | doing(진행 중) | wait(대기) | done(완료)
// 진행률은 단계 줄에서 센다. --progress 는 단계로 나타낼 수 없을 때만 쓴다
//   단계 줄은 번호로 시작하는 줄이다. 「1 …」, 「1. …」, 「1) …」 를 모두 단계로 본다. 참고 줄은 세지 않는다
//   줄 앞의 「✓」 나 「[x]」 는 끝낸 단계, 「[ ]」, 「▶」, 「◇」 는 끝나지 않은 단계다
//   하위 항목(--detail)에 단계 줄이 있으면 그것을 세고, 없으면 --next 의 줄을 센다
//   next 와 details 는 줄마다 {"text": "1. 구현", "done": false} 객체로 저장한다
//   step 은 done 값만 바꾸고, 창이 체크 표시와 취소선을 그린다. 옛 문자열은 읽을 때 변환하고 다음 쓰기 때 저장한다
//   --progress N/M 은 「끝낸 단계/전체 단계」 (예: 7/10) 를 직접 적고 단계 수보다 앞선다. 주지 않으면 기존 값을 지우지 않는다
//   --progress auto 는 값을 지워 단계 수로 세게 한다
// 옵션은 고유 접두로 줄여 쓸 수 있다(옛 board.py 의 argparse 와 같다). --help 나 -h 는 사용법을 stdout 에 내고 0 이다.
// 항목은 id 의 값과 타입이 모두 같을 때만 맞는다. 명령줄의 id 는 문자열이라 숫자 id(1)는 「1」 로 찾지 못한다(옛 board.py 와 같다).
//
// 파일은 json.dump(indent=1, ensure_ascii=False) 의 꼴로 쓴다. 한 칸 들여쓰기, 한글 그대로, 끝 줄바꿈 없음이다.
// 숫자는 JS 의 number 로 읽고 쓰므로 옛 board.py 와 다르게 바뀌는 값이 있다. 소수점 아래가 0 인 실수(1.0)는 1 이 되고,
// 2^53 을 넘는 정수는 가까운 double 로 바뀐다. 이 명령이 쓰는 칸은 PR 번호 칸을 빼면 모두 문자열이라, 손대지 않은 칸에 그런 숫자가 있을 때만 바뀐다.
//
// 종료 코드: 0 반영했다, 1 거절했다(이유는 stderr), 2 사용법 오류

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

const STATUSES = ['goal', 'decide', 'doing', 'wait', 'done']
// 단계 줄: 앞 표시(끝냄 ✓ [x], 안 끝냄 [ ] ▶ ◇)와 번호. hooks/register.js 의 STEP 과 같은 규칙이다
const STEP = /^\s*(?:(✓|\[[xX ]\]|▶|◇)\s*)?(\d+)[.)]?\s/
const DONE_MARKS = ['✓', '[x]', '[X]']
const LEAD_MARK = /^\s*(✓|\[[xX ]\]|▶|◇)\s*/
const PROGRESS = /^\s*(\d+)\s*\/\s*(\d+)\s*$/
const FIELDS = ['title', 'owner', 'pr', 'worktree', 'branch', 'merged-pr', 'progress', 'stages'] as const
// stages 칸의 값. 사건과 단계 번호의 짝을 쉼표로 잇는다
const STAGES = /^\s*(?:pr|merge|deploy|release)=\d+(?:\s*,\s*(?:pr|merge|deploy|release)=\d+)*\s*$/
// PR 번호를 담는 칸. 「#555」 와 「555」 를 같은 값으로 저장한다(prValue)
const PR_FIELDS: ReadonlySet<string> = new Set(['pr', 'merged-pr'])
// 번호 하나와 구분자만 든 값. 「#492, #495」 「492/495」 를 받는다
const PR_LIST = /^\s*#?\d+(?:\s*[,/ ]\s*#?\d+)*\s*$/
const COMMANDS = ['set', 'step', 'steps', 'mark', 'del', 'list']
const USAGE =
  '사용법: board.ts {set,step,steps,mark,del,list} [id] [status] [--undo] [--title T] [--owner O] [--pr P] [--worktree W] [--branch B] ' +
  '[--progress N/M] [--stages S] [--detail D] [--next N] [--file F]'
// --help 가 내는 글. 옛 board.py 의 argparse 도움말처럼 사용법 줄 뒤에 머리 설명을 붙인다
const HELP = `${USAGE}

저장소의 작업 현황 파일(board.json)을 고친다. work-board mod 가 이 파일을 읽어 /board 창에 보여 준다.

파일 위치: git 루트의 .omc/board.json. 이미 .omc/handoffs/board.json 이 있으면 그것을 쓴다. --file 로 바꿀 수 있다.

사용:
  board.ts set <id> [<status>] [--title T] [--owner O] [--pr P] [--next N] [--worktree W] [--branch B] [--progress N/M] [--stages S] [--detail D ...]
  (--stages 는 사건과 단계 번호의 짝이다. 「pr=1,merge=2,deploy=3,release=4」. orch 가 쓴다)
  (--worktree 는 그 항목을 맡은 worker 의 워크트리 이름이다. 창이 그 worker 상태를 항목 아래에 붙인다)
  (값을 '' 로 주면 그 칸을 지운다. --detail 은 여러 번 줄 수 있고 주면 하위 항목 전체를 바꾼다. --detail '' 은 지운다)
  (--next 를 여러 번 주면 줄바꿈으로 잇는다. 「--next '1. 구현' --next '2. 머지'」 가 단계 두 줄이 된다)
  doing 항목은 진행률이 있어야 한다. 단계 줄이나 --progress N/M 이 없으면 set 을 거절하고 보드를 고치지 않는다
  board.ts step <id> <n> [--undo]   (n 번 단계 줄을 끝낸 것으로 표시한다. --undo 는 되돌린다)
  board.ts steps <id>   (진행률을 세는 단계 줄을 JSON 목록 [{"number", "done", "text"}] 으로 낸다. 보드를 고치지 않는다)
    단계 밖의 줄이 있으면 stderr 에 mark 번호와 함께 낸다
  board.ts mark <id> <n> [--undo]   (n 번 줄을 끝낸 것으로 표시한다. n 은 details 다음 next 순서로 1부터 센 줄 번호이고 번호 없는 줄도 센다. 빈 줄은 세지 않는다)
    step 과 mark 뒤에 decide 항목의 줄이 모두 끝났으면 그 항목을 done 으로 바꾼다. --undo 는 status 를 바꾸지 않는다
  board.ts del <id>
  board.ts list   (항목마다 진행률 「n/m (p%)」 를 붙이고, 그 아래에 details 와 next 의 줄을 mark 번호와 끝냄 표시 ✓ 와 함께 낸다)
status: goal(목표) | decide(결정 필요) | doing(진행 중) | wait(대기) | done(완료)
진행률은 단계 줄에서 센다. --progress 는 단계로 나타낼 수 없을 때만 쓴다
  단계 줄은 번호로 시작하는 줄이다. 「1 …」, 「1. …」, 「1) …」 를 모두 단계로 본다. 참고 줄은 세지 않는다
  줄 앞의 「✓」 나 「[x]」 는 끝낸 단계, 「[ ]」, 「▶」, 「◇」 는 끝나지 않은 단계다
  하위 항목(--detail)에 단계 줄이 있으면 그것을 세고, 없으면 --next 의 줄을 센다
  --progress N/M 은 「끝낸 단계/전체 단계」 (예: 7/10) 를 직접 적고 단계 수보다 앞선다. 주지 않으면 기존 값을 지우지 않는다
  --progress auto 는 값을 지워 단계 수로 세게 한다`

const MISSING_PROGRESS = (id: string) => `doing 항목에는 진행률이 필요하다: ${id}
  단계 줄을 적는다: --next '1. 구현' --next '2. 리뷰 반영' --next '3. 머지' (끝낸 단계는 앞에 ✓ 나 [x])
  단계로 나타낼 수 없으면 --progress 끝낸단계/전체단계 (예: --progress 2/5) 를 준다`

type Line = { text: string; done: boolean }
type Item = Record<string, unknown> & { id: string }
type Board = Record<string, unknown> & { items: Item[] }

// 보드 파일의 기본 위치. cwd 의 git 작업 트리 최상위(--show-toplevel)가 기준이고, git 밖이면 cwd 다.
// 주 checkout 이 아니라 작업 트리 기준이다. 옛 board.py 의 board_path 가 그랬다.
export function defaultBoardPath(cwd: string): string {
  const done = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const top = done.status === 0 ? (done.stdout ?? '').trim() : ''
  const root = top || cwd
  const legacy = join(root, '.omc/handoffs/board.json')
  return existsSync(legacy) ? legacy : join(root, '.omc/board.json')
}

class Refused extends Error {}

// 옛 문자열을 {text, done} 으로 바꾼다. 객체의 done 값이 앞 표시보다 우선한다.
function normalizeLine(line: unknown): Line {
  let text: string
  let done: boolean
  if (typeof line === 'object' && line !== null && !Array.isArray(line)) {
    const row = line as Record<string, unknown>
    if (!('text' in row)) throw new Error('단계 줄 객체에 text 가 없다')
    text = String(row.text)
    done = row.done === true
  } else {
    text = String(line)
    const mark = LEAD_MARK.exec(text)
    done = Boolean(mark && DONE_MARKS.includes(mark[1]))
  }
  return { text: text.replace(LEAD_MARK, ''), done }
}

// Python 의 `value or ''` 처럼 거짓 값은 빈 줄 하나가 된다
function normalizeLines(value: unknown): Line[] {
  const lines = Array.isArray(value) ? value : String(value || '').split('\n')
  return lines.map(normalizeLine)
}

function normalizeItem(item: Item): void {
  for (const key of ['details', 'next']) {
    if (key in item) item[key] = normalizeLines(item[key])
  }
}

// 단계 줄이면 [번호, 끝냈는지] 를, 아니면 null 을 돌려준다.
function parseStep(line: unknown): [number, boolean] | null {
  const row = normalizeLine(line)
  const m = STEP.exec(row.text)
  return m ? [Number(m[2]), row.done] : null
}

// 하위 항목에 단계가 있으면 그것을, 없으면 next 의 줄을 쓴다.
function stepSource(item: Item): [string | null, Line[]] {
  for (const key of ['details', 'next']) {
    const lines = normalizeLines(item[key] || [])
    if (lines.some((line) => parseStep(line))) return [key, lines]
  }
  return [null, []]
}

// [끝낸 단계, 전체 단계]. progress 가 N/M 이면 그 값을, 아니면 단계 줄을 센다. 없으면 null
function progressOf(item: Item): [number, number] | null {
  const m = PROGRESS.exec(String(item.progress || ''))
  if (m && Number(m[2]) > 0) return [Math.min(Number(m[1]), Number(m[2])), Number(m[2])]
  const steps = stepSource(item)[1]
    .map(parseStep)
    .filter((step): step is [number, boolean] => step !== null)
  return steps.length > 0 ? [steps.filter((step) => step[1]).length, steps.length] : null
}

// Python 의 round 다. 딱 반인 값은 짝수 쪽으로 간다(12.5 → 12). Math.round 는 13 이라 옛 출력과 달라진다
function pyRound(value: number): number {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function progressText(item: Item): string {
  const progress = progressOf(item)
  if (progress === null) return '진행률 없음'
  const [done, total] = progress
  return `${done}/${total} (${pyRound((done * 100) / total)}%)`
}

// details 다음 next 순서의 모든 줄. 번호 없는 참고 줄도 들고, mark 번호는 이 순서의 1부터다.
// text 가 비었거나 공백뿐인 줄은 뺀다. 창(register.js 의 decideCount)도 그 줄을 세지 않아 결정 필요 수와 mark 번호가 같은 줄을 가리킨다
// 줄 객체는 item 에 든 것 그대로라 done 을 바꾸면 항목이 바뀐다. main 이 normalizeItem 으로 목록을 Line[] 로 바꿔 둔다
function allLines(item: Item): Line[] {
  return ['details', 'next']
    .flatMap((key) => (Array.isArray(item[key]) ? (item[key] as Line[]) : []))
    .filter((line) => line.text.trim())
}

// list 와 steps 의 stderr 가 내는 줄 꼴. 「    3 ✓ 본문」 이나 「    3   본문」 이다
function lineText(number: number, line: Line): string {
  return `    ${number} ${line.done ? '✓' : ' '} ${line.text}\n`
}

// 줄이 하나 이상 있고 모두 끝난 decide 항목을 done 으로 바꾼다. 결정 필요 수에서 그 항목을 빼기 위해서다(ADR-015)
function closeDecided(item: Item): void {
  const lines = allLines(item)
  if (item.status === 'decide' && lines.length > 0 && lines.every((line) => line.done)) item.status = 'done'
}

// Python 의 str.ljust 처럼 글자 수로 채운다
function ljust(text: string, width: number): string {
  const length = [...text].length
  return length >= width ? text : text + ' '.repeat(width - length)
}

// datetime.now().astimezone().isoformat(timespec='seconds') 의 꼴(2026-10-24T15:00:00+09:00)
function localIso(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

// json.dumps(ensure_ascii=False) 의 꼴. 구분자가 `, ` 와 `: ` 다. steps 출력을 읽는 쪽과 바이트를 맞춘다.
// orch/scripts/lib/py.ts 의 pyJson 과 같다. work-board 는 orch 를 import 하지 않아(의존은 orch 에서 work-board 쪽 하나다) 복사해 두었다.
// 바꾸면 함께 고친다
function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`)
      .join(', ')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// 고유 접두로 줄인 긴 옵션을 온 이름으로 펼친다. `--` 뒤는 건드리지 않는다.
// orch/scripts/lib/args.ts 의 expandArgs 에 문자열 옵션을 모두 join 으로 준 것과 같다. 복사한 까닭은 pyJson 과 같다.
// 바꾸면 함께 고친다. flags 는 값을 받지 않는 옵션이다
function expand(argv: string[], names: string[], flags: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      out.push(...argv.slice(i))
      break
    }
    if (!token.startsWith('--') || token.length === 2) {
      out.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const given = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    const matches = names.includes(given) ? [given] : names.filter((name) => name.startsWith(given))
    if (matches.length > 1) throw new Error(`--${given} 이 여러 옵션의 접두다: ${matches.map((name) => `--${name}`).join(', ')}`)
    const name = matches[0] ?? given
    // 값을 받는 옵션은 바로 뒤 인자를 값으로 붙인다. `--next '-x'` 처럼 - 로 시작하는 값도 받는다
    if (eq < 0 && !flags.includes(name) && names.includes(name) && i + 1 < argv.length) {
      out.push(`--${name}=${argv[++i]}`)
      continue
    }
    out.push(`--${name}${eq >= 0 ? token.slice(eq) : ''}`)
  }
  return out
}

type Args = {
  cmd: string
  id?: string
  status?: string
  undo: boolean
  fields: Partial<Record<(typeof FIELDS)[number], string>>
  detail?: string[]
  next?: string[]
  file?: string
}

function parse(argv: string[]): Args | 'help' {
  const options = {
    undo: { type: 'boolean' },
    title: { type: 'string' },
    owner: { type: 'string' },
    pr: { type: 'string' },
    worktree: { type: 'string' },
    branch: { type: 'string' },
    'merged-pr': { type: 'string' },
    progress: { type: 'string' },
    stages: { type: 'string' },
    detail: { type: 'string', multiple: true },
    next: { type: 'string', multiple: true },
    file: { type: 'string' },
  } as const
  const args = expand(argv, [...Object.keys(options), 'help'], ['undo', 'help'])
  // argparse 처럼 다른 인자가 틀려도 -h 나 --help(줄임 포함)가 `--` 앞에 있으면 도움말이 먼저다
  const end = args.indexOf('--')
  const head = end < 0 ? args : args.slice(0, end)
  if (head.includes('-h') || head.includes('--help')) return 'help'
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true })
  if (positionals.length === 0) throw new Error('cmd 가 필요하다')
  if (positionals.length > 3) throw new Error(`모르는 인자: ${positionals.slice(3).join(' ')}`)
  const [cmd, id, status] = positionals
  if (!COMMANDS.includes(cmd)) throw new Error(`cmd 는 ${COMMANDS.join(', ')} 중 하나다: ${cmd}`)
  const fields: Args['fields'] = {}
  for (const key of FIELDS) if (values[key] !== undefined) fields[key] = values[key]
  return { cmd, id, status, undo: values.undo ?? false, fields, detail: values.detail, next: values.next, file: values.file }
}

// pr 칸과 merged-pr 칸의 저장 값. PR 번호 하나면 숫자, 여럿이면 「492, 495」 문자열이다. PR 번호만 든 값이 아니면 그대로 둔다
function prValue(value: string): string | number {
  if (!PR_LIST.test(value)) return value
  const numbers = value.match(/\d+/g) as string[]
  return numbers.length === 1 ? Number(numbers[0]) : numbers.join(', ')
}

// === 라 문자열 id 만 맞는다. 옛 board.py 의 `i['id'] == a.id` 도 문자열과 숫자를 같게 보지 않았다
function find(board: Board, id: string): Item | undefined {
  return board.items.find((item) => item.id === id)
}

// 보드를 고친다. 쓸 내용이 있으면 true, 읽기만 했으면 false 다.
function apply(a: Args, board: Board): boolean {
  if (a.cmd === 'list') {
    for (const item of board.items) {
      const status = typeof item.status === 'string' ? item.status : String(item.status ?? '?')
      process.stdout.write(`${ljust(status, 7)} ${ljust(String(item.id), 16)} ${String(item.title ?? '')}   ${progressText(item)}\n`)
      allLines(item).forEach((line, index) => process.stdout.write(lineText(index + 1, line)))
    }
    return false
  }
  if (!a.id) throw new Refused('id 가 필요하다')
  const id = a.id
  if (a.cmd === 'steps') {
    const item = find(board, id)
    if (!item) throw new Refused(`항목이 없다: ${id}`)
    const [source, lines] = stepSource(item)
    const steps = lines.flatMap((line) => {
      const step = parseStep(line)
      return step ? [{ number: step[0], done: step[1], text: line.text }] : []
    })
    process.stdout.write(`${pyJson(steps)}\n`)
    // 진행률을 세지 않는 줄: 단계를 세는 쪽의 참고 줄과 다른 쪽의 모든 줄이다. mark 로 끝낼 수 있게 그 번호를 보인다
    const outside = allLines(item).flatMap((line, index) => {
      const counted = source !== null && (item[source] as Line[]).includes(line) && parseStep(line) !== null
      return counted ? [] : [lineText(index + 1, line)]
    })
    if (outside.length > 0) process.stderr.write(`단계 밖의 줄(mark 번호):\n${outside.join('')}`)
    return false
  }
  if (a.cmd === 'step') {
    const item = find(board, id)
    if (!item) throw new Refused(`항목이 없다: ${id}`)
    if (!/^\d+$/.test(a.status ?? '')) throw new Refused('step 에는 단계 번호가 필요하다')
    const number = Number(a.status)
    const [source, lines] = stepSource(item)
    const line = lines.find((row) => parseStep(row)?.[0] === number)
    if (!line || source === null) {
      throw new Refused(`${number} 번 단계 줄이 없다. 단계 줄은 --detail 이나 --next 의 「${number} …」, 「${number}. …」 로 시작하는 줄이다`)
    }
    line.done = !a.undo
    item[source] = lines
    if (!a.undo) closeDecided(item)
    return true
  }
  if (a.cmd === 'mark') {
    const item = find(board, id)
    if (!item) throw new Refused(`항목이 없다: ${id}`)
    if (!/^\d+$/.test(a.status ?? '')) throw new Refused('mark 에는 줄 번호가 필요하다')
    const number = Number(a.status)
    const lines = allLines(item)
    const line = lines[number - 1]
    if (number < 1 || !line) throw new Refused(`${number} 번 줄이 없다. 줄은 ${lines.length} 개다. 번호는 board.ts list 로 본다`)
    line.done = !a.undo
    if (!a.undo) closeDecided(item)
    return true
  }
  if (a.cmd === 'del') {
    board.items = board.items.filter((item) => item.id !== id)
    return true
  }
  let item = find(board, id)
  if (!item) {
    if (!a.status) throw new Refused('새 항목에는 status 가 필요하다')
    item = { id, title: a.fields.title || id }
    board.items.push(item)
  }
  if (a.status) {
    if (!STATUSES.includes(a.status)) throw new Refused(`status 는 ${STATUSES.join('|')} 중 하나다`)
    item.status = a.status
  }
  for (const key of FIELDS) {
    const value = a.fields[key]
    if (value === '' || (key === 'progress' && value === 'auto')) delete item[key]
    else if (value !== undefined) item[key] = PR_FIELDS.has(key) ? prValue(value) : value
  }
  for (const [key, values] of [
    ['details', a.detail],
    ['next', a.next],
  ] as const) {
    if (values === undefined) continue
    const lines = values.flatMap((value) => value.split('\n')).filter((line) => line)
    if (lines.length > 0) item[key] = normalizeLines(lines)
    else delete item[key]
  }
  if (item.status === 'doing' && progressOf(item) === null) throw new Refused(MISSING_PROGRESS(id))
  return true
}

function main(argv: string[]): number {
  let parsed: Args | 'help'
  try {
    parsed = parse(argv)
  } catch (e) {
    process.stderr.write(`${USAGE}\nboard.ts: error: ${(e as Error).message}\n`)
    return 2
  }
  if (parsed === 'help') {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  const a = parsed
  const progress = a.fields.progress
  if (progress !== undefined && progress !== '' && progress !== 'auto' && !PROGRESS.test(progress)) {
    process.stderr.write(`--progress 는 끝낸단계/전체단계 (예: 2/5) 나 auto 다: ${progress}\n`)
    return 1
  }
  const stages = a.fields.stages
  if (stages !== undefined && stages !== '' && !STAGES.test(stages)) {
    process.stderr.write(`--stages 는 사건=단계번호를 쉼표로 이은 값이다(예: pr=1,merge=2). 사건은 pr, merge, deploy, release 다: ${stages}\n`)
    return 1
  }
  const path = a.file || defaultBoardPath(process.cwd())
  const board: Board = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { items: [] }
  for (const item of board.items) normalizeItem(item)
  try {
    if (!apply(a, board)) return 0
  } catch (e) {
    if (!(e instanceof Refused)) throw e
    process.stderr.write(`${e.message}\n`)
    return 1
  }
  board.updatedAt = localIso(new Date())
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(board, null, 1))
  renameSync(tmp, path)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`board.ts: ${(e as Error).message}\n`)
    process.exitCode = 1
  }
}
