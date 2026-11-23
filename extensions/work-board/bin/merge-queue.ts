// 사용법: merge-queue.ts --repo DIR
// orch 가 돌려준 보드용 머지 큐 상태를 stdout 에 JSON 한 줄로 낸다.
// 종료 코드: 0 출력, 1 예기치 못한 오류, 2 사용법 오류

import { parseArgs } from 'node:util'
import { readBoardMergeQueue } from '../../../skills/orch/scripts/lib/board-queries/board-merge-queue.ts'

const USAGE = '사용법: merge-queue.ts --repo DIR'

function main(argv: string[]): number {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }))
  } catch (e) {
    process.stderr.write(`${USAGE}\nmerge-queue: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.repo) {
    process.stderr.write(`${USAGE}\nmerge-queue: --repo 가 필요하다\n`)
    return 2
  }
  const view = readBoardMergeQueue(values.repo)
  process.stdout.write(`${JSON.stringify(view)}\n`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`merge-queue: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  }
}
