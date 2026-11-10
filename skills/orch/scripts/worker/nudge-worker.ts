// 화면 읽기 전용 명령. 옛 깨우기 입력은 Orca 메시지로 대체됐다.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { orcaJson } from '../lib/orca.ts'
import { classify, LINE_BREAK, screenLines } from '../lib/screen.ts'
import { retiredMain } from '../lib/retired.ts'

function main(argv: string[]): number {
  const options = { terminal: { type: 'string' }, state: { type: 'boolean' }, classify: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } as const
  // 옛 --text/--msg-id 호출도 옵션 파싱 오류 대신 안내한다.
  if (!argv.some(a => a === '--state' || a === '--classify' || a === '--help' || a === '-h')) return retiredMain('orch worker nudge')
  let values
  try { values = parseArgs({ args: expandArgs(argv, options), options }).values }
  catch (e) { console.error(String(e)); return 2 }
  if (values.help) { console.log('사용법: orch worker screen <터미널> | nudge-worker.ts --classify'); return 0 }
  if (values.classify) { console.log(classify(readFileSync(0, 'utf8').split(LINE_BREAK))); return 0 }
  if (!values.state || !values.terminal) return 2
  const got = orcaJson<Record<string, unknown>>(['terminal', 'read', '--terminal', values.terminal, '--screen'])
  if (!got.ok) { console.error(got.error); return 5 }
  console.log(classify(screenLines(got.data)))
  return 0
}
process.exitCode = main(process.argv.slice(2))
