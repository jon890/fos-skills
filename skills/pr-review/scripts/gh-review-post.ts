#!/usr/bin/env node
// 인라인 리뷰를 검증한 뒤 등록한다.
//
// usage: node gh-review-post.ts <owner/repo> <PR번호> <파일경로> <줄번호> <본문.md> <핵심낱말>...
//   reply 모드: gh-review-post.ts --reply <owner/repo> <PR번호> <댓글id> <본문.md> <핵심낱말>...
//   요약 모드: gh-review-post.ts --summary <owner/repo> <PR번호> <본문.md> <핵심낱말>...
//   묶음 모드: gh-review-post.ts --batch <owner/repo> <PR번호> <요약.md> <핵심낱말>... -- <파일경로>:<줄번호>:<본문.md>...
//     요약과 인라인 여러 건을 리뷰 하나로 등록한다. `--` 뒤에 인라인을 하나 이상 적는다.
//     핵심 낱말은 `--` 앞에만 둔다. `--` 뒤의 인자는 모두 인라인으로 읽어, 낱말을 두면 줄 번호 오류로 끝난다.
//     낱말은 요약과 인라인 본문을 합친 것에서 찾으므로 인라인에만 있는 낱말도 통과한다.
//   수정 모드: gh-review-post.ts --edit <owner/repo> <PR번호> <댓글id> <본문.md> <핵심낱말>...
//     이미 등록한 인라인 리뷰의 본문을 바꾼다. 검증은 인라인 리뷰와 같다.
//
// 인라인 리뷰의 첫 줄은 `🟠 **P2 높음**` 처럼 색 원과 등급이어야 한다. 표기는 references/grading.md 가 소유한다.
// 요약의 첫 줄은 `## 코드 리뷰` 로 시작해야 한다.
// 인라인 리뷰와 요약에는 AI 가 작성했다는 안내를 본문 끝에 붙인다. 이미 있으면 다시 붙이지 않는다.
//
// 핵심 낱말은 하나 이상 필수다. 그 리뷰에만 있는 문구를 넣는다.
// 등급 접두사만 보면 접두사가 같은 옛 payload 가 그대로 통과한다.
// 단건과 묶음 인라인은 PR head 의 새 파일 쪽 diff 범위에 있는 줄인지 등록 전에 확인한다.
// DRY_RUN=1 도 같은 검사를 하며 등록하지 않는다. 이때도 GitHub 조회를 위한 네트워크와 gh 인증이 필요하다.
// gh api --paginate --slurp 를 지원하는 gh 를 쓴다. patch 가 없는 파일은 파일 단위 댓글을 안내하며 거절한다.
//
// 호스트는 git remote 에서 자동으로 찾는다. GH_HOST 로 덮어쓸 수 있다.
// payload 는 매번 새 임시 파일에 쓰고, 등록 직전에 본문을 검증한다.
//
// 종료 코드: 0 등록했다(또는 DRY_RUN 검증을 통과했다), 1 인자 오류·본문/줄 위치 검증 거부·등록 뒤 줄에 붙은 인라인이 모자람,
//   그 밖에는 gh 가 낸 코드

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectHost, HostError, write } from './gh-host.ts'
import { PY_SPACE, pyInt, pyJson, pyReadText, pyStr } from './kit/py.ts'
import { isMainModule } from './is-main.ts'

const GRADE_RE = /^(🔴 \*\*P1 치명|🟠 \*\*P2 높음|🟡 \*\*P3 보통|🔵 \*\*P4 낮음|⚪ \*\*P5 참고)\*\*$/
const AI_NOTICE = '🤖 이 리뷰는 AI 가 작성했고, 등록 전에 사람이 확인했습니다.'
// 옛 셸의 grep -E `\b` 는 UTF-8 로케일에서 한글도 낱말 글자로 본다. 그래서 `@claude가` 는 토큰 뒤에 낱말이 이어진 것이다
const BOT_TOKEN = /(^|[^`])(\/review|@claude|@github-actions|@dependabot)(?![\p{L}\p{N}_])/u
const RSTRIP = new RegExp(`${PY_SPACE}+$`)
const INT = new RegExp(`^${PY_SPACE}*([+-]?)(\\p{Nd}+)${PY_SPACE}*$`, 'u')

// Python int(str). 부호와 앞뒤 공백을 받고 정수가 아니면 던진다
function pyIntOf(text: string): number {
  const m = INT.exec(text)
  if (!m) throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(text)}`)
  return (m[1] === '-' ? -1 : 1) * pyInt(m[2])
}

type Mode = 'review' | 'reply' | 'summary' | 'batch' | 'edit'

class Exit extends Error {
  code: number
  constructor(code: number) {
    super(`종료 ${code}`)
    this.code = code
  }
}

function die(message: string): never {
  write(2, `${message}\n`)
  throw new Exit(1)
}

const firstLine = (text: string) => text.split('\n')[0]
const nonEmpty = (path: string) => {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}
const rstrip = (text: string) => text.replace(RSTRIP, '')

function gh(host: string, args: string[], capture = true): string {
  const done = spawnSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_HOST: host }, maxBuffer: 256 * 1024 * 1024, stdio: ['inherit', 'pipe', 'inherit'] })
  if (done.status !== 0) throw new Exit(done.status ?? 1)
  return capture ? done.stdout.replace(/\n+$/, '') : done.stdout
}

// 등록한 인라인이 모두 줄에 붙었는지 확인한다.
// reviews/{id}/comments 는 줄에 붙은 댓글도 line 을 null 로 준다(실측). 판정에 쓰지 않고
// pulls/{N}/comments 에서 pull_request_review_id 로 골라 path:line 을 본다.
// 줄이 diff 에 없어 line 이 null 로 붙은 댓글은 이 목록에서 빠지므로 수가 모자라면 실패한다.
function verifyInline(host: string, repo: string, pr: string, reviewId: string, expected: number): void {
  const jq = `.[] | select(.pull_request_review_id == ${reviewId} and .line != null)\n              | "  댓글 \\(.id)  \\(.path):\\(.line)  첫 줄: \\(.body | split("\\n")[0])"`
  const found = gh(host, ['api', '--paginate', `repos/${repo}/pulls/${pr}/comments`, '--jq', jq])
  if (found !== '') write(1, `${found}\n`)
  const count = found.split('\n').filter((line) => line !== '').length
  if (count !== expected) {
    write(2, `경고: 인라인 ${expected}건을 등록했지만 줄에 붙은 것은 ${count}건입니다. 줄이 diff 에 없을 수 있습니다.\n`)
    throw new Exit(1)
  }
}

function need(value: string | undefined, label: string): string {
  if (value === undefined || value === '') die(`gh-review-post: ${label}`)
  return value
}

function parseLine(value: string): number {
  try {
    return pyIntOf(value)
  } catch (error) {
    die(`ValueError: ${(error as Error).message}`)
  }
}

// patch 의 새 파일 쪽 범위에는 추가한 줄과 앞뒤 문맥 줄이 포함된다.
function validateInlineLocations(host: string, repo: string, pr: string, locations: { path: string; line: number }[]): void {
  const pages: { filename: string; patch?: string }[][] = JSON.parse(
    gh(host, ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/files?per_page=100`]),
  )
  const files = pages.flat()
  for (const location of locations) {
    const file = files.find((entry) => entry.filename === location.path)
    if (!file) die(`PR 의 변경 파일에 없습니다: ${location.path}:${location.line} — 새 파일 쪽 경로를 확인하세요.`)
    if (!file.patch) {
      die(`diff patch 가 없어 인라인 위치를 확인할 수 없습니다: ${location.path}:${location.line} — GitHub 화면에서 파일 단위 댓글로 남기세요.`)
    }
    const ranges = [...file.patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    const inside = ranges.some((match) => {
      const start = Number(match[1])
      const count = match[2] === undefined ? 1 : Number(match[2])
      return location.line >= start && location.line < start + count
    })
    if (!Number.isSafeInteger(location.line) || location.line < 1 || !inside) {
      die(`인라인 위치를 확인할 수 없습니다: ${location.path}:${location.line} — PR head 의 새 파일 쪽 diff 범위에 있는 줄을 지정하세요.`)
    }
  }
}

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  const args = [...argv]
  let mode: Mode = 'review'
  if (args[0] === '--reply') (mode = 'reply'), args.shift()
  if (args[0] === '--summary') (mode = 'summary'), args.shift()
  if (args[0] === '--batch') (mode = 'batch'), args.shift()
  if (args[0] === '--edit') (mode = 'edit'), args.shift()

  let repo: string, pr: string, bodyFile: string
  let filePath = ''
  let line = ''
  let commentId = ''
  if (mode === 'review') {
    repo = need(args[0], 'owner/repo')
    pr = need(args[1], 'PR 번호')
    filePath = need(args[2], '파일 경로')
    line = need(args[3], '줄 번호')
    bodyFile = need(args[4], '본문 파일')
    args.splice(0, 5)
  } else if (mode === 'summary' || mode === 'batch') {
    repo = need(args[0], 'owner/repo')
    pr = need(args[1], 'PR 번호')
    bodyFile = need(args[2], '본문 파일')
    args.splice(0, 3)
  } else {
    repo = need(args[0], 'owner/repo')
    pr = need(args[1], 'PR 번호')
    commentId = need(args[2], '댓글 id')
    bodyFile = need(args[3], '본문 파일')
    args.splice(0, 4)
  }
  const keywords: string[] = []
  let inlines: string[] = []
  while (args.length) {
    if (mode === 'batch' && args[0] === '--') {
      inlines = args.slice(1)
      break
    }
    keywords.push(args.shift() as string)
  }
  if (keywords.length < 1) die('핵심 낱말을 하나 이상 넘기세요. 그 리뷰에만 있는 문구여야 옛 본문을 거릅니다.')

  if (!nonEmpty(bodyFile)) die(`본문 파일이 비어 있습니다: ${bodyFile}`)
  let host: string
  try {
    host = detectHost(env)
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    if (error.message) write(2, `${error.message}\n`)
    return die('git remote 에서 호스트를 찾지 못했습니다. GH_HOST 를 지정하세요.')
  }

  // 본문 검증 — 옛 payload 가 등록되는 사고를 막는 마지막 관문
  const read = (path: string) => readFileSync(path, 'utf8')
  let body = read(bodyFile)
  if (mode === 'batch') {
    if (inlines.length < 1) die("묶음 모드는 '--' 뒤에 <파일경로>:<줄번호>:<본문.md> 를 하나 이상 받습니다.")
    for (const spec of inlines) {
      const inlineFile = spec.slice(spec.lastIndexOf(':') + 1)
      const rest = spec.includes(':') ? spec.slice(0, spec.lastIndexOf(':')) : spec
      const inlineLine = rest.slice(rest.lastIndexOf(':') + 1)
      if (!/^[0-9]+$/.test(inlineLine)) die(`줄 번호를 읽지 못했습니다: ${spec}`)
      if (!nonEmpty(inlineFile)) die(`본문 파일이 비어 있습니다: ${inlineFile}`)
      const text = read(inlineFile)
      if (!GRADE_RE.test(firstLine(text))) die(`${inlineFile} 의 첫 줄이 색 원과 등급(예: 🟠 **P2 높음**)이 아닙니다.`)
      body += `\n${text.replace(/\n+$/, '')}`
    }
  }
  const bodyHead = firstLine(read(bodyFile))
  if (mode === 'review' || mode === 'edit') {
    if (!GRADE_RE.test(bodyHead)) die('본문 첫 줄이 색 원과 등급(예: 🟠 **P2 높음**)이 아닙니다. references/grading.md 의 표기를 확인하세요.')
  } else if (mode === 'summary' || mode === 'batch') {
    if (!bodyHead.startsWith('## 코드 리뷰')) die("요약 첫 줄이 '## 코드 리뷰' 로 시작하지 않습니다.")
  }
  for (const kw of keywords) {
    if (!body.includes(kw)) die(`본문에 '${kw}' 가 없습니다. 다른 본문일 수 있습니다.`)
  }
  if (body.split('\n').some((text) => BOT_TOKEN.test(text))) die('본문에 봇 재트리거 토큰이 있습니다. 백틱으로 감싸세요.')

  if (mode === 'review' || mode === 'batch') {
    const locations = mode === 'review'
      ? [{ path: filePath, line: parseLine(line) }]
      : inlines.map((spec) => {
          const rest = spec.slice(0, spec.lastIndexOf(':'))
          const split = rest.lastIndexOf(':')
          return { path: split < 0 ? '' : rest.slice(0, split), line: pyIntOf(rest.slice(split + 1)) }
        })
    validateInlineLocations(host, repo, pr, locations)
  }

  write(1, `호스트  : ${host}\n`)
  write(1, `대상    : ${repo} PR #${pr}\n`)
  switch (mode) {
    case 'review':
      write(1, `위치    : ${filePath}:${line}\n`)
      break
    case 'summary':
      write(1, '위치    : 리뷰 요약\n')
      break
    case 'batch':
      write(1, `위치    : 리뷰 요약과 인라인 ${inlines.length}건\n`)
      break
    case 'edit':
      write(1, `수정 대상: 댓글 ${commentId}\n`)
      break
    default:
      write(1, `답글 대상: 댓글 ${commentId}\n`)
  }
  write(1, `첫 줄   : ${bodyHead}\n`)
  write(1, '검증    : 통과\n')

  if (env.DRY_RUN === '1') {
    write(1, 'DRY_RUN=1 이므로 등록하지 않고 종료합니다.\n')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'gh-review-payload.'))
  const payload = join(dir, 'payload.json')
  try {
    const send = (data: unknown) => {
      writeFileSync(payload, `${pyJson(data)}\n`)
      return JSON.parse(gh(host, ['api', `repos/${repo}/pulls/${pr}/reviews`, '-X', 'POST', '--input', payload]))
    }
    const withNotice = (text: string, wrap: (notice: string) => string) => (text.includes(AI_NOTICE) ? text : text + wrap(AI_NOTICE))
    const summaryBody = () => withNotice(rstrip(pyReadText(bodyFile)), (n) => `\n\n---\n\n${n}`)
    if (mode === 'batch') {
      const comments = inlines.map((spec) => {
        const at = spec.lastIndexOf(':')
        const rest = spec.slice(0, at)
        const text = withNotice(rstrip(pyReadText(spec.slice(at + 1))), (n) => `\n\n<sub>${n}</sub>`)
        const split = rest.lastIndexOf(':')
        // rpartition 처럼 콜론이 없으면 경로는 빈 글자다
        return { path: split < 0 ? '' : rest.slice(0, split), line: pyIntOf(rest.slice(split + 1)), side: 'RIGHT', body: text }
      })
      const result = send({ event: 'COMMENT', body: summaryBody(), comments })
      write(1, `등록 완료: 리뷰 ${pyStr(result.id)}\n`)
      verifyInline(host, repo, pr, pyStr(result.id), inlines.length)
    } else if (mode === 'edit') {
      writeFileSync(payload, `${pyJson({ body: withNotice(rstrip(pyReadText(bodyFile)), (n) => `\n\n<sub>${n}</sub>`) })}\n`)
      const jq = '"수정 완료: 댓글 \\(.id)  \\(.path)  첫 줄: \\(.body | split("\\n")[0])"'
      write(1, gh(host, ['api', `repos/${repo}/pulls/comments/${commentId}`, '-X', 'PATCH', '--input', payload, '--jq', jq], false))
    } else if (mode === 'summary') {
      const result = send({ event: 'COMMENT', body: summaryBody() })
      write(1, `등록 완료: 요약 리뷰 ${pyStr(result.id)} ${pyStr(result.html_url)}\n`)
    } else if (mode === 'review') {
      const text = withNotice(rstrip(pyReadText(bodyFile)), (n) => `\n\n<sub>${n}</sub>`)
      const lineNumber = parseLine(line)
      const result = send({ event: 'COMMENT', comments: [{ path: filePath, line: lineNumber, side: 'RIGHT', body: text }] })
      write(1, `등록 완료: 리뷰 ${pyStr(result.id)}\n`)
      verifyInline(host, repo, pr, pyStr(result.id), 1)
    } else {
      const result = JSON.parse(gh(host, ['api', `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`, '-X', 'POST', '-F', `body=@${bodyFile}`]))
      write(1, `등록 완료: 답글 ${pyStr(result.id)} (in_reply_to ${pyStr(result.in_reply_to_id)})\n`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function main(argv: string[]): number {
  try {
    run(argv)
    return 0
  } catch (error) {
    if (error instanceof Exit) return error.code
    throw error
  }
}

const isMain = isMainModule(import.meta.url, import.meta.main)
if (isMain) process.exitCode = main(process.argv.slice(2))
