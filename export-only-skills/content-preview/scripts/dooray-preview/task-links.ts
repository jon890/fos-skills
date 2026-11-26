import { spawnSync } from 'node:child_process'
import { write } from '../io.ts'

const ID = '[a-z0-9][a-z0-9_-]*'
const INTERNAL = new RegExp(`^dooray://(${ID})/tasks/(${ID})$`, 'i')
const WEB_PATH = new RegExp(`^/(?:project/tasks|task/${ID})/(${ID})/?$`, 'i')
const POST_REF = /^([^\s/]+)\/(\d+)(?=\s|$)/u
const BRACKET = /\\[^\r\n]|[\[\]]/gu
const WORKFLOW = /^(registered|working|closed|backlog)$/

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

function maskCode(md: string): string {
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ')
  let fence = ''
  const lines = md.split(/(?<=\n)/u).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
      return blank(line)
    }
    if (!marker) return line
    fence = marker[1]
    return blank(line)
  })
  return lines.join('').replace(/(?<![`\\])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, blank)
}

function webPostId(target: string, inline: boolean): string | undefined {
  if (inline && target.startsWith('/')) return WEB_PATH.exec(target.split(/[?#]/u, 1)[0])?.[1]
  if (!/^https:\/\//i.test(target)) return
  const url = URL.parse(target)
  if (url?.hostname.endsWith('.dooray.com')) return WEB_PATH.exec(url.pathname)?.[1]
}

function escapeBrackets(label: string): string {
  return label.replace(BRACKET, (token) => token === '[' ? '&#91;' : token === ']' ? '&#93;' : token)
}

function linkLabel(candidate: string): string {
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
  return candidate.slice(start)
}

type Cache = { posts: Map<string, Lookup>; missingCli: boolean }

function checkBody(md: string, cache: Cache): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  // 올바른 Markdown 파서가 버릴 수 있는 대괄호도 검사할 수 있도록 원문의 표시 글을 읽는다.
  const links = /(?<!\\)\[((?:\\[^\r\n]|(?!\]\()[^\\\r\n])*?)\]\([ \t]*<?([^\s<>()]+)>?(?:[ \t]+["']([^\r\n]*?)["'])?[ \t]*\)|https:\/\/[^\s<>()\[\]"']+/giu
  for (const link of maskCode(md).matchAll(links)) {
    const inline = link[1] !== undefined
    const target = inline ? link[2] : link[0].replace(/[.,!?;:]+$/u, '')
    const internal = inline ? INTERNAL.exec(target) : null
    const webId = webPostId(target, inline)
    const id = internal?.[2] ?? webId
    if (!id) continue

    const label = inline ? linkLabel(md.slice(link.index + 1, link.index + 1 + link[1].length)) : ''
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
    const mismatch = inline && ref !== undefined && (!shown || `${shown[1]}/${shown[2]}` !== ref)
    const actualLabel = ref && typeof post !== 'string'
      ? escapeBrackets(`${ref}${typeof post.subject === 'string' ? ` ${post.subject.replace(/\s+/gu, ' ').trim()}` : ''}`)
      : undefined
    const workflow = typeof post !== 'string' && WORKFLOW.test(post.workflowClass ?? '')
      ? post.workflowClass
      : WORKFLOW.test(link[3] ?? '') ? link[3] : 'registered'
    const replacement = shown && !mismatch ? fixedLabel : actualLabel ?? `PROJECT/NUMBER ${fixedLabel || '제목'}`
    const example = `[${replacement}](dooray://${internal?.[1] ?? 'ORG_ID'}/tasks/${id} "${workflow}")`

    const fix = `\n  고친 예 ${example}${webId ? ' (ORG_ID 에 조직 ID 를 넣으세요.)' : ''}`
    if (fixedLabel !== label) errors.push(`오류: 업무 링크 표시 글 「${label}」의 대괄호를 &#91; 과 &#93; 으로 바꾸세요.${fix}`)
    if (webId) errors.push(`오류: 두레이 업무 웹 주소를 dooray:// 링크로 바꾸세요.${fix}`)
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
