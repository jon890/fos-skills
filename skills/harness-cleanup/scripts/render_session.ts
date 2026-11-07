#!/usr/bin/env node
// 대화 기록 한 세션을 읽기 쉬운 텍스트로 줄여 파일에 쓴다.
//
// 사용법:
//     render_session.ts SESSION --out FILE [--from TIMESTAMP] [--max-chars N] [--projects DIR]
//
// SESSION 은 jsonl 파일 경로나 세션 id 앞부분이다(`extract_skill_usage.ts --samples` 가 내는 8자).
// id 로 주면 --projects(기본값은 `session_log.ts 의 defaultProjectsDir()`)에서 주 세션 파일을 찾는다.
// --from 을 주면 그 timestamp 부터 쓴다. `--samples` 가 낸 시각을 그대로 준다.
// --max-chars 는 쓸 최대 글자 수다(기본 60000).
//
// 사용자 발화, 어시스턴트 텍스트, 도구 호출(이름과 입력 앞부분), 도구 오류만 남긴다.
// `user`, `assistant` 레코드만 읽는다. 다른 레코드는 같은 메시지를 다시 담아 중복된다.
//
// 대화 기록에는 비밀값이 섞인다. 출력은 `session_log.ts 의 redact` 를 거치지만 다 가리지 못한다.
// 그래서 표준 출력으로 내지 않고 --out 파일에만 쓴다. 세션 임시 폴더를 주고, git 작업 트리 안이면 거부한다.
// 판정표에는 발췌를 옮기지 않고 세션 id 앞 8자와 시각만 적는다.
//
// 종료 코드
//     0  썼다. 마지막 줄이 `... (잘림)` 이면 --max-chars 에서 끊었다
//     2  인자 오류, 세션을 찾지 못함, id 앞부분에 맞는 세션이 둘 이상, --out 이 git 작업 트리 안
//

import { mkdirSync, writeFileSync } from 'node:fs'
import { isMain, write } from './io.ts'
import { type Spec, parseCli, UsageError } from './cli.ts'
import { pyHead, pyJson, pyLen, pyStrip } from './kit/py.ts'
import { defaultProjectsDir, findSessionFiles, insideGitWorktree, iterMessages, redact } from './session_log.ts'
import { isDir, isFile, parsePyInt, pathParent, pyPath, pyRepr } from './pylike.ts'

const USAGE = 'usage: render_session.ts [--out OUT] [--from START] [--max-chars MAX_CHARS] [--projects PROJECTS]\n                       session\n'

const SPEC: Spec = {
  help: false,
  options: [
    { name: 'out', value: true, required: true },
    { name: 'from', value: true },
    { name: 'max-chars', value: true, int: true },
    { name: 'projects', value: true },
  ],
  positionals: [{ name: 'session', nargs: 1 }],
}

const isDict = (c: unknown): c is Record<string, any> => typeof c === 'object' && c !== null && !Array.isArray(c)

// str(value). 도구 오류 본문이 문자열이 아닐 때의 글자다
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return value
  return typeof value === 'object' ? pyJson(value) : String(value)
}

function parts(content: unknown): [string, string][] {
  if (typeof content === 'string') return [['text', content]]
  const out: [string, string][] = []
  for (const c of Array.isArray(content) ? content : []) {
    if (!isDict(c)) continue
    const kind = c.type
    if (kind === 'text') {
      out.push(['text', c.text ?? ''])
    } else if (kind === 'tool_use') {
      out.push(['tool', `${pyStr(c.name)} ${pyHead(pyJson(c.input ?? null), 400)}`])
    } else if (kind === 'tool_result' && c.is_error) {
      let body = c.content
      if (Array.isArray(body)) body = body.filter(isDict).map((x) => x.text ?? '').join(' ')
      out.push(['error', pyHead(pyStr(body), 500)])
    }
  }
  return out
}

function render(path: string, start: string | undefined, limit: number): string[] {
  const lines: string[] = []
  let size = 0
  for (const record of iterMessages(path)) {
    const ts: string = record.timestamp || ''
    if (start && ts < start) continue
    const role = record.type
    for (const [kind, raw] of parts((record.message || {}).content)) {
      let text = pyStrip(raw)
      if (!text) continue
      let label: string
      if (role === 'user' && kind === 'text') {
        if (text.startsWith('<system-reminder>')) continue
        label = 'USER'
        text = pyHead(text, 1500)
      } else if (kind === 'text') {
        label = 'ASSISTANT'
        text = pyHead(text, 1200)
      } else if (kind === 'tool') {
        label = 'TOOL'
      } else {
        label = 'TOOL_ERROR'
      }
      const line = redact(`[${Array.from(ts).slice(5, 19).join('')}] ${label}: ${text}`)
      lines.push(line)
      size += pyLen(line)
      if (size > limit) {
        lines.push('... (잘림)')
        return lines
      }
    }
  }
  return lines
}

function resolve(session: string, projects: string): string | null {
  const path = pyPath(session)
  if (isFile(path)) return path
  const found = isDir(projects) ? findSessionFiles(projects, session) : []
  if (found.length === 1) return found[0]
  write(2, `세션 ${pyRepr(session)} 에 맞는 파일이 ${found.length}개다. 파일 경로나 더 긴 id 를 준다\n`)
  return null
}

export function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseCli(argv, SPEC)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    write(2, `${USAGE}render_session.ts: error: ${error.message}\n`)
    write(2, '인자 오류. 사용법은 이 파일의 머리 주석에 있다\n')
    return 2
  }
  const out = pyPath(parsed.options.out as string)
  const projects = parsed.options.projects === undefined ? defaultProjectsDir() : pyPath(parsed.options.projects as string)
  const maxChars = parsed.options['max-chars'] === undefined ? 60000 : parsePyInt(parsed.options['max-chars'] as string)
  if (insideGitWorktree(out)) {
    write(2, `--out 이 git 작업 트리 안이다. 발췌가 커밋될 수 있어 거부한다: ${out}\n`)
    return 2
  }
  const path = resolve(parsed.positionals.session as string, projects)
  if (path === null) return 2
  const lines = render(path, parsed.options.from as string | undefined, maxChars)
  mkdirSync(pathParent(out), { recursive: true })
  writeFileSync(out, `${lines.join('\n')}\n`)
  write(1, `${out}: ${lines.length}줄\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
