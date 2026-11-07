#!/usr/bin/env node
// 대화 기록에서 스킬 호출과 호출 뒤의 마찰 신호를 세어 스킬별 요약을 낸다.
//
// 사용법:
//     extract_skill_usage.ts [--skill NAME ...] [--since YYYY-MM-DD] [--projects DIR] [--out DIR] [--samples N]
//
// --skill    셀 스킬. 여러 번 줄 수 있고 `fos-skills:plan` 처럼 접두사가 붙어도 된다. 없으면 모든 스킬을 센다
// --since    그날(UTC) 이후의 호출만 센다
// --projects 대화 기록 폴더. 기본값은 `session_log.ts 의 defaultProjectsDir()` 이다
// --out      호출별 기록을 쓸 폴더. 세션 임시 폴더를 준다. git 작업 트리 안이면 거부한다
// --samples  마찰 점수가 높은 호출 N건을 세션 id 앞 8자와 시각으로 표준 출력에 낸다(기본 0)
//
// 호출은 Skill 도구 호출과 `/이름` 슬래시 명령을 함께 센다.
// 호출부터 다음 스킬 호출 전까지의 대화를 그 호출의 구간으로 보고 다음을 센다.
//     with_correction  정정으로 보이는 사용자 발화가 있었던 호출 수
//     with_interrupt   사용자가 중단한 호출 수
//     tool_errors      구간 안의 도구 오류 합
//     reinvoked        같은 스킬을 바로 다시 부른 호출 수
//     friction         아래 점수의 합
//
// 점수는 `정정×3 + 중단×3 + 도구 오류 + 재호출×2` 다.
// **점수는 읽을 표본을 고르는 데만 쓴다. 판정 근거로 쓰지 않는다.**
// 정정 정규식은 「다시」 같은 평범한 말과 critic 회신의 「REVISE」 에 거짓 양성이 많다.
// 판정은 `render_session.ts` 로 실제로 읽은 세션에만 근거를 둔다.
//
// 표준 출력에는 집계와 세션 표기만 나가고 발화 발췌는 나가지 않는다.
// --out 을 주면 그 폴더에 다음을 쓴다. 발췌는 `session_log.ts 의 redact` 를 거치지만 비밀값이 남을 수 있다.
//     invocations.jsonl  호출 한 건마다 한 줄. 파일 경로, 모델, 마찰 신호, 호출 뒤 사용자 발화 표본
//     sessions.jsonl     주 세션마다 첫 사용자 요청과 쓴 스킬. 스킬이 덮지 못한 반복 작업을 찾는 데 쓴다
//
// 종료 코드
//     0  집계를 마쳤다. 호출이 0건이어도 0 이다. 출력의 `calls` 로 판정한다
//     2  인자 오류, 대화 기록 폴더가 없음, --out 이 git 작업 트리 안
//

import { mkdirSync, writeFileSync } from 'node:fs'
import { isMain, write } from './io.ts'
import { type Spec, parseCli, UsageError } from './cli.ts'
import { pyHead, pyJson, pyStrCompare, pyStrip } from './kit/py.ts'
import { DateError, defaultProjectsDir, insideGitWorktree, isSubagent, iterMessages, iterSessionFiles, parseSince, redact, sessionId, shortId } from './session_log.ts'
import { isDir, parsePyInt, pjoin, pyPath, pyre } from './pylike.ts'

const CORRECTION = pyre(/(아니|왜 |왜(?=\n?$)|다시|말고|틀렸|잘못|하지 ?마|안 ?돼|안 ?되|그게 아니|이상하|멈춰|stop|wrong|not what)/iu)
const INTERRUPT = '[Request interrupted'
const COMMAND = /<command-name>\/([^<]+)<\/command-name>/gu
const NOISE = ['<system-reminder>', '<task-notification>', '<local-command', 'Caveat:', '[SYSTEM NOTIFICATION']
const COLUMNS = ['calls', 'main', 'with_correction', 'with_interrupt', 'tool_errors', 'reinvoked', 'friction'] as const

const USAGE =
  'usage: extract_skill_usage.ts [--skill SKILL] [--since SINCE] [--projects PROJECTS] [--out OUT]\n' +
  '                              [--samples SAMPLES]\n'

const SPEC: Spec = {
  help: false,
  options: [
    { name: 'skill', value: true, append: true },
    { name: 'since', value: true },
    { name: 'projects', value: true },
    { name: 'out', value: true },
    { name: 'samples', value: true, int: true },
  ],
  positionals: [],
}

type Event = [string, Record<string, any>]
type Meta = { cwd: string | null; model: string | null; first_user: string | null; session: string | null }
type Invocation = Record<string, any>

// `fos-skills:plan` 처럼 플러그인 접두사가 붙은 이름을 스킬 이름만 남긴다
const norm = (name: string): string => pyStrip(name).split(':').at(-1)!

const isDict = (c: unknown): c is Record<string, any> => typeof c === 'object' && c !== null && !Array.isArray(c)

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => isDict(c) && c.type === 'text').map((c) => c.text ?? '').join('\n')
}

const toolErrors = (content: unknown): number => (Array.isArray(content) ? content.filter((c) => isDict(c) && c.type === 'tool_result' && c.is_error).length : 0)

const hasToolResult = (content: unknown): boolean => Array.isArray(content) && content.some((c) => isDict(c) && c.type === 'tool_result')

function isHuman(text: string): boolean {
  const t = pyStrip(text)
  return Boolean(t) && !NOISE.some((n) => t.startsWith(n))
}

// 파일 하나를 호출, 사용자 발화, 중단, 도구 오류, 어시스턴트 턴의 순서열로 바꾼다
function readEvents(path: string): [Event[], Meta] {
  const events: Event[] = []
  const meta: Meta = { cwd: null, model: null, first_user: null, session: null }
  const seenToolUse = new Set<unknown>()
  for (const record of iterMessages(path)) {
    const message = record.message || {}
    meta.cwd = meta.cwd || record.cwd || null
    meta.session = meta.session || sessionId(path, record)
    const ts = record.timestamp || ''
    const content = message.content
    if (record.type === 'assistant') {
      meta.model = message.model || meta.model
      for (const c of Array.isArray(content) ? content : []) {
        if (!(isDict(c) && c.type === 'tool_use' && c.name === 'Skill')) continue
        // 같은 메시지가 레코드 둘에 다시 실리는 경우가 있어 tool_use id 로 한 번만 센다
        const id = c.id ?? null
        if (seenToolUse.has(id)) continue
        seenToolUse.add(id)
        const args = c.input || {}
        events.push(['skill', { skill: norm(args.skill ?? ''), ts, model: meta.model, via: 'tool' }])
      }
      events.push(['assistant', {}])
      continue
    }
    const text = userText(content)
    for (const m of text.matchAll(COMMAND)) events.push(['skill', { skill: norm(m[1]), ts, model: meta.model, via: 'slash' }])
    const errors = toolErrors(content)
    if (errors) events.push(['err', { n: errors }])
    if (text.includes(INTERRUPT)) {
      events.push(['interrupt', {}])
    } else if (isHuman(text) && !hasToolResult(content) && !new RegExp(COMMAND.source, 'u').test(text) && !record.isMeta) {
      events.push(['human', { text, ts }])
      if (meta.first_user === null) meta.first_user = text
    }
  }
  return [events, meta]
}

// 대상 스킬 호출마다 마찰 신호를 붙인 기록을 낸다
function invocations(path: string, events: Event[], meta: Meta, skills: Set<string> | null, sinceIso: string | undefined): Invocation[] {
  const out: Invocation[] = []
  events.forEach(([kind, payload], i) => {
    if (kind !== 'skill') return
    if (skills && !skills.has(payload.skill)) return
    if (sinceIso && payload.ts < sinceIso) return
    const humans: string[] = []
    let corrections = 0
    let interrupts = 0
    let errors = 0
    let turns = 0
    let reinvoked = false
    for (const [kind2, payload2] of events.slice(i + 1)) {
      if (kind2 === 'skill') {
        reinvoked = payload2.skill === payload.skill
        break
      }
      if (kind2 === 'human') {
        humans.push(payload2.text)
        corrections += CORRECTION.test(payload2.text) ? 1 : 0
      } else if (kind2 === 'interrupt') interrupts++
      else if (kind2 === 'err') errors += payload2.n
      else if (kind2 === 'assistant') turns++
    }
    out.push({
      ...payload,
      session: meta.session,
      file: path,
      cwd: meta.cwd,
      subagent: isSubagent(path),
      humans: humans.slice(0, 15).map((h) => redact(pyHead(h, 400))),
      n_humans: humans.length,
      corrections,
      interrupts,
      tool_errors: errors,
      reinvoked,
      assistant_turns: turns,
      friction: corrections * 3 + interrupts * 3 + errors + (reinvoked ? 2 : 0),
    })
  })
  return out
}

function summarize(records: Invocation[]): Map<string, Record<(typeof COLUMNS)[number], number>> {
  const agg = new Map<string, Record<(typeof COLUMNS)[number], number>>()
  for (const r of records) {
    if (!agg.has(r.skill)) agg.set(r.skill, { calls: 0, main: 0, with_correction: 0, with_interrupt: 0, tool_errors: 0, reinvoked: 0, friction: 0 })
    const a = agg.get(r.skill)!
    a.calls += 1
    a.main += r.subagent ? 0 : 1
    a.with_correction += r.corrections ? 1 : 0
    a.with_interrupt += r.interrupts ? 1 : 0
    a.tool_errors += r.tool_errors
    a.reinvoked += r.reinvoked ? 1 : 0
    a.friction += r.friction
  }
  return agg
}

export function main(argv: string[]): number {
  let parsed
  let since: number | null
  try {
    parsed = parseCli(argv, SPEC)
    since = parseSince(parsed.options.since as string | undefined)
  } catch (error) {
    if (error instanceof UsageError) {
      write(2, `${USAGE}extract_skill_usage.ts: error: ${error.message}\n`)
      write(2, '인자 오류: 2. 사용법은 이 파일의 머리 주석에 있다\n')
      return 2
    }
    if (error instanceof DateError) {
      write(2, `인자 오류: ${error.message}. 사용법은 이 파일의 머리 주석에 있다\n`)
      return 2
    }
    throw error
  }
  const projects = parsed.options.projects === undefined ? defaultProjectsDir() : pyPath(parsed.options.projects as string)
  const out = parsed.options.out === undefined ? null : pyPath(parsed.options.out as string)
  const samples = parsed.options.samples === undefined ? 0 : parsePyInt(parsed.options.samples as string)
  const sinceArg = parsed.options.since as string | undefined
  if (!isDir(projects)) {
    write(2, `대화 기록 폴더가 없다: ${projects}\n`)
    return 2
  }
  if (out !== null && insideGitWorktree(out)) {
    write(2, `--out 이 git 작업 트리 안이다. 발췌가 커밋될 수 있어 거부한다: ${out}\n`)
    return 2
  }

  const names = ((parsed.options.skill as string[] | undefined) ?? []).map(norm)
  const skills = names.length ? new Set(names) : null
  const records: Invocation[] = []
  const sessions: Record<string, unknown>[] = []
  let files = 0
  for (const path of iterSessionFiles(projects, since)) {
    files++
    const [events, meta] = readEvents(path)
    records.push(...invocations(path, events, meta, skills, sinceArg))
    if (out !== null && !isSubagent(path) && meta.first_user) {
      sessions.push({
        session: meta.session,
        file: path,
        cwd: meta.cwd,
        model: meta.model,
        first_user: redact(pyHead(meta.first_user, 300)),
        skills: [...new Set(events.filter(([kind]) => kind === 'skill').map(([, e]) => e.skill as string))].sort(pyStrCompare),
      })
    }
  }

  if (out !== null) {
    mkdirSync(out, { recursive: true })
    writeFileSync(pjoin(out, 'invocations.jsonl'), records.map((r) => `${pyJson(r)}\n`).join(''))
    writeFileSync(pjoin(out, 'sessions.jsonl'), sessions.map((s) => `${pyJson(s)}\n`).join(''))
  }

  let text = `# 읽은 파일 ${files}, 호출 ${records.length}\n`
  text += `skill\t${COLUMNS.join('\t')}\n`
  for (const [name, a] of [...summarize(records)].sort((x, y) => y[1].calls - x[1].calls)) text += `${name}\t${COLUMNS.map((c) => a[c]).join('\t')}\n`
  if (samples) {
    text += '\n# 마찰 점수 상위 호출. 점수는 표본을 고르는 데만 쓴다\n'
    text += 'session\ttimestamp\tskill\tfriction\n'
    for (const r of [...records].sort((x, y) => y.friction - x.friction).slice(0, samples)) {
      text += `${shortId(r.session)}\t${pyHead(r.ts, 19)}\t${r.skill}\t${r.friction}\n`
    }
  }
  write(1, text)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
