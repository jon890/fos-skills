// 보드 상태와 단계 명령. 검사와 저장은 board.ts 에 맡기고 결과 JSON 을 짧게 보인다.
// 사용법: orch board set <항목> <상태> | step <항목> <번호> done|undo|text "<글>"|auto|ask|plain|wait ["<조건>"]
//         orch board add-step <항목> "<글>" | show <항목>
// 공통: --repo DIR, --board FILE. text/add-step: --on "<PR> <사건>".
// 짧은 출력: BOARD-SET, BOARD-STEP, BOARD-STEP-ADD 한 줄. show 는 BOARD 머리와 미완료 단계.
// 진입점의 --full 은 모든 줄도 낸다. 종료 코드: 0 성공, 1 거절, 2 사용법·설정 오류.
import { unmatchedRecords, unmatchedLine, unmatchedResolved } from '../lib/board-unmatched.ts'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { BOARD_BIN, GET_FIELDS, itemTitle } from '../lib/board.ts'
import { boardPath } from '../lib/board-file.ts'
import { fullAsked } from '../lib/output.ts'
import { NO_LIMIT_MS, run, scriptCommand } from '../lib/proc.ts'

const USAGE = `사용법:
  orch board set <항목> <상태>
  orch board step <항목> <번호> done|undo
  orch board step <항목> <번호> text "<글>" [--on "<PR> <pr|merge|deploy|release>"]
  orch board step <항목> <번호> auto|ask|plain
  orch board step <항목> <번호> wait ["<조건>"]
  orch board add-step <항목> "<글>" [--on "<PR> <pr|merge|deploy|release>"]
  orch board show <항목> [--json]
  orch board get <항목> <칸> [--json] (칸: ${GET_FIELDS.filter((field) => field !== 'step').join(' ')})
  orch board get <항목> step <번호> [--json]
  orch board list [--status <상태>[,<상태>…]] [--json]
  orch board del <항목> [--force]
  orch board del --done
  공통: [--repo <폴더>] [--board <파일>] [--full]
  - 로 시작하는 글은 그대로 받지 않는다. "10. - 하위 항목"처럼 단계 번호를 앞에 붙인다.`
const OPTIONS = {
  repo: { type: 'string' }, board: { type: 'string' }, on: { type: 'string' },
  json: { type: 'boolean' }, status: { type: 'string' }, done: { type: 'boolean' }, force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type View = {
  id: string; status: string | null; was: string | null; number?: number
  progress: [number, number] | null
  lines: { number: number | null; done: boolean; text: string }[]
}

function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: true })
  } catch (e) {
    process.stderr.write(`${USAGE}\n${(e as Error).message}\n`)
    return 2
  }
  const { positionals: args, values } = parsed
  if (values.help) { console.log(USAGE); return 0 }
  const [verb, id, third, action, text] = args
  let command: string[]
  let trailing: string[] = []
  const usage = () => { process.stderr.write(`${USAGE}\n`); return 2 }
  if ((values.done || values.force) && verb !== 'del') return usage()
  if (verb === 'del' && (values.json || values.status !== undefined || values.on !== undefined)) return usage()
  if ((values.json && !['get', 'list', 'show'].includes(verb)) || (values.status !== undefined && verb !== 'list') || (values.on !== undefined && ['get', 'list', 'show'].includes(verb))) return usage()
  if (verb === 'del' && args.length === 2 && !values.done) command = values.force ? ['del', id, '--exact'] : ['del-done', id]
  else if (verb === 'del' && args.length === 1 && values.done && !values.force) command = ['del-done']
  else if (verb === 'get' && GET_FIELDS.includes(third as typeof GET_FIELDS[number]) && ((third === 'step' && args.length === 4 && /^\d+$/.test(action)) || (third !== 'step' && args.length === 3))) command = ['get', id, third, ...(third === 'step' ? [action] : [])]
  else if (verb === 'list' && args.length === 1) { command = ['items']; if (values.status !== undefined) trailing = ['--', values.status] }
  else if (verb === 'set' && args.length === 3 && values.on === undefined) command = ['set', id, third, '--exact']
  else if (verb === 'show' && args.length === 2 && values.on === undefined) command = [values.json ? 'item' : 'view', id]
  else if (verb === 'add-step' && args.length === 3) command = ['step-add', id, third]
  else if (verb === 'step' && /^\d+$/.test(third ?? '')) {
    if (action === 'text' && args.length === 5) command = ['step-edit', id, third, text]
    else if (['done', 'undo'].includes(action) && args.length === 4 && values.on === undefined) {
      command = ['step', id, third, '--exact', ...(action === 'undo' ? ['--undo'] : [])]
    } else if (['auto', 'ask', 'plain'].includes(action) && args.length === 4 && values.on === undefined) command = ['step-mark', id, third, action]
    else if (action === 'wait' && (args.length === 4 || args.length === 5) && values.on === undefined) command = ['step-mark', id, third, action, ...(text === undefined ? [] : [text])]
    else return usage()
  } else return usage()
  if (values.on !== undefined) command.push('--event', values.on)
  try { command.push('--file', boardPath(values.repo ?? process.cwd(), values.board)) }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 2 }
  command.push(...trailing)
  const result = run(scriptCommand(process.env.BOARD_BIN || BOARD_BIN, command), { timeoutMs: NO_LIMIT_MS })
  process.stderr.write(result.stderr)
  if (result.code !== 0 && !(verb === 'get' && result.code === 4)) return result.code
  if (verb === 'del') {
    const deleted = JSON.parse(result.stdout).deleted as unknown[]
    console.log(deleted.length ? deleted.map((id) => `BOARD-DEL ${String(id)}`).join('\n') : 'BOARD-NONE')
    return 0
  }
  if (verb === 'get') {
    if (values.json) process.stdout.write(result.stdout)
    else { const value = JSON.parse(result.stdout).value; if (value !== null) console.log(value) }
    return result.code
  }
  const pending = (view: View, records: ReturnType<typeof unmatchedRecords>) => Object.keys(records[String(view.id)] ?? {})
    .filter((pr) => !unmatchedResolved(view.lines.filter((line) => line.number !== null) as { number: number; done: boolean; text: string }[], pr))
  if (verb === 'list') {
    if (values.json) { process.stdout.write(result.stdout); return 0 }
    const rows = JSON.parse(result.stdout) as (View & Record<string, unknown>)[]
    if (!rows.length) { console.log('BOARD-NONE'); return 0 }
    const records = fullAsked() ? unmatchedRecords(values.repo ?? process.cwd()) : {}
    for (const row of rows) {
      const title = itemTitle(row)
      console.log(`BOARD ${row.id} ${typeof row.status === 'string' ? row.status : null} ${row.progress ? row.progress.join('/') : '진행률 없음'}${title === null ? '' : ` ${title}`}`)
      if (fullAsked()) for (const line of [...pending(row, records).map((pr) => unmatchedLine(String(row.id), pr)), ...row.lines.map((line) => `${line.done ? '✓ ' : ''}${line.text}`)]) console.log(line)
    }
    return 0
  }
  let view: View
  try { view = JSON.parse(result.stdout) as View }
  catch { process.stderr.write('board.ts 결과를 JSON 으로 읽지 못했다\n'); return 1 }
  if (verb === 'show' && values.json) {
    console.log(JSON.stringify({ ...view, unmatched: pending(view, unmatchedRecords(values.repo ?? process.cwd())).map(Number) }))
    return 0
  }
  let heading: string
  if (verb === 'show') heading = `BOARD ${view.id} ${view.status} ${view.progress ? view.progress.join('/') : '진행률 없음'}`
  else if (verb === 'set') heading = `BOARD-SET ${view.id} ${view.status}`
  else if (verb === 'add-step') heading = `BOARD-STEP-ADD ${view.id} ${view.number}`
  else heading = `BOARD-STEP ${view.id} ${view.number} ${action}${view.was !== view.status ? ` status=${view.status}` : ''}`
  const lines = fullAsked() ? view.lines : verb === 'show' ? view.lines.filter((line) => line.number !== null && !line.done) : []
  const unmatched = verb === 'show' ? pending(view, unmatchedRecords(values.repo ?? process.cwd())).map((pr) => unmatchedLine(id, pr)) : []
  console.log([heading, ...unmatched, ...lines.map((line) => `${line.done ? '✓ ' : ''}${line.text}`)].join('\n'))
  return 0
}

process.exitCode = main(process.argv.slice(2))
