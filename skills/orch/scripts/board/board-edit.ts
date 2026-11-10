// 보드 상태와 단계 명령. 검사와 저장은 board.ts 에 맡기고 결과 JSON 을 짧게 보인다.
// 사용법: orch board set <항목> <상태> | step <항목> <번호> done|undo|text "<글>"
//         orch board add-step <항목> "<글>" | show <항목>
// 공통: --repo DIR, --board FILE. text/add-step: --on "<PR> <사건>".
// 짧은 출력: BOARD-SET, BOARD-STEP, BOARD-STEP-ADD 한 줄. show 는 BOARD 머리와 미완료 단계.
// 진입점의 --full 은 모든 줄도 낸다. 종료 코드: 0 성공, 1 거절, 2 사용법·설정 오류.
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { BOARD_BIN } from '../lib/board.ts'
import { boardPath } from '../lib/board-file.ts'
import { fullAsked } from '../lib/output.ts'
import { NO_LIMIT_MS, run, scriptCommand } from '../lib/proc.ts'

const USAGE = `사용법:
  orch board set <항목> <상태>
  orch board step <항목> <번호> done|undo
  orch board step <항목> <번호> text "<글>" [--on "<PR> <pr|merge|deploy|release>"]
  orch board add-step <항목> "<글>" [--on "<PR> <pr|merge|deploy|release>"]
  orch board show <항목>
  공통: [--repo <폴더>] [--board <파일>] [--full]
  - 로 시작하는 글은 그대로 받지 않는다. "10. - 하위 항목"처럼 단계 번호를 앞에 붙인다.`
const OPTIONS = {
  repo: { type: 'string' }, board: { type: 'string' }, on: { type: 'string' },
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
  const usage = () => { process.stderr.write(`${USAGE}\n`); return 2 }
  if (verb === 'set' && args.length === 3 && values.on === undefined) command = ['set', id, third, '--exact']
  else if (verb === 'show' && args.length === 2 && values.on === undefined) command = ['view', id]
  else if (verb === 'add-step' && args.length === 3) command = ['step-add', id, third]
  else if (verb === 'step' && /^\d+$/.test(third ?? '')) {
    if (action === 'text' && args.length === 5) command = ['step-edit', id, third, text]
    else if (['done', 'undo'].includes(action) && args.length === 4 && values.on === undefined) {
      command = ['step', id, third, '--exact', ...(action === 'undo' ? ['--undo'] : [])]
    } else return usage()
  } else return usage()
  if (values.on !== undefined) command.push('--event', values.on)
  try { command.push('--file', boardPath(values.repo ?? process.cwd(), values.board)) }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 2 }
  const result = run(scriptCommand(process.env.BOARD_BIN || BOARD_BIN, command), { timeoutMs: NO_LIMIT_MS })
  process.stderr.write(result.stderr)
  if (result.code !== 0) return result.code
  let view: View
  try { view = JSON.parse(result.stdout) as View }
  catch { process.stderr.write('board.ts 결과를 JSON 으로 읽지 못했다\n'); return 1 }
  let heading: string
  if (verb === 'show') heading = `BOARD ${view.id} ${view.status} ${view.progress ? view.progress.join('/') : '진행률 없음'}`
  else if (verb === 'set') heading = `BOARD-SET ${view.id} ${view.status}`
  else if (verb === 'add-step') heading = `BOARD-STEP-ADD ${view.id} ${view.number}`
  else heading = `BOARD-STEP ${view.id} ${view.number} ${action}${view.was !== view.status ? ` status=${view.status}` : ''}`
  const lines = fullAsked() ? view.lines : verb === 'show' ? view.lines.filter((line) => line.number !== null && !line.done) : []
  console.log([heading, ...lines.map((line) => `${line.done ? '✓ ' : ''}${line.text}`)].join('\n'))
  return 0
}

process.exitCode = main(process.argv.slice(2))
