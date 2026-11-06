#!/usr/bin/env node
// 스테이징한 수정을 HEAD 가 아닌 앞 커밋에 접어 넣는다. 대화형 rebase 를 쓰지 않는다.
//
// 사용법:
//   node fold_fixup.ts <원인커밋>
//
// 전제: 접어 넣을 수정을 `git add` 로 스테이징해 둔다. 스테이징하지 않은 변경은 건드리지 않고 되살린다.
// 원인커밋은 HEAD 의 조상이어야 한다. HEAD 자신이면 `git commit --amend` 와 같으므로 그렇게 처리한다.
//
// 종료 코드:
//   0  성공
//   1  rebase 가 충돌로 멈췄다. 중단했고 fixup 커밋이 HEAD 에 남아 있다
//   2  사용법 오류 (인자, 스테이징 없음, 조상이 아님, 범위에 머지 커밋)
//   그 밖에는 실패한 git 명령의 종료 코드다
//
// 범위에 머지 커밋이 있으면 rebase 가 그것을 평탄화하므로 시작하기 전에 막는다.
// 해시가 바뀌므로 호출한 쪽은 대응 표의 해시를 다시 읽는다. 이미 push 한 커밋이면 force push 가 필요하다.

import { spawnSync } from 'node:child_process'
import { isMain, write } from './io.ts'

const USAGE = `사용법:
    fold_fixup.ts <원인커밋>

전제: 접어 넣을 수정을 git add 로 스테이징해 둔다. 스테이징하지 않은 변경은 건드리지 않고 되살린다.
종료 코드: 0 성공, 1 rebase 충돌로 중단(fixup 커밋이 HEAD 에 남는다), 2 사용법 오류
`

type Stdio = 'inherit' | 'ignore' | 'pipe'

// git 을 돌린다. stdout 을 읽거나 버리거나 물려준다. stderr 는 늘 물려준다
function git(args: string[], stdout: Stdio = 'inherit', env?: NodeJS.ProcessEnv) {
  const done = spawnSync('git', args, { stdio: ['inherit', stdout, 'inherit'], encoding: 'utf8', env })
  if (done.error) throw done.error
  return { code: done.status ?? 128, stdout: done.stdout ?? '' }
}

export function main(args: string[]): number {
  if (args.length !== 1) {
    write(2, USAGE)
    return 2
  }
  const cause = args[0]

  const found = git(['rev-parse', '--verify', '--quiet', `${cause}^{commit}`], 'pipe')
  if (found.code !== 0) {
    write(2, `커밋을 찾을 수 없다: ${cause}\n`)
    return 2
  }
  // 명령 치환처럼 끝의 줄바꿈을 뗀다
  const target = found.stdout.replace(/\n+$/, '')
  const headResult = git(['rev-parse', 'HEAD'], 'pipe')
  if (headResult.code !== 0) return headResult.code
  const head = headResult.stdout.replace(/\n+$/, '')

  if (git(['diff', '--cached', '--quiet']).code === 0) {
    write(2, '스테이징된 변경이 없다. 접어 넣을 수정을 git add 로 먼저 올린다\n')
    return 2
  }

  if (target === head) return git(['commit', '--amend', '--no-edit']).code

  if (git(['merge-base', '--is-ancestor', target, head]).code !== 0) {
    write(2, `원인 커밋이 HEAD 의 조상이 아니다: ${cause}\n`)
    return 2
  }

  if (git(['rev-list', '--merges', `${target}..HEAD`], 'pipe').stdout.replace(/\n+$/, '') !== '') {
    write(2, `${cause}..HEAD 에 머지 커밋이 있어 접을 수 없다\n`)
    return 2
  }

  const fixup = git([`commit`, `--fixup=${target}`, '--quiet'])
  if (fixup.code !== 0) return fixup.code

  // 접힌 fixup 커밋이 rebase 의 todo 에서 자동으로 대상 밑으로 옮겨진다. 편집기는 열지 않는다
  const base = git(['rev-parse', '--verify', '--quiet', `${target}^`], 'ignore').code === 0 ? [`${target}^`] : ['--root']
  const rebase = git(['rebase', '-i', '--autosquash', '--autostash', ...base], 'ignore', { ...process.env, GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' })
  if (rebase.code !== 0) {
    git(['rebase', '--abort'])
    write(2, 'rebase 가 충돌해 중단했다. fixup 커밋은 HEAD 에 남아 있다. 수정이 겹치는 커밋을 확인한다\n')
    return 1
  }

  write(1, `접었다: ${cause} 의 새 해시는 git log 로 다시 읽는다\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
