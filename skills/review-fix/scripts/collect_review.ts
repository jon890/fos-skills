#!/usr/bin/env node
// PR 의 리뷰를 네 소스에서 모아 낸다.
//
// 사용법:
//   node collect_review.ts <owner> <repo> <PR번호> [--carried-from <PR번호> ...] [--carried-marker 문구]
//
//   node collect_review.ts https://HOST/OWNER/REPO/pull/NUMBER [옵션]
//   node collect_review.ts HOST/OWNER/REPO NUMBER [옵션]
//
//   --carried-from    이전 PR 에서 「다음 PR 에서 반영」 으로 회신한 스레드를 다섯째 소스로 더한다.
//                     PR 번호를 여럿 줄 수 있고, resolve 된 스레드도 낸다
//                     숫자는 모두 이전 PR 번호로 읽으므로 대상 PR 을 먼저 준다
//   --carried-marker  회신에서 찾을 문구. 기본은 「다음 PR」
//
// 종료 코드:
//   0  성공
//   1  GitHub 호출 실패
//   2  사용법 오류
//
// 워크플로 버전에 따라 리뷰가 담기는 위치가 다르다.
// 한 소스만 보면 봇의 구조화 리뷰를 놓친다.
//
// 리뷰 스레드를 함께 내는 이유는 「회신」 단계가 THREAD_ID 로 회신하기 때문이다.
// REST 댓글의 `path` 와 `line` 을 스레드의 것과 대조해 어느 지적에 회신할지 정한다.
//
// `diff_hunk`, `html_url`, `_links`, `reactions` 는 토큰만 차지하므로 빼고 `body` 는 잘라 낸다.
// PR URL 이나 HOST/OWNER/REPO 를 주면 그 호스트만 조회한다.
// `<owner> <repo>` 를 주면 대상과 같은 origin 의 호스트를 먼저 쓰고, 다르면 로그인 호스트에서 찾는다.
// 로그인된 호스트 어디에도 그 저장소가 없으면 현재 디렉터리의 origin 으로 되돌아가고,
// 저장소 밖이면 그 단계에서 실패한다. `gh_host.ts` 가 그때 stderr 로 알린다.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { HostError, resolveHost } from './gh_host.ts'
import { isMain, write } from './io.ts'

const HERE = import.meta.dirname

const REVIEW_JQ = '[.[] | {id, body: .body[0:1000], state, author: .user.login}]'
const COMMENT_JQ = '[.[] | {id, path, line, body: .body[0:500], author: .user.login, in_reply_to_id}]'

const USAGE = `사용법:
    collect_review.ts <owner> <repo> <PR번호> [--carried-from <PR번호> ...] [--carried-marker 문구]
    collect_review.ts https://HOST/OWNER/REPO/pull/NUMBER [옵션]
    collect_review.ts HOST/OWNER/REPO NUMBER [옵션]

종료 코드: 0 성공, 1 GitHub 호출 실패, 2 사용법 오류
`

// 머리말을 내고 명령을 돌린다. 종료 코드가 0 이 아니면 true 다.
//
// 머리말을 먼저 쓴다. 자식 프로세스는 파일 서술자로 직접 쓰므로, 머리말도 동기로 써야 그 출력 앞에 놓인다 (실측)
function run(header: string, argv: string[], env: NodeJS.ProcessEnv): boolean {
  write(1, `${header}\n`)
  const done = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...process.env, ...env } })
  // 실행 파일을 띄우지 못하면 옛 Python 은 오류로 멈췄다. 여기서도 던진다
  if (done.error) throw done.error
  return done.status !== 0
}

// Python str.isdigit 와 같다. 십진 숫자만 센다(위첨자 같은 digit 은 PR 번호가 아니라 다루지 않는다)
const isDigits = (text: string) => /^\p{Nd}+$/u.test(text)

export type Parsed = [owner: string, repo: string, num: string, carried: string[], marker: string | null]

// [owner, repo, num, carried PR 목록, marker] 를 낸다. 틀리면 null
export function parseArgs(args: string[]): Parsed | null {
  let positional: string[] = []
  const carried: string[] = []
  let marker: string | null = null
  let seenCarried = false
  let index = 0
  while (index < args.length) {
    const item = args[index]
    if (item === '--carried-from') {
      seenCarried = true
      index += 1
      while (index < args.length && isDigits(args[index])) {
        carried.push(args[index])
        index += 1
      }
    } else if (item === '--carried-marker') {
      if (index + 1 >= args.length) return null
      marker = args[index + 1]
      index += 2
    } else {
      positional.push(item)
      index += 1
    }
  }
  if (positional.length && positional[0].startsWith('https://')) {
    let target: URL
    try {
      target = new URL(positional[0])
    } catch {
      return null
    }
    const parts = target.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (positional.length === 1 && parts.length === 4 && parts[2] === 'pull' && isDigits(parts[3]) && target.hostname) {
      positional = [`${target.hostname}/${parts[0]}`, parts[1], parts[3]]
    } else {
      return null
    }
  } else if (positional.length === 2) {
    const parts = positional[0].replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length === 3) positional = [`${parts[0]}/${parts[1]}`, parts[2], positional[1]]
  }
  if (positional.length !== 3 || (seenCarried && carried.length === 0)) return null
  return [positional[0], positional[1], positional[2], carried, marker]
}

export function main(args: string[]): number {
  const parsed = parseArgs(args)
  if (parsed === null) {
    write(2, USAGE)
    return 2
  }
  let [owner, repo, num] = parsed
  const [, , , carried, marker] = parsed
  let host: string | undefined
  if (owner.includes('/')) {
    const at = owner.indexOf('/')
    host = owner.slice(0, at)
    owner = owner.slice(at + 1)
  }

  let env: NodeJS.ProcessEnv
  try {
    env = { GH_HOST: resolveHost(owner, repo, host) }
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }

  const node = process.execPath
  const threads = join(HERE, 'review_threads.ts')
  let failed = false

  failed = run('## 1. GitHub Review (요약 리뷰가 담기는 곳)', ['gh', 'api', `repos/${owner}/${repo}/pulls/${num}/reviews`, '--jq', REVIEW_JQ], env) || failed
  failed = run('## 2. 인라인 코드 리뷰 댓글 (diff 라인에 달림)', ['gh', 'api', `repos/${owner}/${repo}/pulls/${num}/comments`, '--jq', COMMENT_JQ], env) || failed
  failed = run('## 3. 일반 PR(issue) 댓글', ['gh', 'pr', 'view', num, '--repo', `${owner}/${repo}`, '--comments'], env) || failed
  failed = run('## 4. 미해결 리뷰 스레드 (「회신」 단계의 대상)', [node, threads, 'list', owner, repo, num], env) || failed
  for (const prior of carried) {
    const extra = marker ? ['--marker', marker] : []
    failed = run(`## 5. 이전 PR #${prior} 에서 「${marker || '다음 PR'}」 로 회신한 스레드`, [node, threads, 'carried', owner, repo, prior, ...extra], env) || failed
  }

  return failed ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
