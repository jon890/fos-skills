#!/usr/bin/env node
// gh-review-list.ts 가 받은 리뷰 댓글 JSON 을 사람이 읽을 형태로 출력한다.
//
// 사용법: node render-comments.ts <json파일> <thread id 또는 빈문자열> <0|1 내 것만> <내 로그인>
//
// 종료 코드: 0 낸다, 1 인자가 모자라거나 파일을 읽지 못했다

import { readFileSync } from 'node:fs'

import { pyHead, pyLen, pyStr } from './kit/py.ts'
import { write } from './gh-host.ts'
import { isMainModule } from './is-main.ts'

export type Comment = { id: number; in_reply_to_id?: number | null; user: { login: string }; path: string; line?: number | null; body: string }

// f"{값:<16}" 처럼 코드 포인트 수로 왼쪽 정렬한다
function padRight(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - pyLen(text)))
}

export function renderComments(all: Comment[], thread: string, mine: boolean, me: string): string {
  let rows = all
  if (thread) rows = rows.filter((r) => String(r.id) === thread || pyStr(r.in_reply_to_id) === thread)
  if (mine) rows = rows.filter((r) => r.user.login === me)
  let out = `댓글 ${rows.length}건\n주의: line 이 null 인 댓글은 이 목록에서 빠질 수 있다. 개수로 등록 성공을 판정하지 않는다.\n\n`
  for (const r of rows) {
    const kind = r.in_reply_to_id ? '답글' : '루트'
    const head = pyHead(r.body.split('\n')[0], 50)
    const name = r.path.split('/').at(-1)
    out += `${kind} ${r.id}  ${padRight(r.user.login, 16)} ${name}:${pyStr(r.line)}\n     ${head}\n`
  }
  return out
}

export function main(argv: string[]): number {
  if (argv.length < 4) {
    write(2, '사용법: render-comments.ts <json파일> <thread id 또는 빈문자열> <0|1 내 것만> <내 로그인>\n')
    return 1
  }
  const [path, thread, mine, me] = argv
  let rows: Comment[]
  try {
    rows = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    write(2, `render-comments: ${(error as Error).message}\n`)
    return 1
  }
  write(1, renderComments(rows, thread, mine === '1', me))
  return 0
}

const isMain = isMainModule(import.meta.url, import.meta.main)
if (isMain) process.exitCode = main(process.argv.slice(2))
