// 스테이징된 변경 조각을 scripts/skill_changes.ts 의 같은 검사기로 점검하고, 형식이 틀리면 커밋을 막는다.
// 작업 트리 파일이 아니라 인덱스에 스테이징된 blob 을 읽으므로 커밋될 내용과 검사 내용이 같다.
// 변경 조각이 없으면 검사 없이 통과한다.
//
// 종료 코드: 0 조각이 없거나 형식이 맞아 커밋한다, 1 조각 형식이 틀리거나 인덱스를 읽지 못해 막는다
// 설치: node scripts/install-hooks.ts

import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { checkFragment } from '../scripts/skill_changes.ts'

const CHANGE_FRAGMENT = /(?:^|\/)[^/]+\/changes\/[^/]+\.md$/

export function main(): number {
  const staged = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'], { encoding: 'utf8' })
  if (staged.error || staged.status !== 0) {
    process.stderr.write(`pre-commit: 스테이징된 파일을 읽지 못했다. ${staged.stderr?.trim() ?? staged.error?.message ?? ''}\n`)
    return 1
  }

  const fragments = staged.stdout.split('\0').filter((path) => path && CHANGE_FRAGMENT.test(path))
  if (fragments.length === 0) return 0

  const problems: string[] = []
  for (const path of fragments) {
    const blob = spawnSync('git', ['show', `:${path}`], { encoding: 'utf8' })
    if (blob.error || blob.status !== 0) {
      problems.push(`${path}: 스테이징된 내용을 읽지 못했다${blob.stderr?.trim() ? ` (${blob.stderr.trim()})` : ''}`)
      continue
    }
    problems.push(...checkFragment(basename(path), blob.stdout).map((problem) => `${path}: ${problem}`))
  }

  if (problems.length === 0) return 0
  process.stderr.write(`${problems.join('\n')}\n`)
  process.stderr.write('변경 조각 형식이 맞지 않아 커밋하지 않았다. 조각을 고쳐 스테이징한 뒤 다시 커밋한다.\n')
  return 1
}
