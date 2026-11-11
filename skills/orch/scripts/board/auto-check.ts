// 자동 진행 직전에 설정, 첫 미완료 표시, 진행 중인 worker·PR, 띄운 기록과 근거를 확인한다.
// 사용법: auto-check.ts <항목 id> [--repo DIR] [--run ID] [--board FILE]
// 출력: AUTO-OK <항목> <번호> <근거>, AUTO-REJECT <항목> <번호 또는 -> <이유>.
// 종료 코드: 0 통과, 1 거절이나 읽기 실패, 2 사용법·설정 오류. 보드와 상태는 쓰지 않는다.
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { expandArgs } from '../lib/args.ts'
import { checkAdvance } from '../lib/auto-advance.ts'
import { ConfigError } from '../lib/config.ts'
import { mainCheckout } from '../lib/git.ts'
import { emit } from '../lib/output.ts'

const USAGE = '사용법: auto-check.ts <항목 id> [--repo DIR] [--run ID] [--board FILE]'
const OPTIONS = { repo: { type: 'string' }, run: { type: 'string' }, board: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const

function main(): number {
  let args
  try { args = parseArgs({ args: expandArgs(process.argv.slice(2), OPTIONS), options: OPTIONS, allowPositionals: true }) }
  catch { process.stderr.write(`${USAGE}\n`); return 2 }
  if (args.values.help) { emit(USAGE); return 0 }
  if (args.positionals.length !== 1) { process.stderr.write(`${USAGE}\n`); return 2 }
  const id = args.positionals[0]
  try {
    const repo = args.values.repo ? resolve(args.values.repo) : mainCheckout(process.cwd())
    const { verdict, step, checks } = checkAdvance(repo, id, args.values)
    emit(verdict.ok ? `AUTO-OK ${id} ${verdict.number} ${verdict.evidence}` : `AUTO-REJECT ${id} ${verdict.number ?? '-'} ${verdict.reason}`)
    if (step) emit(`단계: ${step.text}`)
    for (const row of checks) emit(`근거: ${row.text} ${row.problem ?? '통과'}`)
    if (verdict.ok) emit(`안내: 지시서에 「보드 항목 id: ${id}」 줄을 적고 띄운다`)
    return verdict.ok ? 0 : 1
  } catch (e) {
    process.stderr.write(`auto-check: ${(e as Error).message}\n`)
    return e instanceof ConfigError ? 2 : 1
  }
}

process.exitCode = main()
