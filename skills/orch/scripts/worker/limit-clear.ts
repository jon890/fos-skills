// 해제를 확인한 제공자의 한도 확인 알림을 이 Run에서 끝낸다.
// 사용법: orch worker limit-clear <제공자> [--run ID]
// 짧은 출력: LIMIT-CLEARED <제공자>. 종료 코드: 0 성공, 1 저장 오류, 2 사용법 오류.
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { clearLimitCheck } from '../lib/worker-limited.ts'

export function main(args: string[]): number {
  try {
    const options = { run: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const
    const { values, positionals } = parseArgs({ args: expandArgs(args, options), allowPositionals: true, options })
    if (values.help) { console.log('사용법: orch worker limit-clear <제공자> [--run ID]'); return 0 }
    if (!values.run || positionals.length !== 1 || !positionals[0].trim()) return 2
    clearLimitCheck(values.run, positionals[0])
    console.log(`LIMIT-CLEARED ${positionals[0]}`)
    return 0
  } catch (error) {
    console.error(`limit-clear: ${(error as Error).message}`)
    return error instanceof TypeError ? 2 : 1
  }
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2))
