// hook 이 Bash 명령을 볼 때 명령이 아닌 글자를 가리고, 명령 조각으로 나눈다.
//
// 커밋 메시지, heredoc 본문, 주석에 든 `cd x;`, `git push`, `--wait ... &` 는 실행되는 명령이 아니다.
// 그런 글자로 거부하면 정상 호출이 막힌다(2026-10-21 heredoc 본문의 `check --wait` 와 `&` 로 거부된 일이 있었다).
//
//     stripHeredocs  heredoc 본문과 끝 표지 줄을 지운다. 여는 줄은 남긴다
//     mask           따옴표 안, 주석, 리다이렉션(`2>&1`, `&>`)을 같은 길이의 다른 글자로 바꾼다.
//                    위치가 그대로라 가린 글에서 찾은 자리로 원문의 값을 읽을 수 있다
//     pieces         가린 글을 `&&`, `||`, `;`, `|`, `&`, 줄바꿈으로 나눈 { join, start, end } 목록.
//                    join 은 앞 연결자이고 첫 조각은 null 이다. 연산자 뒤 줄바꿈은 이어 쓰기라 나누지 않는다
//     hookCommand    stdin 의 hook JSON 에서 Bash 명령을 읽는다. 읽지 못한 입력이나 Bash 가 아닌 도구는 null 이다.
//                    command 가 문자열이 아니면 빈 문자열이다. hook 은 null 이면 통과시킨다

import { readFileSync } from 'node:fs'

// `<<<` here-string, `$((1<<2))` 같은 시프트는 heredoc 이 아니다
const HEREDOC = /(?<![<\w])<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/
// 줄 잇기(역슬래시 줄바꿈)는 지운 뒤라 `\\[^\n]` 가 이스케이프 한 글자다
export const QUOTED = /'[^']*'|"(?:\\[^\n]|[^"\\])*"/g
const COMMENT = /(?:(?<=\s)|^)#[^\n]*/gm
const REDIRECT = /\d*>&\d*-?|&>>?|<&\d*-?/g
const CONTINUED = /(&&|\|\||\|)([ \t]*\n)+/g
const OPERATOR = /&&|\|\||\|&|;|\n|\||&/g

export type Piece = { join: string | null; start: number; end: number }

export function stripHeredocs(command: string): string {
  const out: string[] = []
  let end: string | null = null
  for (const line of command.replaceAll('\\\n', ' ').split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null
      continue
    }
    out.push(line)
    const m = HEREDOC.exec(line)
    if (m) end = m[2]
  }
  return out.join('\n')
}

export function mask(text: string): string {
  const blank = (s: string) => s[0] + '_'.repeat(s.length - 2) + s[s.length - 1]
  const spaces = (s: string) => ' '.repeat(s.length)
  let masked = text.replace(QUOTED, blank)
  masked = masked.replace(COMMENT, spaces)
  masked = masked.replace(REDIRECT, spaces)
  // 연산자 뒤 줄바꿈은 같은 길이의 공백으로 바꿔 한 명령으로 잇는다
  return masked.replace(CONTINUED, (all: string, op: string) => op + ' '.repeat(all.length - op.length))
}

export function pieces(masked: string): Piece[] {
  const out: Piece[] = []
  let start = 0
  let join: string | null = null
  for (const m of masked.matchAll(OPERATOR)) {
    out.push({ join, start, end: m.index })
    join = m[0]
    start = m.index + m[0].length
  }
  out.push({ join, start, end: masked.length })
  return out
}

export function hookCommand(): string | null {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const hook = data as { tool_name?: unknown; tool_input?: { command?: unknown } | null }
  if (hook.tool_name !== 'Bash') return null
  const command = hook.tool_input?.command
  return typeof command === 'string' ? command : ''
}
