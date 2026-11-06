#!/usr/bin/env node
// Dooray 본문 미리보기 HTML 생성기.
//
// Dooray 업무·댓글은 TOAST UI Editor 로 렌더링하므로, 같은 viewer CSS/JS (uicdn.toast.com)
// 를 쓰는 템플릿에 markdown 을 흘려 넣으면 실제 등록 화면과 거의 동일한 미리보기가 된다.
//
// 업무·댓글·메신저는 --mode 로 고른다. 메신저는 확인된 멘션, 인라인 코드, HTTPS 주소와 링크만 렌더한다.
//
// 사용 예 (업무 본문):
//     node scripts/dooray-preview/generate.ts \
//         --project "<프로젝트명>" \
//         --title "<업무 제목>" \
//         --tag "<태그>" --tag "<태그>" \
//         --meta "담당자:<이름>" --meta "참조:<그룹>" \
//         --md-file "$PREVIEW_DIR/body.md" \
//         --out "$PREVIEW_DIR/preview.html"
//     node scripts/show-preview.ts "$PREVIEW_DIR/preview.html"
//
// 사용 예 (댓글):
//     node scripts/dooray-preview/generate.ts \
//         --mode comment --author "<작성자>" \
//         --title "<미리보기 제목>" \
//         --md-file "$PREVIEW_DIR/body.md" \
//         --out "$PREVIEW_DIR/preview.html"
//
// 옵션: --title(필수), --mode {task,comment,messenger}(기본 task), --author(기본 작성자), --strict, --project,
//     --tag(반복), --meta 라벨:값(반복), --md-file(필수, '-' 는 stdin), --out(필수)
// 종료 코드: 0 성공, 1 본문에 '</script>' 가 있거나 읽지 못함 또는 --strict 의 경고, 2 사용법 오류
//
// 주의:
// - markdown 본문에 '</script>' 문자열이 있으면 안 된다 (text/plain 블록이 깨짐).
// - CDN 로드라 오프라인에서는 스타일이 빠진 채 보인다.
//
// 정규식은 옛 Python(str 패턴)과 같은 글자를 잡는다. Python 의 \s 는 \x1c~\x1f, \x85 를 공백으로 보고 U+FEFF 는 보지 않는다.
// re.M 의 ^ 와 $ 는 \n 만 줄 경계로 본다. re.I 는 ſ 를 s 로 읽는다. 그래서 JS 의 \s, m 플래그를 쓰지 않고
// kit/py.ts 의 PY_SPACE 와 lookaround 로 풀어 쓰고, 대소문자는 u 플래그와 함께 i 로 가린다.

import { join } from 'node:path'
import { parseCli, type Spec } from '../cli.ts'
import { isMain, readStdin, write } from '../io.ts'
import { PY_SPACE, pyHead, pyReadText } from '../kit/py.ts'
import { clearOutput, escapeHtml, writeOutput } from '../preview_output.ts'

const TEMPLATE = join(import.meta.dirname, 'template.html')

const LINK_WARNING = '경고: Dooray 메신저의 업무·위키 dooray:// 마크다운 링크는 https 주소로 바꾸세요.'

// PY_SPACE 는 대괄호까지 든 클래스다. 부정 클래스 안에 풀어 쓸 때는 안쪽만 쓴다
const SP = PY_SPACE.slice(1, -1)
const NOT_SP = `[^${SP}]`
const LINE_START = '(?<![^\\n])'
const LINE_END = '(?![^\\n])'

const UNSUPPORTED_LINK = new RegExp(`dooray://[^${SP})>]*/(?:tasks|pages)/`, 'iu')
const MENTION = `\\[@[^\\]\\n]+\\]\\(dooray://[^${SP})]+/members/[^${SP})]+${PY_SPACE}+"member"\\)`
const INLINE_CODE = '`[^`\\n]+`'
const HTTPS_LINK = '\\[([^\\]\\n]+)\\]\\((https://[^' + SP + ')]+)\\)'
const MESSENGER_TOKEN = new RegExp(
  `${MENTION}|${INLINE_CODE}|${HTTPS_LINK}|\\[[^\\]\\n]*\\]\\([^\\n)]*\\)|https://[^${SP}<>\\[\\]"']+`,
  'gu',
)
const MENTION_FULL = new RegExp(`^(?:${MENTION})$`, 'u')
const INLINE_CODE_FULL = new RegExp(`^(?:${INLINE_CODE})$`, 'u')
const HTTPS_LINK_FULL = new RegExp(`^(?:${HTTPS_LINK})$`, 'u')
const INLINE_CODE_ALL = new RegExp(INLINE_CODE, 'gu')

// 메신저가 기호 그대로 보이는 형식이다. 사용자 실측(2026-11-02), references/messenger-rendering.md 가 소유한다.
const CODE_FENCE_SOURCE =
  `${LINE_START}[ \\t]*(\`{3,}|~{3,})[^\\n]*\\n.*?${LINE_START}[ \\t]*\\1[ \\t]*${LINE_END}|${LINE_START}[ \\t]*(?:\`{3,}|~{3,})`
const CODE_FENCE = new RegExp(CODE_FENCE_SOURCE, 'su')
const CODE_FENCE_ALL = new RegExp(CODE_FENCE_SOURCE, 'gsu')
const UNRENDERED_FORMATS: [string, RegExp][] = [
  ['굵게', /\*\*[^*\n]+\*\*|__[^_\n]+__/u],
  ['제목', new RegExp(`${LINE_START}[ \\t]{0,3}#{1,6}[ \\t]`, 'u')],
  ['표', new RegExp(`${LINE_START}[ \\t]*\\|?[ \\t]*:?-{3,}:?[ \\t]*(?:\\|[ \\t]*:?-{3,}:?[ \\t]*)+\\|?[ \\t]*${LINE_END}`, 'u')],
  ['목록', new RegExp(`${LINE_START}[ \\t]*[-*+][ \\t]+${NOT_SP}`, 'u')],
]

// 메신저에서 기호 그대로 보이는 마크다운 형식의 이름을 본문 순서와 무관하게 정해진 순서로 돌려준다
export function unrenderedFormats(md: string): string[] {
  const found: string[] = []
  if (CODE_FENCE.test(md)) found.push('코드 블록')
  // 코드 블록과 인라인 코드 안의 기호는 형식 판정에서 뺀다
  const text = md.replace(CODE_FENCE_ALL, '').replace(INLINE_CODE_ALL, '')
  for (const [name, pattern] of UNRENDERED_FORMATS) if (pattern.test(text)) found.push(name)
  return found
}

export function unrenderedWarning(names: string[]): string {
  return (
    `경고: Dooray 메신저는 ${names.join(', ')} 형식을 렌더하지 않아 기호가 그대로 보입니다. ` +
    '항목은 「1.」 같은 평문 번호와 빈 줄로 나누고, 표는 「항목: 값」 처럼 한 줄씩 쓰세요. ' +
    '강조와 제목은 평문으로, 코드는 인라인 코드로 쓰세요.'
  )
}

const TRAILING = new Set('.,!?;:，。')
const count = (text: string, ch: string) => text.split(ch).length - 1

// 확인된 멘션, 인라인 코드, HTTPS 주소와 링크만 렌더하고 나머지는 원문으로 둔다
export function renderMessenger(md: string): string {
  const parts: string[] = []
  let end = 0
  for (const match of md.matchAll(MESSENGER_TOKEN)) {
    parts.push(escapeHtml(md.slice(end, match.index)))
    const token = match[0]
    let link: RegExpExecArray | null
    if (MENTION_FULL.test(token)) {
      const rest = token.slice(1)
      const at = rest.indexOf('](')
      const label = rest.slice(0, at)
      const target = rest.slice(at + 2)
      const url = new RegExp(`^${NOT_SP}+`, 'u').exec(target)![0]
      parts.push(`<a class="dooray-mention" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`)
    } else if (INLINE_CODE_FULL.test(token)) {
      parts.push(`<code>${escapeHtml(token.slice(1, -1))}</code>`)
    } else if ((link = HTTPS_LINK_FULL.exec(token))) {
      parts.push(`<a href="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`)
    } else if (token.startsWith('https://')) {
      // 문장 끝의 구두점은 링크에 넣지 않는다. URL 내부 괄호는 보존한다
      let url = token
      while (url.length && TRAILING.has(url.at(-1)!)) url = url.slice(0, -1)
      while (url.endsWith(')') && count(url, ')') > count(url, '(')) url = url.slice(0, -1)
      const escaped = escapeHtml(url)
      parts.push(`<a href="${escaped}">${escaped}</a>`)
      parts.push(escapeHtml(token.slice(url.length)))
    } else {
      parts.push(escapeHtml(token))
    }
    end = match.index + token.length
  }
  parts.push(escapeHtml(md.slice(end)))
  return `<div class="dooray-messenger-text">${parts.join('')}</div>`
}

const PROG = 'generate.ts'
const USAGE = `usage: ${PROG} [-h] --title TITLE [--mode {task,comment,messenger}]
                   [--author AUTHOR] [--strict] [--project PROJECT]
                   [--tag TAG] [--meta META] --md-file MD_FILE --out OUT
`
const SPEC: Spec = {
  prog: PROG,
  usage: USAGE,
  help: `${USAGE}
Dooray 본문 미리보기 HTML 생성

options:
  -h, --help            show this help message and exit
  --title TITLE         업무 제목, 댓글 미리보기 제목 또는 메신저 대화방 이름
  --mode {task,comment,messenger}
                        task 는 업무, comment 는 댓글, messenger 는 대화방 메시지
  --author AUTHOR       댓글 작성자 또는 메신저 보내는 사람
  --strict              messenger 모드에서만 적용: 링크나 렌더되지 않는 형식의 경고가 있으면 HTML 생성 후
                        종료 코드 1
  --project PROJECT     프로젝트명 (헤더 표시용). 없으면 그 줄을 그린다
  --tag TAG             태그 (반복 지정)
  --meta META           메타 정보 '라벨:값' (반복 지정, 예: 담당자:<이름>)
  --md-file MD_FILE     본문 markdown 파일 경로 ('-' 는 stdin)
  --out OUT             출력 HTML 경로
`,
  options: {
    title: { type: 'string', required: true },
    mode: { type: 'string', choices: ['task', 'comment', 'messenger'] },
    author: { type: 'string' },
    strict: { type: 'boolean' },
    project: { type: 'string' },
    tag: { type: 'string', multiple: true },
    meta: { type: 'string', multiple: true },
    'md-file': { type: 'string', required: true },
    out: { type: 'string', required: true },
  },
}

export function main(argv: string[]): number {
  const parsed = parseCli(argv, SPEC)
  if ('exit' in parsed) return parsed.exit
  const args = parsed.values as { title: string; mode?: string; author?: string; strict?: boolean; project?: string; tag?: string[]; meta?: string[]; 'md-file': string; out: string }
  const mode = args.mode ?? 'task'
  const author = args.author ?? '작성자'
  const strict = Boolean(args.strict)
  clearOutput(args.out)

  const md = args['md-file'] === '-' ? readStdin() : pyReadText(args['md-file'])

  if (mode !== 'messenger' && md.includes('</script>')) {
    write(2, "오류: 본문에 '</script>' 가 포함되어 미리보기가 깨진다. 본문을 수정하라.\n")
    return 1
  }

  const warnings: string[] = []
  if (mode === 'messenger') {
    if (UNSUPPORTED_LINK.test(md)) warnings.push(LINK_WARNING)
    const names = unrenderedFormats(md)
    if (names.length) warnings.push(unrenderedWarning(names))
  }
  for (const message of warnings) write(2, `${message}\n`)
  const warningHtml = warnings.map((message) => `<div class="dooray-warning" role="alert">${escapeHtml(message)}</div>`).join('')

  let headHtml: string
  if (mode === 'messenger') {
    headHtml = `<div class="dooray-head"><div class="dooray-title">${escapeHtml(args.title)}</div><div class="dooray-author">${escapeHtml(author)}</div></div>`
  } else if (mode === 'comment') {
    const escaped = escapeHtml(author)
    headHtml =
      '<div class="dooray-comment-head">' +
      `<div class="dooray-avatar">${pyHead(escaped, 1)}</div>` +
      `<div><div class="dooray-author">${escaped}</div>` +
      `<div class="dooray-on">${escapeHtml(args.title)}</div></div>` +
      '</div>'
  } else {
    const tagsHtml = (args.tag ?? []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')
    const metaParts = (args.meta ?? []).map((item) => {
      const at = item.indexOf(':')
      const label = at < 0 ? item : item.slice(0, at)
      const value = at < 0 ? '' : item.slice(at + 1)
      return `<span>${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`
    })
    const projHtml = args.project ? `<div class="dooray-proj">${escapeHtml(args.project)}</div>` : ''
    headHtml =
      '<div class="dooray-head">' +
      projHtml +
      `<div class="dooray-title">${escapeHtml(args.title)}</div>` +
      `<div class="dooray-meta">${metaParts.join('')}</div>` +
      `<div class="tags">${tagsHtml}</div>` +
      '</div>'
  }

  const values: Record<string, string> = {
    TITLE: escapeHtml(args.title),
    HEAD_HTML: headHtml,
    MODE: mode,
    WARNING_HTML: warningHtml,
    MESSENGER_BODY: mode === 'messenger' ? renderMessenger(md) : '',
    MD_BODY: mode === 'messenger' ? '' : md,
  }
  // 본문의 템플릿 표기를 다시 치환하지 않도록 한 번만 삽입한다.
  const out = pyReadText(TEMPLATE).replace(/\{\{([\p{L}\p{N}_]+)\}\}/gu, (_, name: string) => {
    if (!(name in values)) throw new Error(`템플릿에 모르는 표기가 있다: ${name}`)
    return values[name]
  })
  writeOutput(args.out, out)
  write(1, `생성 완료: ${args.out}\n`)
  return warnings.length && strict ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
