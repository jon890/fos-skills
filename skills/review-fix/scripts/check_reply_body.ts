#!/usr/bin/env node
// 리뷰 회신 본문이 봇을 다시 부르거나 무관한 PR 을 참조하는지 본다.
//
// 사용법:
//   node check_reply_body.ts <본문파일> [<본문파일>...]
//
// 종료 코드:
//   0  걸린 것이 없다
//   1  걸린 것이 있다
//   2  파일을 읽지 못했다
//
// 코드 스팬 안은 검사하지 않는다. 백틱으로 감싼 것이 이 문제를 피하는 방법이라
// 감싼 것까지 걸면 고친 본문이 다시 걸린다.
//
// 재트리거 토큰
//   봇 워크플로의 `if:` 조건이 본문을 부분 문자열로 맞춰 본다.
//   회신 본문이 `## /review 반영 완료` 로 시작하면 `/review` 를 찾는 issue_comment 트리거가 발동한다.
//
// auto-link
//   GitHub 이 `#숫자`, `GH-숫자`, `owner/repo#숫자` 를 자동으로 링크한다.
//   리뷰 항목 번호를 그대로 쓰면 무관한 PR 의 timeline 에 알림이 간다.
//
// 정규식은 옛 Python(str 패턴)과 같은 글자를 잡는다. Python 의 \w, \d, \b, \s 는 유니코드 뜻이라
// JS 의 것을 쓰지 않고 문자 클래스로 풀어 쓴다. 그래서 `/review반영` 처럼 한글이 붙은 토큰은 낱말의 일부라 걸리지 않는다.

import { readFileSync } from 'node:fs'
import { isMain, write } from './io.ts'
import { normalizeNewlines, PY_SPACE, pyDecode } from './kit/py.ts'

// \w, \d 와 \b 의 앞뒤 경계(lookaround)
const W = '[\\p{L}\\p{N}_]'
const NOT_W_AFTER = `(?!${W})`
const NOT_W_BEFORE = `(?<!${W})`

const TRIGGER = new RegExp(`(?:/review|@claude|@github-actions|@dependabot)${NOT_W_AFTER}`, 'gu')
const NAME = '[\\p{L}\\p{N}_.-]+'
const AUTOLINK = new RegExp(`(?:${NAME}/${NAME})?#\\p{Nd}+|${NOT_W_BEFORE}GH-\\p{Nd}+${NOT_W_AFTER}`, 'gu')
const CODE_SPAN = /`[^`\n]*`/g
const FENCE = new RegExp(`^${PY_SPACE}*\`\`\``)

type Finding = [lineno: number, kind: string, text: string]

// 줄바꿈은 \n, \r\n, \r 만 줄로 센다. 파일을 줄 단위로 읽는 Python 과 같다
export function findings(bytes: Uint8Array): Finding[] {
  const text = normalizeNewlines(pyDecode(bytes))
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const out: Finding[] = []
  let inFence = false
  lines.forEach((raw, index) => {
    const lineno = index + 1
    if (FENCE.test(raw)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const line = raw.replace(CODE_SPAN, '')
    for (const [kind, pattern] of [['재트리거 토큰', TRIGGER], ['auto-link', AUTOLINK]] as const) {
      for (const m of line.matchAll(pattern)) out.push([lineno, kind, m[0]])
    }
  })
  return out
}

const USAGE = `사용법:
    check_reply_body.ts <본문파일> [<본문파일>...]

종료 코드:
    0  걸린 것이 없다
    1  걸린 것이 있다
    2  파일을 읽지 못했다
`

export function main(args: string[]): number {
  if (args.length < 1) {
    write(2, USAGE)
    return 2
  }
  let hit = false
  for (const path of args) {
    let bytes: Uint8Array
    try {
      bytes = readFileSync(path)
    } catch (error) {
      write(2, `읽지 못했다: ${(error as Error).message}\n`)
      return 2
    }
    // UTF-8 이 아닌 바이트는 읽기 실패가 아니다. 옛 Python 처럼 오류로 멈춘다(종료 코드 1)
    for (const [lineno, kind, text] of findings(bytes)) {
      hit = true
      write(1, `${path}:${lineno}: ${kind} \`${text}\`\n`)
    }
  }
  if (hit) {
    write(1, '\n의도한 참조면 백틱으로 감싸고, 아니면 평문으로 바꾼다.\n이미 등록한 댓글이면 gh api 로 body 를 PATCH 한다.\n')
    return 1
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
