#!/usr/bin/env node
// 마크다운 가독성 규칙 중 스크립트로 판정할 수 있는 축을 경고로 알린다.
//
// **이 파일이 검사 축의 단일 소스다.** references 파일을 읽지 않고 축을 코드에 담는다.
// 사람이 보는 몫은 `references/` 가 소유한다.
// korean-style.md 가 언어, korean-examples.md 가 언어 예시, writing-structure.md 가 구조, markdown-readability.md 가 검사 제외 대상이다.
//
// 사용법:
//     node check-readability.ts <파일.md> [<파일.md>...]
//     node check-readability.ts --text "<제목이나 커밋 메시지>"   파일이 아닌 문자열
//     node check-readability.ts --hook                           PostToolUse 훅 모드 (stdin 으로 JSON)
//
// 경고 줄을 stdout 으로 출력한다. 경고가 있어도 종료 코드는 0 이다.
// 사용법 오류이거나 넘긴 경로에 파일이 없으면 2 로 끝난다.
//
// **이 검사기는 실패로 막지 않는다.** 실패로 막는 것은 `korean-style-check.ts` 의 금지어뿐이다.
// 아래 축은 지침이라, 걸린 줄을 보고 문맥에 맞으면 그대로 둔다.
//
// 검사하는 축은 넷이다.
//
//     NEST   괄호 2겹 중첩
//     SECT   `§` 사용
//     TILDE  한 단락에 이스케이프하지 않은 물결표 2개 이상 (취소선 오작동)
//     DASH   제목과 평문의 엠대시 (목록과 표의 이름-설명 구분은 허용)
//
// 나머지 축은 다른 곳이 맡는다.
//
// - 매핑 표의 금지어는 `korean-style-check.ts` 가 실패로 막고, 인라인 `+` 연결은 같은 검사기가 경고로 알린다
// - 렌더러 고유 동작과 게시 대상 고유 형식은 그 매체를 쓰는 저장소의 검사기가 강제한다
// - 한 문장 한 줄, `=` 와 `→` 압축, bullet 다중 속성은 의미 판단이 필요해 사람이 본다
//
// **코드 블록과 표와 링크와 frontmatter 는 검사에서 제외한다.**
// 규칙이 이들을 미적용 대상으로 정했다. 맨 grep 은 그것을 거르지 않아
// 규칙 자신을 적은 문서까지 잡는 오탐만 낸다.
//
// 옛 이름 진입 check-readability.py(node shebang JS)가 이 파일의 main 을 불러 쓴다. 이 파일은 명령으로 실행될 때만 스스로 돈다.

import { readFileSync, statSync } from 'node:fs'
import { isMain, readStdin, write } from './io.ts'
import { PY_SPACE, normalizeNewlines, pyDecode, pyJson, pySplitLines, pyStrip } from './kit/py.ts'

const SPACE = PY_SPACE.slice(1, -1)

// 여는 괄호 안에서 다시 괄호가 열리고 닫히는 형태만 잡는다.
const NESTED_PAREN = /\([^()]*\([^()]*\)/

// 목록 항목. 이름과 설명을 엠대시로 나누는 용도가 규칙상 허용이라 DASH 검사에서 뺀다. \d 는 Python 처럼 유니코드 십진수다
const LIST_ITEM = new RegExp(`^(?:[-*+]|\\p{Nd}+\\.)[${SPACE}]`, 'u')

// 홈 경로의 물결표는 범위 표기가 아니다. \w 는 Python 처럼 유니코드 글자와 숫자와 밑줄이다
const HOME_PATH = /~\/[\p{L}\p{N}_./-]+/gu

// 검사 전에 줄에서 지울 것. 남기면 이들 안의 문자가 위반으로 잡힌다.
const CODE_SPAN = /`[^`]*`/g
const MD_LINK = /\[[^\]]*\]\([^)]*\)/g

const USAGE = `사용법:
    node check-readability.ts <파일.md> [<파일.md>...]
    node check-readability.ts --text "<제목이나 커밋 메시지>"
    node check-readability.ts --hook          PostToolUse 훅 모드 (stdin 으로 JSON)
`

export type Finding = { path: string; line: number; code: string; message: string }
export type MainOptions = { hookNotice?: string }

// 코드 스팬과 마크다운 링크를 지운다.
//
// 링크를 먼저 지운다. `[텍스트](경로)` 는 괄호를 품고 있어
// 코드 스팬만 지우면 중첩 괄호로 오인된다.
function stripNoise(line: string): string {
  return line.replace(MD_LINK, '').replace(CODE_SPAN, '')
}

// 줄 목록을 검사해 발견 목록을 반환한다. 순서는 만난 차례다. TILDE 는 단락이 끝날 때 더한다.
export function checkLines(path: string, lines: string[]): Finding[] {
  const found: Finding[] = []
  let inFence = false
  let inFront = false
  let para: [number, string][] = [] // 물결표는 단락 단위로 세야 한다. 취소선이 단락 안에서 짝지어지기 때문이다.

  const flush = () => {
    if (para.length) {
      const text = para.map(([, body]) => body).join(' ').replaceAll('\\~', '')
      const tildes = text.replace(HOME_PATH, '').split('~').length - 1
      if (tildes >= 2) found.push({ path, line: para[0][0], code: 'TILDE', message: '한 단락에 물결표가 2개 이상이다: 취소선으로 렌더될 수 있어 이스케이프하거나 표현을 바꾼다' })
    }
    para = []
  }

  lines.forEach((raw, index) => {
    const n = index + 1
    const stripped = pyStrip(raw)

    // YAML frontmatter 는 건너뛴다.
    // skill 과 agent 의 description 은 트리거 예시를 괄호로 감싸는 형식이라 규칙이 과적용된다.
    if (stripped === '---' && (n === 1 || inFront)) {
      inFront = n === 1
      return
    }
    if (inFront) return

    // 코드 블록 안은 통째로 건너뛴다.
    if (stripped.startsWith('```')) {
      inFence = !inFence
      flush()
      return
    }
    if (inFence) return

    // 표 행도 건너뛴다. 이미 구조화돼 있어 규칙이 과적용된다.
    if (stripped.startsWith('|')) return

    const line = stripNoise(raw)
    const body = pyStrip(line.replace(/^[> ]+/, ''))

    if (!body) {
      flush()
      return
    }

    para.push([n, body])

    if (NESTED_PAREN.test(line)) found.push({ path, line: n, code: 'NEST', message: '괄호 2겹 중첩: 별도 문장으로 나눈다' })

    if (line.includes('§')) found.push({ path, line: n, code: 'SECT', message: '§ 대신 섹션이나 장, 또는 번호를 쓴다' })

    // 엠대시. 목록 항목과 표 행에서 이름과 설명을 나누는 용도는 규칙이 허용한다.
    if (body.includes('—') && !LIST_ITEM.test(body)) {
      if (body.startsWith('#')) found.push({ path, line: n, code: 'DASH', message: '제목의 엠대시: 부제를 떼고 한 문장으로 쓴다' })
      else found.push({ path, line: n, code: 'DASH', message: '평문의 엠대시: 콜론이나 접속사로 바꾼다' })
    }
  })

  flush()
  return found
}

// 한 파일을 검사한다. 읽지 못하면 stderr 로 알리고 빈 목록을 돌려준다.
export function check(path: string): Finding[] {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    write(2, `${path}: 읽기 실패, ${(error as Error).message}\n`)
    return []
  }
  return checkLines(path, pySplitLines(normalizeNewlines(pyDecode(bytes))))
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

// PostToolUse 훅 모드의 판단. stdin 의 tool 입력 JSON 에서 편집된 파일 하나를 뽑아 검사하고,
// 위반이 있을 때만 모델 컨텍스트로 되돌릴 JSON 을 돌려준다. 없으면 null 이다. 작업을 막지 않는다.
// notice 가 있으면 additionalContext 맨 앞에 한 줄로 붙인다(옛 이름 진입의 안내).
export function runHook(input: string, notice?: string): object | null {
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    return null
  }
  const top = record(payload)
  if (!top) return null
  const field = (section: string, key: string) => record(top[section])?.[key]
  const target = field('tool_input', 'file_path') || field('tool_response', 'filePath')
  if (typeof target !== 'string' || !target.endsWith('.md')) return null

  const found = check(target)
  if (!found.length) return null

  const lines = found.map((f) => `${f.path}:${f.line}  경고 [${f.code}] ${f.message}`).join('\n')
  const context = '마크다운 가독성 경고 — 방금 편집한 파일에서 발견했다. 문맥을 보고 고칠지 판단한다.\n' + lines
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice ? `${notice}\n${context}` : context } }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// 명령 본체. stdout 과 stderr 에 직접 쓰고 종료 코드를 돌려준다. argv 는 명령 이름 뒤의 인자다.
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  if (argv.length < 1) {
    write(2, USAGE)
    return 2
  }

  if (argv[0] === '--hook') {
    let input = ''
    try {
      input = readStdin()
    } catch {
      return 0
    }
    const output = runHook(input, options.hookNotice)
    if (output) write(1, `${pyJson(output)}\n`)
    return 0
  }

  // 파일이 아닌 문자열도 검사한다. 제목과 커밋 메시지가 이 경로로 들어온다.
  if (argv[0] === '--text') {
    const text = argv.slice(1).join(' ')
    for (const f of checkLines('(문자열)', pySplitLines(normalizeNewlines(`${text}\n`)))) write(1, `(문자열)  경고 [${f.code}] ${f.message}\n`)
    return 0
  }

  const unknown = argv.filter((arg) => arg.startsWith('-'))
  if (unknown.length) {
    write(2, `check-readability: 다루지 않는 옵션이다: ${unknown.join(' ')}\n`)
    return 2
  }

  let missing = false
  const found: Finding[] = []
  for (const path of argv) {
    // 없는 경로를 0 으로 넘기면 오타 난 경로가 통과로 보인다.
    if (!isFile(path)) {
      write(2, `${path}: 파일이 없다\n`)
      missing = true
      continue
    }
    found.push(...check(path))
  }

  for (const f of found) write(1, `${f.path}:${f.line}  경고 [${f.code}] ${f.message}\n`)

  return missing ? 2 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = await main(process.argv.slice(2))
