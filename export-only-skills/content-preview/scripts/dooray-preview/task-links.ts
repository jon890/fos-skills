import { spawnSync } from 'node:child_process'
import { write } from '../io.ts'
import { maskedBlocks } from './markdown-code.ts'

const ID = '[a-z0-9][a-z0-9_-]*'
const INTERNAL = new RegExp(`^dooray://(${ID})/tasks/(${ID})$`, 'i')
const WEB_PATH = new RegExp(`^/(?:project/tasks|task/${ID})/(${ID})/?$`, 'i')
const POST_REF = /^([^\s/]+)\/(\d+)(?=\s|$)/u
const BRACKET = /\\[^\r\n]|[\[\]]/gu
const WORKFLOW = /^(registered|working|closed|backlog)$/
// 정상 Markdown 파서가 버릴 수 있는 대괄호도 검사할 수 있도록 표시 글을 그대로 읽는다.
const INLINE_LINK = /(?<!\\)\[((?:\\[^\r\n]|(?!\]\()[^\\])*?)\]\([ \t\r\n]*(<[^\s<>]+>|[^\s<>()]+)(?:[ \t\r\n]+(?:"((?:\\[^\r\n]|[^"\\])*)"|'((?:\\[^\r\n]|[^'\\])*)'|\(((?:\\[^\r\n]|[^()\\])*)\)))?[ \t\r\n]*\)/gu
const OTHER_LINK = /^(?:[ \t]*\[(?:\\[^\r\n]|[^\[\]\\])+\]:[ \t\r\n]*)(?<reference><[^\s<>]+>|[^\s<>`]+)|(?<anchor><a\b(?:[^>"']|"[^"]*"|'[^']*')*>)|<(?<auto>(?:dooray|https?):\/\/[^\s<>]+)>|(?<address>(?:dooray|https?):\/\/[^\s<>()\[\]"`']+|(?<![\w/])\/(?:project\/tasks|task)\/[^\s<>()\[\]"`']+)/gimu
const HTML_ATTRIBUTE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/gu
// 정상 링크와 같은 꼴의 인라인 코드 예제도 막는다. 백틱이 링크 검사에서 문장을 가리지는 않는다.
const CODE_EXAMPLE = /(?<![`\\])(`+)(?!`)[^|]*?(?<!`)\1(?!`)/gu

type Post = { project: { code: string }; number: string | number; subject?: string; workflowClass?: string }
type Lookup = Post | 'missing-cli' | 'unavailable'

function lookupPost(id: string): Lookup {
  const result = spawnSync('dooray', ['--json', 'post', 'get', '--id', id], {
    encoding: 'utf8',
    timeout: 8_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'missing-cli'
  if (result.status !== 0) return 'unavailable'
  try {
    const post = JSON.parse(result.stdout) as Post | null
    if (typeof post?.project?.code === 'string' && post.project.code && /^\d+$/.test(String(post.number))) return post
  } catch {
    // 설치된 CLI 가 JSON 응답을 내지 못하면 형식 검사만 진행한다.
  }
  return 'unavailable'
}

function webPostId(target: string): string | undefined {
  if (target.startsWith('/')) return WEB_PATH.exec(target.split(/[?#]/u, 1)[0])?.[1]
  if (!/^https?:\/\//i.test(target)) return
  const url = URL.parse(target)
  if (url?.hostname.endsWith('.dooray.com')) return WEB_PATH.exec(url.pathname)?.[1]
}

function escapeBrackets(label: string): string {
  return label.replace(BRACKET, (token) => token === '[' ? '&#91;' : token === ']' ? '&#93;' : token)
}

function labelStart(candidate: string): number {
  // 정규식이 먼저 읽은 독립 대괄호가 닫힌 뒤에 실제 링크가 시작할 수 있다.
  let depth = 1
  let start = 0
  for (const bracket of candidate.matchAll(BRACKET)) {
    if (bracket[0] === '[') {
      if (depth === 0) start = bracket.index + 1
      depth++
    } else if (bracket[0] === ']') {
      depth = Math.max(0, depth - 1)
    }
  }
  return start
}

function unwrapAddress(target: string): string {
  return target.startsWith('<') ? target.slice(1, -1) : target
}

type Link = {
  kind: 'inline' | '참조식 정의' | 'HTML 링크' | '자동 링크' | '주소만 적은 링크' | '인라인 코드 예제'
  target: string
  label?: string
  workflow?: string
}

function* otherLinks(text: string): Generator<Link> {
  for (const { groups } of text.matchAll(OTHER_LINK)) {
    const { reference, anchor, auto, address } = groups!
    if (reference) {
      yield { kind: '참조식 정의', target: unwrapAddress(reference) }
    } else if (anchor) {
      for (const attribute of anchor.matchAll(HTML_ATTRIBUTE)) {
        if (attribute[1].toLowerCase() !== 'href') continue
        const target = attribute[2] ?? attribute[3] ?? attribute[4]
        if (target) yield { kind: 'HTML 링크', target: target.trim() }
        break
      }
    } else if (auto) {
      yield { kind: '자동 링크', target: auto }
    } else {
      yield { kind: '주소만 적은 링크', target: address.replace(/[.,!?;:]+$/u, '') }
    }
  }
}

function* findLinks(md: string): Generator<Link> {
  for (const { offset, text } of maskedBlocks(md)) {
    let cursor = 0
    const codeExamples = text.matchAll(CODE_EXAMPLE)
    let code = codeExamples.next().value
    for (const match of text.matchAll(INLINE_LINK)) {
      const start = match.index + 1
      const candidate = md.slice(offset + start, offset + start + match[1].length)
      const labelAt = labelStart(candidate)
      const labelIndex = match.index + labelAt
      yield* otherLinks(text.slice(cursor, labelIndex))
      cursor = match.index + match[0].length
      while (code && code.index + code[0].length <= labelIndex) code = codeExamples.next().value
      const codeExample = code && code.index < labelIndex && code.index + code[0].length > cursor
      yield {
        kind: codeExample ? '인라인 코드 예제' : 'inline',
        label: candidate.slice(labelAt).replace(/[ \t]*(?:\r\n?|\n)(?:[ \t]*>)*[ \t]*/gu, ' '),
        target: unwrapAddress(match[2]),
        workflow: match[2].startsWith('<') ? undefined : match[3],
      }
    }
    yield* otherLinks(text.slice(cursor))
  }
}

type Cache = { posts: Map<string, Lookup>; missingCli: boolean }

function checkBody(md: string, cache: Cache): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  for (const { kind, label: shownLabel, target, workflow: shownWorkflow } of findLinks(md)) {
    const inline = kind === 'inline'
    const internal = INTERNAL.exec(target.split(/[?#]/u, 1)[0].replace(/\/$/u, ''))
    const webId = webPostId(target)
    const id = internal?.[2] ?? webId
    if (!id) continue

    const label = shownLabel ?? ''
    const fixedLabel = escapeBrackets(label)
    const post = cache.posts.get(id) ?? (cache.missingCli ? 'missing-cli' : lookupPost(id))
    if (!cache.posts.has(id)) {
      cache.posts.set(id, post)
      if (post === 'missing-cli' && !cache.missingCli) {
        cache.missingCli = true
        warnings.push('경고: dooray CLI 를 찾지 못해 업무 링크의 프로젝트와 번호를 확인하지 못했습니다.')
      }
      if (post === 'unavailable') {
        warnings.push(`경고: 업무 링크 「${label || target}」를 조회하지 못해 프로젝트와 번호를 확인하지 못했습니다.`)
      }
    }

    const ref = typeof post === 'string' ? undefined : `${post.project.code}/${post.number}`
    const shown = POST_REF.exec(label)
    const mismatch = shownLabel !== undefined && ref !== undefined && (!shown || `${shown[1]}/${shown[2]}` !== ref)
    const actualLabel = ref && typeof post !== 'string'
      ? escapeBrackets(`${ref}${typeof post.subject === 'string' ? ` ${post.subject.replace(/\s+/gu, ' ').trim()}` : ''}`)
      : undefined
    const workflow = typeof post !== 'string' && WORKFLOW.test(post.workflowClass ?? '')
      ? post.workflowClass
      : WORKFLOW.test(shownWorkflow ?? '') ? shownWorkflow : 'registered'
    const replacement = shown && !mismatch ? fixedLabel : actualLabel ?? `PROJECT/NUMBER ${fixedLabel || '제목'}`
    const example = `[${replacement}](dooray://${internal?.[1] ?? 'ORG_ID'}/tasks/${id} "${workflow}")`

    const fix = `\n  고친 예 ${example}${webId ? ' (ORG_ID 에 조직 ID 를 넣으세요.)' : ''}\n  예시는 코드 블록으로 쓰세요.`
    if (fixedLabel !== label) errors.push(`오류: 업무 링크 표시 글 「${label}」의 대괄호를 &#91; 과 &#93; 으로 바꾸세요.${fix}`)
    if (webId) errors.push(`오류: 두레이 업무 웹 주소를 dooray:// 링크로 바꾸세요.${fix}`)
    else if (kind === '인라인 코드 예제') errors.push(`오류: 인라인 코드에 두레이 업무 링크가 있습니다.${fix}`)
    else if (!inline) errors.push(`오류: 두레이 업무를 가리키는 ${kind}를 표시 글과 상태값을 갖춘 인라인 링크로 바꾸세요.${fix}`)
    else if (target !== internal?.[0] || !WORKFLOW.test(shownWorkflow ?? '')) {
      errors.push(`오류: 두레이 업무 주소는 dooray://조직ID/tasks/업무ID 꼴로 쓰고 등록·진행·완료 등의 상태값을 큰따옴표로 감싸세요.${fix}`)
    }
    if (mismatch) errors.push(`오류: 업무 링크 표시 글 「${label}」과 실제 업무 ${ref} 가 다릅니다. 연결할 업무를 확인하세요.${fix}`)
  }
  return { errors, warnings }
}

// 한 번 검사하는 파일들에서 같은 업무를 다시 조회하지 않는다.
export function reportTaskLinks(bodies: string[]): { failed: boolean; warnings: string[] } {
  const cache: Cache = { posts: new Map(), missingCli: false }
  let failed = false
  const warnings: string[] = []
  for (const body of bodies) {
    const result = checkBody(body, cache)
    for (const message of [...result.warnings, ...result.errors]) write(2, `${message}\n`)
    failed ||= result.errors.length > 0
    warnings.push(...result.warnings)
  }
  return { failed, warnings }
}
