// Claude Code 대화 기록(jsonl)을 읽는 공용 함수. 사용 기록 모드의 명령이 함께 쓴다.
//
// 대화 기록은 `$CLAUDE_CONFIG_DIR/projects` 에 있다. 설정이 없으면 `~/.claude/projects` 다.
// `~/.claude` 는 숨은 폴더라 `rg` 가 기본값으로 건너뛰어 0건이 나온다. 그래서 직접 순회한다.
//
// 한 파일에는 `user`, `assistant` 말고도 여러 레코드가 섞인다.
// `api-request-blob` 은 API 에 보낸 메시지를 통째로 다시 담아, 함께 세면 호출 수가 부풀려진다.
// `iterMessages` 는 `user`, `assistant` 레코드만 낸다.
//
// 대화 기록에는 비밀값이 섞인다. 발췌를 내는 곳은 `redact` 를 거치고, 출력은 세션 임시 폴더에만 둔다.

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { iterTextLinesReplace } from './io.ts'
import { pyHead, pyPathCompare } from './kit/py.ts'
import { exists, isDir, pathName, pathParent, pathParts, pathStem, pjoin, pyRepr, pyre, walk } from './pylike.ts'

export const MESSAGE_TYPES = ['user', 'assistant']
// JSON 을 해석하기 전에 거르는 빠른 검사. 최종 판정은 해석한 type 으로 한다
const MESSAGE_LINE = pyre(/"type":\s*"(?:user|assistant)"/)

// 흔한 토큰 형식과 `키=값` 꼴의 비밀값. 완전하지 않으므로 발췌는 여전히 세션 임시 폴더에만 둔다
const SECRET = pyre(
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,}|(?i:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)/gu,
)

export type Message = Record<string, any>

export function defaultProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME ?? homedir()}/.claude`
  return pjoin(base, 'projects')
}

export class DateError extends Error {}

// datetime.strptime(value, "%Y-%m-%d") 를 UTC 자정의 epoch 초로 바꾼다. 값이 없으면 null
export function parseSince(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^(\p{Nd}{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\p{Nd}|0[1-9]|[1-9]| [1-9])/u.exec(value)
  if (!m) throw new DateError(`time data ${pyRepr(value)} does not match format '%Y-%m-%d'`)
  if (m[0].length < value.length) throw new DateError(`unconverted data remains: ${value.slice(m[0].length)}`)
  const num = (s: string) => Number(s.trim().replace(/\p{Nd}/gu, (d) => String(digit(d))))
  const year = num(m[1])
  const month = num(m[2])
  const day = num(m[3])
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (year < 1) throw new DateError(`year ${year} is out of range`)
  if (day > last) throw new DateError(`day ${day} must be in range 1..${last} for month ${month} in year ${year}`)
  return Date.UTC(year, month - 1, day) / 1000
}

function digit(ch: string): number {
  let cp = ch.codePointAt(0)!
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30
  const start = cp
  while (/^\p{Nd}$/u.test(String.fromCodePoint(cp - 1))) cp--
  return (start - cp) % 10
}

// root 아래 jsonl 을 모두 낸다. since 보다 먼저 마지막으로 고친 파일은 건너뛴다
export function iterSessionFiles(root: string, since: number | null = null): string[] {
  const out: string[] = []
  for (const step of walk(root)) {
    for (const name of step.filenames) {
      if (!name.endsWith('.jsonl')) continue
      const path = pjoin(step.current, name)
      if (since !== null && statSync(path).mtimeMs / 1000 < since) continue
      out.push(path)
    }
  }
  return out
}

// user, assistant 레코드만 낸다. 깨진 줄은 건너뛴다
export function* iterMessages(path: string): Generator<Message> {
  for (const line of iterTextLinesReplace(path)) {
    if (!MESSAGE_LINE.test(line)) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record === 'object' && record !== null && !Array.isArray(record) && MESSAGE_TYPES.includes((record as Message).type)) yield record as Message
  }
}

export const isSubagent = (path: string): boolean => pathParts(path).includes('subagents')

// 하위 에이전트 기록도 주 세션 id 로 묶는다
export function sessionId(path: string, record?: Message | null): string {
  if (record && record.sessionId) return record.sessionId
  if (isSubagent(path)) return pathName(pathParent(pathParent(path)))
  return pathStem(path)
}

// 판정표에 적는 세션 표기. 앞 8자만 쓴다
export const shortId = (sid: string): string => pyHead(sid, 8)

export const redact = (text: string): string => text.replace(SECRET, '[가림]')

// 발췌가 커밋될 수 있는 자리인지 본다
export function insideGitWorktree(path: string): boolean {
  let probe = isDir(path) ? path : pathParent(path)
  while (!exists(probe)) probe = pathParent(probe)
  const done = spawnSync('git', ['-C', probe, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  if (done.error) throw done.error
  return done.status === 0 && done.stdout.trim() === 'true'
}

// 세션 id 앞부분으로 주 세션 파일을 찾는다
export function findSessionFiles(root: string, prefix: string): string[] {
  return iterSessionFiles(root)
    .filter((p) => !isSubagent(p) && pathStem(p).startsWith(prefix))
    .sort(pyPathCompare)
}

