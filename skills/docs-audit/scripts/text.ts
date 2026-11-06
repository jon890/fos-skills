// 두 명령이 함께 쓰는 Python 꼴 문자열 함수와 출력, 진입 판정.
// Python 의 str.splitlines, str.strip, 정규식 \s 와 같은 글자를 공백과 줄 끝으로 본다(JS 의 \s 와 \x1c~\x1f, \x85, \ufeff 가 다르다).

import { writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// str 정규식의 \s 와 str.isspace 가 공백으로 보는 글자의 클래스
export const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const STRIP = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')
const RSTRIP = new RegExp(`${SPACE}+$`)

export const strip = (text: string) => text.replace(STRIP, '')
export const rstrip = (text: string) => text.replace(RSTRIP, '')

// str.splitlines(). \n, \r\n, \r 말고도 \v, \f, \x1c, \x1d, \x1e, \x85, \u2028, \u2029 에서 나누고, 끝이 줄바꿈이면 빈 줄을 더하지 않는다
export function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  if (parts.at(-1) === '') parts.pop()
  return parts
}

export function write(fd: 1 | 2, text: string): void {
  let buf = Buffer.from(text)
  while (buf.length) {
    try {
      buf = buf.subarray(writeSync(fd, buf))
    } catch (error) {
      // 파이프가 가득 찼다. 비워질 때까지 다시 쓴다
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
    }
  }
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
export function isMain(url: string, flag: boolean | undefined): boolean {
  return Boolean(flag) || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url))
}
