#!/usr/bin/env node
// 본문에 고침 지시·초안 표시 문구가 남았는지 본다.
//
// 바뀐 곳만 적은 초안(「지금 본문 그대로」, 「표를 아래로 바꾼다」)을 그대로 등록하면
// 읽는 사람은 원문을 볼 수 없다. 등록 전에 이 검사를 돌려 그런 줄을 잡는다.
// 정상 문장 오탐을 줄이려고 문구를 좁게 두고, 코드 블록과 인라인 코드 안은 건너뛴다.
//
// 사용법: node leak-check.ts <파일.md> [<파일.md>...]
//   0  통과
//   1  고침 지시 문구 발견. 걸린 줄을 `파일:줄: 내용` 으로 낸다
//   2  인자가 없거나 파일을 읽지 못함

import { readFileSync } from 'node:fs'
import { isMain, write } from './io.ts'

// 문구를 늘릴 때는 걸리면 안 되는 정상 문장도 테스트에 함께 더한다
export const PATTERNS: { name: string; re: RegExp }[] = [
  { name: '본문 그대로 표시', re: /(?:지금|현재|기존)\s*(?:본문|내용|문장|표)\s*(?:은\s*|는\s*)?(?:그대로|동일)(?:\s*(?:둔다|유지|이다|임))?\s*$|(?:지금|현재|기존)\s*(?:본문|내용)\s*그대로/ },
  { name: '표 고침 지시', re: /표를\s*(?:아래|위)(?:와\s*같이|로)\s*(?:바꾼다|고친다|바꿔)/ },
  { name: '행·줄 추가 지시', re: /(?:아래|위)\s*(?:행|줄|문장|항목)을?\s*(?:더한다|추가한다|넣는다)/ },
  { name: '여기에 넣는다 지시', re: /여기에\s+[^.\n]{1,40}?\s*(?:넣는다|붙인다|추가한다)\s*[.。]?\s*$/ },
  { name: '(고침) 표시', re: /\(고침\)/ },
]

export type Hit = { line: number; text: string; rule: string }

export function findLeaks(body: string): Hit[] {
  const hits: Hit[] = []
  let fence = ''
  body.split('\n').forEach((raw, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(raw)
    if (m) {
      if (!fence) fence = m[1][0]
      else if (m[1][0] === fence) fence = ''
      return
    }
    if (fence) return
    const text = raw.replace(/`[^`]*`/g, '')
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) {
        hits.push({ line: i + 1, text: raw.trim(), rule: name })
        break
      }
    }
  })
  return hits
}

export function main(argv: string[]): number {
  if (argv.length === 0) {
    write(2, '검사할 파일이 필요하다\n')
    return 2
  }
  let code = 0
  for (const file of argv) {
    let body: string
    try {
      body = readFileSync(file, 'utf8')
    } catch (error) {
      write(2, `${file}: ${(error as Error).message}\n`)
      return 2
    }
    for (const h of findLeaks(body)) {
      write(1, `${file}:${h.line}: [${h.rule}] ${h.text}\n`)
      code = 1
    }
  }
  if (code) write(2, '고침 지시 문구가 본문에 남았다. 바뀐 곳만 적은 초안이면 본문 전체로 다시 쓴다.\n')
  return code
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
