import { spawnSync } from 'node:child_process'
import { write } from '../io.ts'
import { maskedBlocks } from './markdown-code.ts'
// CommonMark 에서 참조하는 https://html.spec.whatwg.org/entities.json 의 세미콜론이 있는 이름.
import namedReferences from './named-character-references.json' with { type: 'json' }

const ID = '[a-z0-9][a-z0-9_-]*'
const INTERNAL = new RegExp(`^dooray://(${ID})/tasks/(${ID})$`, 'i')
const WEB_PATH = new RegExp(`^/(?:project/tasks|task/${ID})/(${ID})/?$`, 'i')
const LINK_BASE = 'https://base.invalid/'
const POST_REF = /^[^\s/]+\/\d+(?=\s|$)/u
const BRACKET = /\\[^\r\n]|[\[\]]/gu
const WORKFLOW = /^(registered|working|closed|backlog)$/
// 짝을 이룬 백슬래시 뒤에서는 링크를 시작할 수 있다. 대괄호 검사를 위해 표시 글의 원문을 읽는다.
const INLINE_LINK = /(?<!\\)(?:\\\\)*\[((?:\\[^\r\n]|(?!\]\()[^\\])*?)\]\([ \t\r\n]*(<[^\s<>]+>|[^\s<>()]+)(?:[ \t\r\n]+(?:"((?:\\[^\r\n]|[^"\\])*)"|'((?:\\[^\r\n]|[^'\\])*)'|\(((?:\\[^\r\n]|[^()\\])*)\)))?[ \t\r\n]*\)/gu
const OTHER_LINK = /^(?:[ \t]*\[(?:\\[^\r\n]|[^\[\]\\])+\]:[ \t\r\n]*)(?<reference><[^\s<>]+>|[^\s<>`]+)|(?<anchor><a\b(?:[^>"']|"[^"]*"|'[^']*')*>)|<(?<auto>(?:(?:dooray|https?):)?\/\/[^\s<>]+)>|(?<address>(?:(?:dooray|https?):|(?<![\w:/]))\/\/[^\s<>()\[\]"`']+|(?<![\w/])\/(?:project\/tasks|task)\/[^\s<>()\[\]"`']+)/gimu
const HTML_ATTRIBUTE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/gu
const CHARACTER_REFERENCE = String.raw`&(#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6})|[A-Za-z][A-Za-z0-9]*);`
const MARKDOWN_ADDRESS = new RegExp(String.raw`\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])|` + CHARACTER_REFERENCE, 'gu')
const HTML_ADDRESS = new RegExp(CHARACTER_REFERENCE, 'gu')
const namedCharacters: Readonly<Record<string, string>> = namedReferences

type Post = { ref: string; subject?: string; workflowClass?: string }
type CliPost = { project?: { code?: unknown }; number?: unknown; taskNumber?: unknown; subject?: unknown; workflowClass?: unknown }
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
    const post = JSON.parse(result.stdout) as CliPost | null
    const code = post?.project?.code
    const number = post?.number
    const fromFields = typeof code === 'string' && (typeof number === 'string' || typeof number === 'number')
      ? `${code}/${number}`
      : undefined
    for (const ref of [fromFields, post?.taskNumber]) {
      if (typeof ref !== 'string' || POST_REF.exec(ref)?.[0] !== ref) continue
      return {
        ref,
        subject: typeof post?.subject === 'string' ? post.subject : undefined,
        workflowClass: typeof post?.workflowClass === 'string' ? post.workflowClass : undefined,
      }
    }
  } catch {
    // 설치된 CLI 가 JSON 응답을 내지 못하면 형식 검사만 진행한다.
  }
  return 'unavailable'
}

function decodePath(pathname: string): string {
  try {
    return decodeURI(pathname)
  } catch {
    return pathname
  }
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

function decodeReference(token: string, reference: string): string {
  if (!reference.startsWith('#')) return Object.hasOwn(namedCharacters, reference) ? namedCharacters[reference] : token
  const digits = reference.slice(1)
  const value = /^[xX]/u.test(digits) ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10)
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\uFFFD'
  return String.fromCodePoint(value)
}

function decodeMarkdown(text: string): string {
  // 한 번만 풀어 \\&colon; 로 적은 리터럴 앰퍼샌드를 다시 해석하지 않는다.
  return text.replace(MARKDOWN_ADDRESS, (token, escape, reference) => escape ?? decodeReference(token, reference))
}

type Link = {
  kind: 'inline' | '참조식 정의' | 'HTML 링크' | '자동 링크' | '주소만 적은 링크'
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
      yield { kind: '주소만 적은 링크', target: address }
    }
  }
}

function* findLinks(md: string): Generator<Link> {
  for (const { offset, text } of maskedBlocks(md)) {
    let cursor = 0
    for (const match of text.matchAll(INLINE_LINK)) {
      const opening = match.index + match[0].indexOf('[')
      const start = opening + 1
      const candidate = md.slice(offset + start, offset + start + match[1].length)
      const labelAt = labelStart(candidate)
      const labelIndex = opening + labelAt
      yield* otherLinks(text.slice(cursor, labelIndex))
      cursor = match.index + match[0].length
      yield {
        kind: 'inline',
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
    let decoded = kind === 'HTML 링크' ? target.replace(HTML_ADDRESS, decodeReference).trim() : decodeMarkdown(target)
    if (kind === '주소만 적은 링크') decoded = decoded.replace(/[.,!?;:]+$/u, '')
    const url = URL.parse(decoded, LINK_BASE)
    if (!url) continue
    const path = decodePath(url.pathname)
    const host = url.hostname.replace(/\.$/u, '')
    const internal = url.protocol === 'dooray:' ? INTERNAL.exec(`dooray://${host}${path.replace(/\/$/u, '')}`) : null
    const doorayHost = host === 'dooray.com' || host.endsWith('.dooray.com') || host === 'base.invalid'
    const webId = url.protocol !== 'dooray:' && doorayHost ? WEB_PATH.exec(path)?.[1] : undefined
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

    const ref = typeof post === 'string' ? undefined : post.ref
    const shown = POST_REF.exec(decodeMarkdown(label))?.[0]
    const mismatch = shown !== undefined && ref !== undefined && shown !== ref
    const actualLabel = ref && typeof post !== 'string'
      ? escapeBrackets(`${ref}${typeof post.subject === 'string' ? ` ${post.subject.replace(/\s+/gu, ' ').trim()}` : ''}`)
      : undefined
    const workflow = typeof post !== 'string' && WORKFLOW.test(post.workflowClass ?? '')
      ? post.workflowClass
      : WORKFLOW.test(shownWorkflow ?? '') ? shownWorkflow : 'registered'
    const replacement = shown && !mismatch ? fixedLabel : actualLabel ?? `PROJECT/NUMBER ${fixedLabel || '제목'}`
    const example = `[${replacement}](dooray://${internal?.[1] ?? 'ORG_ID'}/tasks/${id} "${workflow}")`

    const fix = `\n  고친 예 ${example}${webId ? ' (ORG_ID 에 조직 ID 를 넣으세요.)' : ''}\n  예시는 펜스 코드 블록으로 쓰세요.`
    if (fixedLabel !== label) errors.push(`오류: 업무 링크 표시 글 「${label}」의 대괄호를 &#91; 과 &#93; 으로 바꾸세요.${fix}`)
    if (inline && !shown) errors.push(`오류: 두레이 업무 링크 표시 글은 프로젝트/업무번호로 시작해야 합니다.${fix}`)
    if (webId) errors.push(`오류: 두레이 업무 웹 주소를 dooray:// 링크로 바꾸세요.${fix}`)
    else if (!inline) errors.push(`오류: 두레이 업무를 가리키는 ${kind}를 표시 글과 상태값을 갖춘 인라인 링크로 바꾸세요.${fix}`)
    else if (!INTERNAL.test(target) || !WORKFLOW.test(shownWorkflow ?? '')) {
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
