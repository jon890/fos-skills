// orch 작업 폴더의 경로를 셸과 문서에 이름으로 낸다. 경로 규칙은 lib/paths.ts 가 소유한다.
//
// 사용법:
//     orch_paths.ts [--repo DIR] [--ensure] NAME
//     orch_paths.ts [--repo DIR] check
//     NAME 은 lib/paths.ts 의 NAMES(overlay, config, specs, queue, state, heavy-slot, hooks, hooks-state, bin)나
//     root, board 다. 절대경로 한 줄을 낸다. --repo 의 기본은 현재 디렉터리다.
//     board 는 work-board 의 기본 보드 위치(lib/paths.ts 의 boardPath)다.
//     --ensure  폴더를 만들고 git 이 루트를 무시하게 한다. 파일 이름이면 그 부모 폴더를 만든다.
//               옛 구조가 남아 있으면 만들지 않고 종료 코드 2 다. 빈 새 폴더에서 조용히 시작하지 않게 한다
//     check     옛 구조가 남아 있으면 옮기는 명령을 알리고 종료 코드 2 다. 셸 스크립트가 시작할 때 부른다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).
//
// 종료 코드: 0 냈다, 2 사용법 오류이거나 옛 구조가 남아 있다(check, --ensure)

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { boardPath, ensure, ensureIgnored, NAMES, orchDir, pathOf, requireMigrated } from './lib/paths.ts'

const CHOICES = ['root', 'board', 'check', ...Object.keys(NAMES)]
const USAGE = `사용법: orch_paths.ts [--repo DIR] [--ensure] {${CHOICES.join(',')}}`

const OPTIONS = {
  repo: { type: 'string' },
  ensure: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function main(argv: string[]): number {
  let values: { repo?: string; ensure?: boolean; help?: boolean }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({ args: expandArgs(argv, OPTIONS, ['repo']), options: OPTIONS, allowPositionals: true }))
  } catch (e) {
    process.stderr.write(`${USAGE}\norch_paths: error: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (positionals.length !== 1 || !CHOICES.includes(positionals[0])) {
    const given = positionals.length === 0 ? '이름이 없다' : `모르는 이름: ${positionals.join(' ')}`
    process.stderr.write(`${USAGE}\norch_paths: error: ${given}. ${CHOICES.join(', ')} 중 하나다\n`)
    return 2
  }
  const name = positionals[0]
  const repo = resolve(values.repo ?? '.')
  if (name === 'check') return requireMigrated(repo, 'orch_paths', null) ? 0 : 2
  if (values.ensure && !requireMigrated(repo, 'orch_paths', null)) return 2
  if (name === 'board') {
    process.stdout.write(`${boardPath(repo)}\n`)
  } else if (name === 'root') {
    const root = orchDir(repo)
    if (values.ensure) {
      mkdirSync(root, { recursive: true })
      ensureIgnored(repo)
    }
    process.stdout.write(`${root}\n`)
  } else {
    process.stdout.write(`${values.ensure ? ensure(name, repo) : pathOf(name, repo)}\n`)
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
