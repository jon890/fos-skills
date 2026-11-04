// 사용자가 코디네이터 터미널에서 대화 중인지 한 줄로 낸다. 코디네이터가 깨어난 대기를 처리한 뒤 다시 걸지 정할 때 부른다.
// 판정 기준과 기록 위치는 lib/user-active.ts 머리 주석이 소유한다.
//
// 사용법:
//     user-active.ts [--terminal HANDLE]
//
//     --terminal  볼 터미널. 기본은 ORCA_TERMINAL_HANDLE(부른 코디네이터 자신)
//
// 출력(한 줄):
//     USER-ACTIVE <터미널> <초>   마지막 사용자 입력이 그 초 전이고 대화 중이다. 대기를 다시 걸지 않는다
//     USER-IDLE <터미널> <초>     마지막 입력이 대화 중 기준보다 오래됐다. 대기를 다시 건다
//     USER-IDLE <터미널> -        기록이 없다(hook 을 싣지 않은 세션). 대기를 다시 건다
//
// 종료 코드: 0 판정했다, 2 사용법 오류이거나 터미널을 모른다

import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { userActive } from './lib/user-active.ts'

const USAGE = '사용법: user-active.ts [--terminal HANDLE]'

function main(argv: string[]): number {
  let values
  try {
    const options = { terminal: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
  } catch (e) {
    process.stderr.write(`${USAGE}\nuser-active: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const terminal = values.terminal || process.env.ORCA_TERMINAL_HANDLE || ''
  if (!/^term_[\w-]+$/.test(terminal)) {
    process.stderr.write(`${USAGE}\nuser-active: 터미널 handle(term_...)을 --terminal 로 준다\n`)
    return 2
  }
  const { active, ago } = userActive(terminal)
  process.stdout.write(`${active ? 'USER-ACTIVE' : 'USER-IDLE'} ${terminal} ${ago ?? '-'}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
