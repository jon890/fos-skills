#!/usr/bin/env node
// PR 의 리뷰 댓글과 스레드를 읽는다. 호스트는 git remote 에서 자동으로 찾는다.
//
// usage: node gh-review-list.ts <owner/repo> <PR번호> [--thread <root댓글id>] [--mine]
//
// 호스트 판별은 gh-host.ts 가 소유한다. review-fix 는 같은 일을 scripts/gh_host.py 로 한다.
// --paginate 로 100 건을 넘겨 받는다. per_page 만 두면 넘는 댓글이 조용히 잘린다.
//
// 종료 코드: 0 낸다, 1 인자 오류나 호스트를 못 찾음이나 gh 실패

import { spawnSync } from 'node:child_process'

import { detectHost, HostError, write } from './gh-host.ts'
import { renderComments, type Comment } from './render-comments.ts'
import { isMainModule } from './is-main.ts'

function die(message: string): number {
  write(2, `${message}\n`)
  return 1
}

export function main(argv: string[]): number {
  const [repo, pr] = argv
  if (repo === undefined || repo === '') return die('gh-review-list: owner/repo')
  if (pr === undefined || pr === '') return die('gh-review-list: PR 번호')
  let thread = ''
  let mine = false
  const rest = argv.slice(2)
  while (rest.length) {
    const option = rest[0]
    if (option === '--thread') {
      if (!rest[1]) return die('gh-review-list: root 댓글 id')
      thread = rest[1]
      rest.splice(0, 2)
    } else if (option === '--mine') {
      mine = true
      rest.shift()
    } else {
      return die(`알 수 없는 옵션: ${option}`)
    }
  }

  let host: string
  try {
    host = detectHost()
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    if (error.message) write(2, `${error.message}\n`)
    return die('git remote 에서 호스트를 찾지 못했습니다. GH_HOST 를 지정하세요.')
  }
  const env = { ...process.env, GH_HOST: host }
  let me = ''
  if (mine) {
    const user = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', env, stdio: ['inherit', 'pipe', 'inherit'] })
    if (user.status !== 0) return user.status ?? 1
    me = user.stdout.replace(/\n+$/, '')
  }
  const fetched = spawnSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/comments?per_page=100`], {
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  if (fetched.status !== 0) return 1
  let rows: Comment[]
  try {
    rows = (JSON.parse(fetched.stdout) as Comment[][]).flat()
  } catch {
    return 1
  }
  write(1, renderComments(rows, thread, mine, me))
  return 0
}

const isMain = isMainModule(import.meta.url, import.meta.main)
if (isMain) process.exitCode = main(process.argv.slice(2))
