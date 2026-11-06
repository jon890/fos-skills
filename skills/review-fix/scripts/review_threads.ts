#!/usr/bin/env node
// PR 의 리뷰 스레드를 조회하고, 스레드에 회신하고, resolve 한다.
//
// 사용법:
//   node review_threads.ts list     <owner> <repo> <PR번호>   미해결 스레드만
//   node review_threads.ts list-all <owner> <repo> <PR번호>   resolve 된 것까지
//   node review_threads.ts list --count <owner> <repo> <PR번호>   미해결 스레드 수만 정수로 낸다
//   node review_threads.ts reply    <THREAD_ID> <본문파일>
//   node review_threads.ts reply-batch <map.tsv>   줄마다 `THREAD_ID<탭>본문파일`. 빈 줄과 # 줄은 건너뛴다
//   node review_threads.ts show     <THREAD_ID>   스레드의 전체 본문과 댓글. `list` 의 head 는 120자에서 잘린다
//   node review_threads.ts carried  <owner> <repo> <PR번호> [--marker 문구]   회신에 문구가 든 스레드
//   node review_threads.ts resolve  <THREAD_ID> [<THREAD_ID> ...]
//   node review_threads.ts resolve  -              표준 입력에서 공백이나 줄로 나뉜 THREAD_ID 를 읽는다
//
//   --repo <owner>/<repo>    show, reply, resolve 에서 호스트를 정한다. 어느 자리에 와도 된다
//
// 종료 코드:
//   0  성공
//   1  GitHub 호출 실패. `reply-batch` 는 하나라도 실패하면 1 이다. `--count` 는 스레드가 한 번에 조회하는 수를 넘어도 1 이다
//   2  사용법 오류
//
// 머지 전 확인은 `list --count` 로 한다. 출력에서 `"resolved":false` 를 grep 해 세지 않는다.
// 한 줄 JSON 은 여백이 없어 `"resolved": false` 패턴이 늘 0 으로 나온다 (실측).
// `--count` 의 0 은 미해결 스레드가 없다는 뜻이다. 조회가 잘렸으면 0 으로 내지 않고 실패한다.
//
// 봇의 발견사항은 인라인 댓글이 아니라 리뷰 스레드로 달리는 경우가 많다.
// REST 의 `pulls/<N>/comments` 로는 스레드 ID 를 얻을 수 없어 조회와 회신 모두 GraphQL 로 한다 (실측).
// `path` 와 `line` 을 함께 내므로 REST 댓글과 대조해 어느 지적인지 가릴 수 있다.
// push 뒤 outdated 가 된 스레드는 GitHub 가 `line` 을 비우므로 그때는 `originalLine` 을 `line` 에 담아 낸다.
//
// 회신 본문은 파일로 받는다. 셸에서 본문을 직접 넘기면
// 백틱과 달러가 명령 치환으로 사라진다 (실측).
//
// 여러 ID 를 셸 변수 하나에 담아 `resolve $IDS` 로 넘기지 않는다.
// bash 는 낱말로 나누지만 zsh 는 나누지 않아 ID 전체가 인자 하나로 가고 GraphQL 이 실패한다 (실측).
// `resolve -` 로 표준 입력에서 읽거나, 인자 하나에 공백이 섞여 와도 이 스크립트가 나눈다.
//
// resolve 하지 않으면 "A conversation must be resolved" 보호 규칙이 머지를 막는다.
// 아직 반영하지 않은 스레드는 resolve 하지 않는다. resolve 는 "처리했다"는 표시다.
//
// 호스트는 `gh_host.ts` 가 정한다.
// `list` 와 `list-all` 은 받은 `<owner> <repo>` 를 그대로 넘기므로 현재 디렉터리를 보지 않는다.
// `show`, `reply`, `resolve` 는 THREAD_ID 만 받아 저장소를 알 수 없으므로 `--repo` 로 준다.
// 주지 않으면 현재 디렉터리의 origin 을 보므로, 대상 저장소 안에서 돌려야 한다.
//
// 출력은 옛 Python 명령과 글자 단위로 같다. 객체는 키를 정렬한 여백 없는 JSON 이다(`gh --jq` 가 그렇게 낸다).

import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { HostError, resolveHost } from './gh_host.ts'
import { capture, isMain, write } from './io.ts'
import { normalizeNewlines, PY_SPACE, pyDecode, pyHead, pyInt, pySplitLines, pyStr, pyStrip } from './kit/py.ts'

const HEAD_LEN = 120
const PAGE_SIZE = 100

const LIST_QUERY = `
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$num) {
          reviewThreads(first:${PAGE_SIZE}) {
            totalCount
            nodes { id isResolved isOutdated path line originalLine
                    comments(first:1){ nodes{ author{login} body } } }
          }
        }
      }
    }`

const REPLY_MUTATION = `
      mutation($threadId:ID!, $body:String!) {
        addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}) {
          comment { url }
        }
      }`

const CARRIED_QUERY = `
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$num) {
          reviewThreads(first:${PAGE_SIZE}) {
            totalCount
            nodes { id isResolved path line
                    comments(first:50){ nodes{ author{login} body url } } }
          }
        }
      }
    }`

const DEFAULT_MARKER = '다음 PR'

const SHOW_PAGE_SIZE = 100

const SHOW_QUERY = `
    query($id:ID!) {
      node(id:$id) {
        ... on PullRequestReviewThread {
          id isResolved isOutdated path line originalLine
          comments(first:${SHOW_PAGE_SIZE}){ totalCount nodes{ author{login} body url } }
        }
      }
    }`

const RESOLVE_MUTATION = `
        mutation($threadId:ID!) {
          resolveReviewThread(input:{threadId:$threadId}) {
            thread { id isResolved }
          }
        }`

const USAGE = `사용법:
    review_threads.ts list     <owner> <repo> <PR번호>   미해결 스레드만
    review_threads.ts list-all <owner> <repo> <PR번호>   resolve 된 것까지
    review_threads.ts list --count <owner> <repo> <PR번호>   미해결 스레드 수만 정수로 낸다
    review_threads.ts reply    <THREAD_ID> <본문파일>
    review_threads.ts reply-batch <map.tsv>   줄마다 \`THREAD_ID<탭>본문파일\`. 빈 줄과 # 줄은 건너뛴다
    review_threads.ts show     <THREAD_ID>   스레드의 전체 본문과 댓글
    review_threads.ts carried  <owner> <repo> <PR번호> [--marker 문구]   회신에 문구가 든 스레드
    review_threads.ts resolve  <THREAD_ID> [<THREAD_ID> ...]
    review_threads.ts resolve  -              표준 입력에서 공백이나 줄로 나뉜 THREAD_ID 를 읽는다

    --repo <owner>/<repo>    show, reply, resolve 에서 호스트를 정한다. 어느 자리에 와도 된다

종료 코드: 0 성공, 1 GitHub 호출 실패, 2 사용법 오류
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

// gh 를 돌려 [종료 코드, stdout, stderr] 를 낸다
function gh(args: string[], env: Record<string, string> = {}): [number, string, string] {
  const done = capture(['gh', ...args], { ...process.env, ...env })
  return [done.code, done.stdout, done.stderr]
}

function usage(code = 2): number {
  write(2, USAGE)
  return code
}

function lstrip(text: string): string {
  return text.replace(new RegExp(`^${PY_SPACE}+`), '')
}

function rstrip(text: string): string {
  return text.replace(new RegExp(`${PY_SPACE}+$`), '')
}

// pathlib.Path(text) 의 문자열. 중복 슬래시와 `.` 조각을 접고 `..` 는 그대로 둔다
function pyPath(text: string): string {
  const parts = text.split('/').filter((part) => part !== '' && part !== '.')
  return (text.startsWith('/') ? '/' : '') + parts.join('/') || '.'
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

// gh --jq 와 같은 형식으로 낸다.
//
// 문자열은 따옴표 없이, 객체는 키를 정렬한 여백 없는 JSON 이다.
// 키를 정렬하는 이유는 `gh --jq` 가 그렇게 내기 때문이다 (실측).
// 옮기기 전 출력과 글자 단위로 같게 두려고 맞춘다.
function emit(value: string | Record<string, unknown>): void {
  if (typeof value === 'string') {
    write(1, `${value}\n`)
    return
  }
  const sorted = Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key] === undefined ? null : value[key]]))
  write(1, `${JSON.stringify(sorted)}\n`)
}

// push 뒤 outdated 가 된 스레드는 `line` 이 비므로 `originalLine` 으로 대신한다
function threadLine(node: Json): unknown {
  return node.line ?? node.originalLine ?? null
}

function failure(err: string, out: string): void {
  write(2, `${pyStrip(err) || pyStrip(out)}\n`)
}

function cmdList(host: string, owner: string, repo: string, num: string, onlyUnresolved: boolean, countOnly = false): number {
  const [code, out, err] = gh(['api', 'graphql', '-f', `query=${LIST_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `num=${num}`], { GH_HOST: host })
  if (code !== 0) {
    failure(err, out)
    return 1
  }

  const threads = JSON.parse(out).data.repository.pullRequest.reviewThreads
  const total = threads.totalCount
  if (countOnly) {
    if (total > PAGE_SIZE) {
      // 잘린 조회의 수는 머지 판단에 쓸 수 없다. 0 으로 보일 수도 있어 실패로 낸다
      write(2, `스레드 ${total}건 중 ${PAGE_SIZE}건만 조회해 수를 세지 못했다\n`)
      return 1
    }
    const nodes = threads.nodes.filter((n: Json) => !(onlyUnresolved && n.isResolved))
    write(1, `${nodes.length}\n`)
    return 0
  }
  if (total > PAGE_SIZE) emit(`경고: 스레드 ${total}건 중 ${PAGE_SIZE}건만 조회했다`)

  for (const node of threads.nodes) {
    if (onlyUnresolved && node.isResolved) continue
    const first = node.comments.nodes[0] ?? {}
    emit({
      id: node.id,
      resolved: node.isResolved,
      outdated: node.isOutdated,
      path: node.path,
      line: threadLine(node),
      author: first.author?.login ?? null,
      head: pyHead(first.body || '', HEAD_LEN),
    })
  }
  return 0
}

// 스레드 하나의 전체 본문과 댓글을 낸다. `list` 의 head 는 HEAD_LEN 자에서 잘린다.
//
// 첫 줄은 `list` 와 같은 키의 JSON 이고 head 만 없다. 그 뒤에 댓글마다 머리줄과 본문 전체를 낸다.
// 본문은 줄바꿈이 살아 있어야 읽히므로 JSON 에 넣지 않는다.
function cmdShow(host: string, threadId: string): number {
  const [code, out, err] = gh(['api', 'graphql', '-f', `query=${SHOW_QUERY}`, '-f', `id=${threadId}`], { GH_HOST: host })
  if (code !== 0) {
    failure(err, out)
    return 1
  }
  const node = (JSON.parse(out).data ?? {}).node
  if (!node || !('comments' in node)) {
    write(2, `리뷰 스레드가 아니거나 찾을 수 없다: ${threadId}\n`)
    return 1
  }
  const comments = node.comments
  emit({
    id: node.id,
    resolved: node.isResolved,
    outdated: node.isOutdated,
    path: node.path,
    line: threadLine(node),
    comments: comments.totalCount,
  })
  comments.nodes.forEach((comment: Json, index: number) => {
    const author = comment.author?.login ?? null
    write(1, `${rstrip(`\n--- ${index + 1}. ${pyStr(author)} ${comment.url || ''}`)}\n`)
    write(1, `${comment.body || ''}\n`)
  })
  if (comments.totalCount > SHOW_PAGE_SIZE) write(2, `\n경고: 댓글 ${comments.totalCount}건 중 ${SHOW_PAGE_SIZE}건만 조회했다\n`)
  return 0
}

function cmdReply(host: string, threadId: string, bodyFile: string): number {
  const path = pyPath(bodyFile)
  if (!isFile(path) || !readable(path)) {
    write(2, `본문 파일을 읽을 수 없다: ${bodyFile}\n`)
    return 2
  }
  const [code, out, err] = gh(
    ['api', 'graphql', '-f', `query=${REPLY_MUTATION}`, '-f', `threadId=${threadId}`, '-F', `body=@${path}`, '--jq', '.data.addPullRequestReviewThreadReply.comment.url'],
    { GH_HOST: host },
  )
  if (code !== 0) {
    failure(err, out)
    return 1
  }
  write(1, `${pyStrip(out)}\n`)
  return 0
}

type Row = [number, string | null, string]

// `THREAD_ID<탭>본문파일` 줄을 [줄 번호, id, 파일] 로 푼다. 빈 줄과 `#` 줄은 건너뛴다.
//
// 탭이 없는 줄은 [줄 번호, null, 원문] 으로 내고 호출부가 실패로 센다.
export function parseBatchMap(text: string): Row[] {
  const rows: Row[] = []
  pySplitLines(text).forEach((line, index) => {
    const number = index + 1
    if (!pyStrip(line) || lstrip(line).startsWith('#')) return
    const parts = line.split('\t')
    if (parts.length !== 2 || !pyStrip(parts[0]) || !pyStrip(parts[1])) rows.push([number, null, line])
    else rows.push([number, pyStrip(parts[0]), pyStrip(parts[1])])
  })
  return rows
}

// map.tsv 의 모든 줄을 회신한다. 실패해도 나머지를 계속 돌리고 끝에 실패 목록을 낸다
function cmdReplyBatch(host: string, mapFile: string): number {
  let bytes: Uint8Array
  try {
    bytes = readFileSync(pyPath(mapFile))
  } catch (error) {
    write(2, `map 파일을 읽을 수 없다: ${mapFile} (${(error as Error).message})\n`)
    return 2
  }
  // UTF-8 이 아닌 바이트는 읽기 실패가 아니다. 옛 Python 처럼 오류로 멈춘다(종료 코드 1)
  const text = normalizeNewlines(pyDecode(bytes))
  const rows = parseBatchMap(text)
  if (rows.length === 0) {
    write(2, `회신할 줄이 없다: ${mapFile}\n`)
    return 2
  }
  const base = dirname(realpathSync(pyPath(mapFile)))
  const failed: string[] = []
  for (const [number, tid, body] of rows) {
    if (tid === null) {
      write(2, `줄 ${number}: \`THREAD_ID<탭>본문파일\` 꼴이 아니다: ${body}\n`)
      failed.push(`줄 ${number}`)
      continue
    }
    const bodyPath = pyPath(body).startsWith('/') ? pyPath(body) : pyPath(`${base}/${body}`)
    write(1, `[${tid}] `)
    if (cmdReply(host, tid, bodyPath) !== 0) failed.push(`줄 ${number} ${tid}`)
  }
  if (failed.length) {
    write(2, `회신 실패 ${failed.length}/${rows.length}건: ${failed.join(', ')}\n`)
    return 1
  }
  return 0
}

// 이전 PR 의 스레드 중 첫 댓글 뒤의 회신에 marker 가 든 것을 낸다. resolve 된 것도 낸다
function cmdCarried(host: string, owner: string, repo: string, num: string, marker: string): number {
  const [code, out, err] = gh(['api', 'graphql', '-f', `query=${CARRIED_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `num=${num}`], { GH_HOST: host })
  if (code !== 0) {
    failure(err, out)
    return 1
  }
  const threads = JSON.parse(out).data.repository.pullRequest.reviewThreads
  if (threads.totalCount > PAGE_SIZE) emit(`경고: 스레드 ${threads.totalCount}건 중 ${PAGE_SIZE}건만 조회했다`)
  for (const node of threads.nodes) {
    const comments: Json[] = node.comments.nodes
    const hits = comments.slice(1).filter((c) => (c.body || '').includes(marker))
    if (hits.length === 0) continue
    const first = comments[0]
    emit({
      pr: pyInt(num),
      id: node.id,
      resolved: node.isResolved,
      path: node.path,
      line: node.line,
      author: first.author?.login ?? null,
      head: pyHead(first.body || '', HEAD_LEN),
      reply_url: hits.at(-1).url ?? null,
    })
  }
  return 0
}

let stdinText: string | null = null

function readStdin(): string {
  if (stdinText !== null) return ''
  let bytes: Uint8Array
  try {
    bytes = readFileSync(0)
  } catch {
    // 표준 입력이 닫혔거나 비어 있다
    bytes = new Uint8Array()
  }
  stdinText = normalizeNewlines(pyDecode(bytes))
  return stdinText
}

// resolve 인자를 THREAD_ID 목록으로 편다.
//
// `-` 는 표준 입력의 내용으로 바꾼다. 인자 안의 공백과 줄바꿈으로도 나눈다.
// zsh 는 따옴표 없는 변수를 낱말로 나누지 않아 `resolve $IDS` 가 인자 하나로 오기 때문이다.
// THREAD_ID 에는 공백이 없으므로 나눠도 잃는 것이 없다.
export function splitThreadIds(args: string[], stdin: () => string = readStdin): string[] {
  const ids: string[] = []
  for (const arg of args) {
    const text = arg === '-' ? stdin() : arg
    ids.push(...text.split(new RegExp(`${PY_SPACE}+`)).filter(Boolean))
  }
  return ids
}

function cmdResolve(host: string, threadIds: string[]): number {
  let failed = 0
  for (const tid of threadIds) {
    const [code, out, err] = gh(
      ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `threadId=${tid}`, '--jq', '.data.resolveReviewThread.thread | "\\(.id) resolved=\\(.isResolved)"'],
      { GH_HOST: host },
    )
    if (code !== 0) {
      failure(err, out)
      failed = 1
      continue
    }
    write(1, `${pyStrip(out)}\n`)
  }
  return failed
}

class BadRepo extends Error {}

// args 에서 `--repo <owner>/<repo>` 를 떼어내고 나머지를 그대로 돌려준다.
//
// 값에 `/` 가 없으면 `BadRepo` 를 낸다.
// 조용히 버리면 현재 디렉터리로 되돌아가 엉뚱한 호스트를 쓰게 된다.
export function takeRepo(args: string[]): { rest: string[]; owner?: string; repo?: string } {
  const rest: string[] = []
  let owner: string | undefined
  let repo: string | undefined
  let index = 0
  while (index < args.length) {
    const item = args[index]
    let value: string | undefined
    if (item === '--repo' && index + 1 < args.length) {
      value = args[index + 1]
      index += 2
    } else if (item.startsWith('--repo=')) {
      value = item.slice('--repo='.length)
      index += 1
    } else {
      rest.push(item)
      index += 1
    }
    if (value !== undefined) {
      if (!value.includes('/')) throw new BadRepo(`--repo 는 <owner>/<repo> 꼴이어야 한다: ${value}`)
      const at = value.indexOf('/')
      owner = value.slice(0, at)
      repo = value.slice(at + 1)
    }
  }
  return { rest, owner, repo }
}

export function main(argv: string[]): number {
  const countOnly = argv.includes('--count')
  let args = argv.filter((a) => a !== '--count')
  let givenOwner: string | undefined
  let givenRepo: string | undefined
  try {
    const taken = takeRepo(args)
    args = taken.rest
    givenOwner = taken.owner
    givenRepo = taken.repo
  } catch (error) {
    if (!(error instanceof BadRepo)) throw error
    write(2, `${error.message}\n`)
    return 2
  }
  let marker = DEFAULT_MARKER
  const at = args.indexOf('--marker')
  if (at >= 0) {
    if (at + 1 >= args.length) return usage()
    marker = args[at + 1]
    args.splice(at, 2)
  }
  if (args.length < 1) return usage()
  const [cmd, ...rest] = args

  if ((cmd === 'list' || cmd === 'list-all' || cmd === 'carried') && rest.length === 3) {
    givenOwner = rest[0]
    givenRepo = rest[1]
  }

  let host: string
  try {
    host = resolveHost(givenOwner, givenRepo)
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }

  if (cmd === 'list' || cmd === 'list-all') {
    if (rest.length !== 3) return usage()
    return cmdList(host, rest[0], rest[1], rest[2], cmd === 'list', countOnly)
  }
  if (cmd === 'show') return rest.length === 1 ? cmdShow(host, rest[0]) : usage()
  if (cmd === 'reply') return rest.length === 2 ? cmdReply(host, rest[0], rest[1]) : usage()
  if (cmd === 'reply-batch') return rest.length === 1 ? cmdReplyBatch(host, rest[0]) : usage()
  if (cmd === 'carried') return rest.length === 3 ? cmdCarried(host, rest[0], rest[1], rest[2], marker) : usage()
  if (cmd === 'resolve') {
    const ids = splitThreadIds(rest)
    return ids.length ? cmdResolve(host, ids) : usage()
  }
  return usage()
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
