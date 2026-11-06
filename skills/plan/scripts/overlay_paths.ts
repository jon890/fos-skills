#!/usr/bin/env node
// 작업 대상 하위 프로젝트를 정하고 레포 설정을 읽을 순서를 낸다.
//
// 판정 규칙은 references/monorepo.md 가 소유한다. 이 스크립트는 그 규칙을 그대로 실행한다.
// plan, implementation, docs-audit, review-fix 가 함께 쓴다.
//
// 사용법:
//     node overlay_paths.ts --skill review-fix [--sub DIR] [--plan NAME] [PATH ...]
//     gh pr diff 12 --name-only | node overlay_paths.ts --skill review-fix -
//
// PATH 는 변경 파일 경로다. 저장소 루트 기준이고, `-` 를 주면 표준 입력에서 한 줄에 하나씩 읽는다.
// cwd 는 대상 저장소 안이어야 한다. cwd 가 하위 프로젝트 안이면 그것도 판정 근거로 쓴다.
//
// 출력은 JSON 이다.
//     monorepo      하위 프로젝트 오버레이가 하나라도 있는가
//     subprojects   오버레이를 가진 하위 프로젝트 목록
//     targets       대상 하위 프로젝트. 둘 이상이면 변경이 걸친 것이다
//     reason        무엇으로 정했나. user, plan, paths, cwd, single 중 하나
//     search        대상마다 레포 설정을 읽을 순서. 없는 파일도 순서대로 낸다
//
// 종료 코드
//     0  대상을 정했다. 단일 저장소도 여기다
//     1  모노레포인데 대상을 정하지 못했다. 사용자에게 묻는다
//     2  실행하지 못했다. 저장소가 아니거나 --sub 가 하위 프로젝트가 아니다

import { readdirSync, statSync } from 'node:fs'
import { capture, isMain, readStdin, readTextFile, ValueError, write } from './io.ts'
import { type Spec, parseCli, UsageError } from './cli.ts'
import { fnmatchcase, pathParts, pyResolve } from './pylike.ts'
import { pyStrCompare, pyStrip } from './kit/py.ts'

// 오버레이의 「저장소 배치」 표에서 plan 접두사를 읽는다. 형식은 references/monorepo.md 가 정한다
const PREFIX_ROW = /(?<![^\n])\|\s*plan 접두사\s*\|\s*`([^`]+)`\s*\|/
const HARNESS = ['AGENTS.md', 'CLAUDE.md']
const ALIASES: Record<string, string> = { plan: 'planning', implementation: 'build-with-teams', 'docs-audit': 'docs-check' }

const USAGE = `usage: overlay_paths.ts [-h] --skill SKILL [--sub SUB] [--plan PLAN] [paths ...]

작업 대상 하위 프로젝트를 정하고 레포 설정을 읽을 순서를 낸다.

positional arguments:
  paths        변경 파일 경로. - 면 표준 입력에서 읽는다

options:
  -h, --help   show this help message and exit
  --skill SKILL  오버레이 파일 이름에 쓰는 스킬 이름
  --sub SUB    사용자가 지정한 하위 프로젝트 디렉터리
  --plan PLAN  plan 디렉터리 이름. 접두사로 하위 프로젝트를 정한다
`

const SPEC: Spec = {
  options: [
    { name: 'skill', value: true, required: true },
    { name: 'sub', value: true },
    { name: 'plan', value: true },
  ],
  positionals: [{ name: 'paths', nargs: '*' }],
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function repoRoot(cwd: string): string {
  const done = capture(['git', 'rev-parse', '--show-toplevel'], { cwd })
  if (done.code !== 0) throw new ValueError(`git 저장소가 아니다: ${cwd}`)
  return pyResolve(pyStrip(done.stdout))
}

function overlayFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => fnmatchcase(name, '*-overlay.md'))
      .sort(pyStrCompare)
  } catch {
    return []
  }
}

// 루트 바로 아래 디렉터리 중 `.claude/*-overlay.md` 를 가진 것
export function subprojects(root: string): string[] {
  return readdirSync(root)
    .filter((name) => isDir(`${root}/${name}`) && overlayFiles(`${root}/${name}/.claude`).length > 0)
    .sort(pyStrCompare)
}

function planPrefix(root: string, sub: string): string | null {
  for (const overlay of overlayFiles(`${root}/${sub}/.claude`)) {
    const found = PREFIX_ROW.exec(readTextFile(`${root}/${sub}/.claude/${overlay}`))
    if (found) return found[1]
  }
  return null
}

function owner(path: string, subs: string[]): string | null {
  const first = pathParts(path.startsWith('./') ? path.slice(2) : path)[0]
  return first !== undefined && subs.includes(first) ? first : null
}

// 값 하나마다 이 순서로 찾는다. 앞의 파일에 있으면 그것을 쓴다
export function searchOrder(root: string, skill: string, sub: string | null, warned: Set<string> = new Set()): string[] {
  const names = [skill, ...(skill in ALIASES ? [ALIASES[skill]] : [])]
  if (skill === 'docs-consolidate') names.push('docs-audit', 'docs-check')
  const order: string[] = []
  if (sub) order.push(...names.map((name) => `${sub}/.claude/${name}-overlay.md`))
  order.push(...names.map((name) => `.claude/${name}-overlay.md`))
  const remove = (rel: string) => {
    const at = order.indexOf(rel)
    if (at < 0) throw new ValueError('list.remove(x): x not in list')
    order.splice(at, 1)
  }
  if (skill === 'docs-audit' || skill === 'docs-consolidate') {
    for (const scope of sub ? [sub, null] : [null]) {
      const directory = scope ? `${scope}/.claude` : '.claude'
      const current = `${directory}/docs-audit-overlay.md`
      const legacy = `${directory}/docs-check-overlay.md`
      if (skill === 'docs-consolidate' && isFile(`${root}/${directory}/${skill}-overlay.md`)) {
        remove(current)
        remove(legacy)
        continue
      }
      if (isFile(`${root}/${current}`)) remove(legacy)
      else if (isFile(`${root}/${legacy}`) && !warned.has(legacy)) {
        warned.add(legacy)
        write(2, `경고: ${legacy} 는 옛 이름입니다. ${current} 로 옮겨 주세요 (docs-audit 스킬 5.0.0에서 호환 제거).\n`)
      }
    }
  }
  if (sub) order.push(...HARNESS.map((name) => `${sub}/${name}`))
  order.push(...HARNESS)
  return [...order.filter((rel) => isFile(`${root}/${rel}`)), ...order.filter((rel) => !isFile(`${root}/${rel}`)).map((rel) => `(없음) ${rel}`)]
}

// references/monorepo.md 의 「작업 대상 하위 프로젝트를 정한다」 순서를 따른다
export function resolveTargets(root: string, cwd: string, subs: string[], sub: string | null, plan: string | null, paths: string[]): [string[], string | null] {
  if (subs.length === 0) return [[], 'single']
  if (sub) {
    if (!subs.includes(sub)) throw new ValueError(`하위 프로젝트 오버레이가 없다: ${sub}. 있는 것: ${subs.join(', ')}`)
    return [[sub], 'user']
  }
  if (plan) {
    const hits = subs.filter((s) => {
      const prefix = planPrefix(root, s)
      return Boolean(prefix) && plan.startsWith(`${prefix}plan`)
    })
    if (hits.length === 1) return [hits, 'plan']
  }
  const owners = paths.map((p) => owner(p, subs))
  if (paths.length > 0 && !owners.includes(null)) return [[...new Set(owners as string[])].sort(pyStrCompare), 'paths']
  const real = pyResolve(cwd)
  const inside = real.startsWith(`${root}/`) ? pathParts(real.slice(root.length + 1)).slice(0, 1) : []
  if (inside.length > 0 && subs.includes(inside[0])) return [[inside[0]], 'cwd']
  return [[], null]
}

function jsonValue(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent + 2)
  const end = ' '.repeat(indent)
  if (value instanceof Map) {
    if (value.size === 0) return '{}'
    return `{\n${[...value].map(([key, item]) => `${pad}${JSON.stringify(key)}: ${jsonValue(item, indent + 2)}`).join(',\n')}\n${end}}`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${pad}${jsonValue(item, indent + 2)}`).join(',\n')}\n${end}]`
  }
  return JSON.stringify(value)
}

export function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseCli(argv, SPEC)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    write(2, `${USAGE.split('\n')[0]}\noverlay_paths.ts: error: ${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    write(1, USAGE)
    return 0
  }
  const sub = (parsed.options.sub as string | undefined) ?? null
  const plan = (parsed.options.plan as string | undefined) ?? null
  const given = parsed.positionals.paths as string[]
  const paths = given.filter((p) => p !== '-')
  if (given.includes('-')) paths.push(...readStdin().split('\n').map(pyStrip).filter((line) => line !== ''))
  const cwd = process.cwd()
  let root: string
  let subs: string[]
  let targets: string[]
  let reason: string | null
  try {
    root = repoRoot(cwd)
    subs = subprojects(root)
    ;[targets, reason] = resolveTargets(root, cwd, subs, sub, plan, paths)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `실행하지 못했다: ${error.message}\n`)
    return 2
  }
  const warned = new Set<string>()
  const skill = parsed.options.skill as string
  const search = new Map<string, string[]>()
  if (targets.length) for (const t of targets) search.set(t, searchOrder(root, skill, t, warned))
  else search.set('.', searchOrder(root, skill, null, warned))
  const result = new Map<string, unknown>([
    ['monorepo', subs.length > 0],
    ['subprojects', subs],
    ['targets', targets],
    ['reason', reason],
    ['search', search],
  ])
  write(1, `${jsonValue(result, 0)}\n`)
  return subs.length > 0 && targets.length === 0 ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
