#!/usr/bin/env node
// 작업 트리를 대상 PR 의 head 브랜치로 맞춘다.
//
// 사용법:
//   node checkout_pr.ts <PR번호>
//
// 종료 코드:
//   0  현재 브랜치가 PR 의 head 브랜치다
//   1  작업 트리가 dirty 하다. 다른 작업 중일 수 있으므로 체크아웃하지 않는다
//   2  사용법이 틀렸다
//   3  PR 의 head 브랜치를 읽지 못했다
//
// 정렬하지 않으면 뒤 단계가 다른 브랜치의 파일을 고친다.
// conflict 여부와 무관하게 항상 수행한다.
//
// 진입 시점의 현재 브랜치가 base 브랜치인 경우가 정상이다.
// 구현 스킬이 워크트리를 정리하면 거기로 돌아오기 때문이다 (실측).

import { capture, isMain, write } from './io.ts'
import { pyStrip } from './kit/py.ts'

const USAGE = `사용법:
    checkout_pr.ts <PR번호>

종료 코드:
    0  현재 브랜치가 PR 의 head 브랜치다
    1  작업 트리가 dirty 하다. 다른 작업 중일 수 있으므로 체크아웃하지 않는다
    2  사용법이 틀렸다
    3  PR 의 head 브랜치를 읽지 못했다
`

const git = (...args: string[]) => capture(['git', ...args])

export function main(args: string[]): number {
  if (args.length !== 1) {
    write(2, USAGE)
    return 2
  }
  const num = args[0]

  if (pyStrip(git('status', '--porcelain').stdout)) {
    write(2, '작업 트리가 dirty 하다. 사용자에게 확인받는다 (stash·커밋·중단).\n')
    write(2, git('status', '--short').stdout)
    return 1
  }

  const view = capture(['gh', 'pr', 'view', num, '--json', 'headRefName', '--jq', '.headRefName'])
  const headRef = pyStrip(view.stdout)
  if (view.code !== 0 || !headRef) {
    write(2, `PR #${num} 의 head 브랜치를 읽지 못했다\n`)
    if (pyStrip(view.stderr)) write(2, `${pyStrip(view.stderr)}\n`)
    return 3
  }

  let current = pyStrip(git('branch', '--show-current').stdout)
  if (current !== headRef) {
    const out = capture(['gh', 'pr', 'checkout', num])
    if (out.code !== 0) {
      write(2, `${pyStrip(out.stderr)}\n`)
      return 3
    }
    current = pyStrip(git('branch', '--show-current').stdout)
  }

  write(1, `${current}\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
