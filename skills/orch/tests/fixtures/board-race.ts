// 실제 board.ts 앞에서 읽기 뒤의 글 수정을 재현한다. 명령 인자도 남겨 재시도와 순서를 확인한다.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function racingBoard(dir: string, mode: 'once' | 'always' | 'error' = 'once'): string {
  const file = join(dir, `board-race-${mode}.ts`)
  const boardModule = new URL('../../../../extensions/work-board/bin/board.ts', import.meta.url).href
  writeFileSync(file, `import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const log = ${JSON.stringify(file + '.log')}
const before = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').map(JSON.parse) : []
appendFileSync(log, JSON.stringify(args) + '\\n')
if (args[0] === 'set' && args.includes('--detail')) {
  const writes = before.filter(a => a[0] === 'set' && a.includes('--detail')).length
  if (${JSON.stringify(mode)} === 'error') { process.stderr.write('일반 쓰기 실패\\n'); process.exit(1) }
  if (${JSON.stringify(mode)} === 'always' || writes === 0) {
    const file = args[args.indexOf('--file') + 1]
    const board = JSON.parse(readFileSync(file, 'utf8'))
    const rows = Array.isArray(board.items) ? board.items : Object.values(board.items)
    const item = rows.find(row => row.id === args[1])
    const line = item.details[0]
    const text = '1. 사용자가 고친 글 ' + writes
    item.details[0] = typeof line === 'string' ? text : { ...line, text }
    writeFileSync(file, JSON.stringify(board))
  }
}
const done = spawnSync(process.execPath, [fileURLToPath(${JSON.stringify(boardModule)}), ...args], { stdio: 'inherit' })
process.exitCode = done.status ?? 1
`)
  return file
}
