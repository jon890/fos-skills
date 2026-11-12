#!/usr/bin/env node
// implementation 사전 검증. 재실행 사고를 막는 사실을 모아 판정한다.
//
// 사용법: node "$SKILL_DIR/scripts/plan_precheck.ts" <plan> [--repo <저장소>] [--branch <원격 브랜치>] [--base <기준 브랜치>]
//           [--tasks-dir <계획서 폴더>] [--docs-dir <docs 경로>]... [--resume] [--json]
//   plan        task 디렉터리 이름이나 그 앞부분 (예: plan260)
//   --repo      저장소 루트 (기본: 현재 디렉터리)
//   --branch    원격 브랜치 이름 (기본: task 디렉터리 이름)
//   --base      기준 브랜치. 저장소 설정에서 정한 값을 넘긴다
//   --tasks-dir 계획서 디렉터리. 저장소 루트 기준 (기본: tasks)
//   --docs-dir  기획 커밋으로 볼 docs 경로. 여러 번 줄 수 있다 (기본: docs)
//   --resume    인계된 같은 계획·브랜치의 재개. 구현 변경/열린 PR 만 허용하고 완료·삭제 보호는 유지한다. --branch 가 필요하다
//   --json      사실을 JSON 으로 출력한다
//   긴 옵션은 고유 접두로 줄여 쓸 수 있다.
//
// 종료 코드
//   0  진행 가능
//   1  사용자 결정 필요 (발견 사항을 출력한다)
//   2  검사기가 돌지 못함, 또는 사용법 오류

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isMain, write } from './io.ts'
import { expandArgs } from './kit/args.ts'

// 계획서를 지우지 않던 때의 완료 표시다. 지운 계획서는 findDeleted 가 찾는다.
const DONE_STATUS = new Set(['completed'])
const STOPPED_STATUS = new Set(['cancelled', 'failed'])
// 구현 커밋과 기획 커밋을 구분하는 경로의 기본값. 이 밖을 건드리면 구현으로 본다.
// 모노레포는 --tasks-dir 와 --docs-dir 로 하위 프로젝트 경로를 넘긴다.
const PLANNING_PREFIXES = ['tasks/', 'docs/']
// 계획 단계에서 README 나 CLAUDE.md 의 설명 한 줄을 고치는 일이 흔하다. 마크다운은 구현으로 세지 않는다.
// 코드 파일은 경로와 관계없이 계속 구현으로 센다.
const PLANNING_SUFFIXES = ['.md']

// Python str.strip() 이 공백으로 보는 글자
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const STRIP = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')
const strip = (text: string) => text.replace(STRIP, '')
const lines = (text: string) => text.split('\n')
// Python 의 참·거짓. 빈 목록과 빈 객체도 거짓이다
const truthy = (value: unknown) => !(value === undefined || value === null || value === false || value === 0 || value === '' || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0))
const fmt = (value: unknown) => (value === undefined || value === null ? 'None' : String(value))

type Facts = {
  branch: string
  remote_exists: boolean
  base: string
  local_exists?: boolean
  impl_files?: string[]
  has_impl_commits?: boolean
  merged_into_base?: boolean
  merged_into_main?: boolean
}
type Pr = { number: number; title: string; url?: string }
type Index = { status?: string; current_phase?: unknown; total_phases?: unknown; blocked_reason?: string; error_message?: string; [key: string]: unknown }

// 검사를 이어 갈 수 없을 때 낸다.
export class PrecheckError extends Error {}

function exec(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const done = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { ok: done.status === 0, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

export function run(args: string[], cwd: string): string {
  const done = exec(args, cwd)
  if (!done.ok) throw new PrecheckError(`${args.join(' ')} 실패: ${strip(done.stderr)}`)
  return strip(done.stdout)
}

export function tryRun(args: string[], cwd: string): string | null {
  const done = exec(args, cwd)
  return done.ok ? strip(done.stdout) : null
}

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory()
const isFile = (path: string) => existsSync(path) && statSync(path).isFile()

// plan 이름이나 그 앞부분으로 task 디렉터리를 찾는다.
export function findLocal(repo: string, plan: string, tasksDir = 'tasks'): string | null {
  const tasks = join(repo, tasksDir)
  if (!isDir(tasks)) return null
  const exact = join(tasks, plan).replace(/(?<=.)\/+$/, '')
  if (isFile(join(exact, 'index.json'))) return exact
  const hits = readdirSync(tasks)
    .sort()
    .filter((name) => isDir(join(tasks, name)) && isFile(join(tasks, name, 'index.json')) && (name === plan || name.startsWith(`${plan}-`)))
  if (hits.length > 1) throw new PrecheckError(`'${plan}' 이 여러 디렉터리에 맞는다: ${hits.join(', ')}`)
  return hits.length ? join(tasks, hits[0]) : null
}

// 지운 계획서를 git 이력에서 찾는다. [디렉터리 이름, 지운 커밋] 을 낸다.
//
// 구현이 끝난 계획서는 PR 에서 지운다. 지운 뒤에는 로컬에도 브랜치 트리에도 없어서
// 이력을 보지 않으면 「plan 을 먼저 돌린다」 로 잘못 안내한다.
// --all 이라 아직 머지되지 않은 PR 브랜치에서 지운 것도 찾는다.
export function findDeleted(repo: string, plan: string, tasksDir = 'tasks'): [string, string] | null {
  const out = tryRun(['git', 'log', '--all', '--diff-filter=D', '--format=commit %h', '--name-only', '--', `${tasksDir}/*/index.json`], repo)
  let commit = ''
  for (const line of lines(out ?? '')) {
    if (line.startsWith('commit ')) {
      commit = line.slice('commit '.length)
      continue
    }
    const rest = line.startsWith(`${tasksDir}/`) ? line.slice(tasksDir.length + 1) : line
    const parts = rest.split('/')
    if (parts.length === 2 && parts[1] === 'index.json' && (parts[0] === plan || parts[0].startsWith(`${plan}-`))) return [parts[0], commit]
  }
  return null
}

// 브랜치에만 있는 task 를 읽는다. plan 이 push 한 직후가 이 상태다.
export function loadRemoteIndex(repo: string, branch: string, name: string, tasksDir = 'tasks'): Index | null {
  // branchFacts 가 방금 fetch 했다. origin/<branch> 는 오래됐을 수 있다.
  const blob = tryRun(['git', 'show', `FETCH_HEAD:${tasksDir}/${name}/index.json`], repo)
  if (blob === null) return null
  try {
    return JSON.parse(blob)
  } catch (error) {
    throw new PrecheckError(`${branch} 의 index.json 을 읽지 못했다: ${(error as Error).message}`)
  }
}

export function parseIndex(path: string): Index {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new PrecheckError(`${path} 를 읽지 못했다: ${(error as Error).message}`)
  }
}

// `origin/main` 으로 준 기준 브랜치를 `main` 으로 맞춘다.
//
// 이후 코드가 `origin/${base}` 를 직접 만들어 쓴다. 접두사가 남으면 `origin/origin/main` 을 fetch 하다
// 종료 코드 2 로 끝난다. orch 의 띄우기 안내가 `origin/<base>` 를 쓰라고 해서 같은 값을 여기에 넘기기 쉽다.
export function normalizeBase(base: string | null | undefined): string | null | undefined {
  if (!base) return base
  for (const prefix of ['refs/remotes/origin/', 'refs/heads/', 'origin/']) {
    if (base.startsWith(prefix)) return base.slice(prefix.length)
  }
  return base
}

// 명시 인자, 저장소 Git 설정, 원격 기본 브랜치 순으로 정한다.
export function resolveBase(repo: string, explicit?: string | null): string {
  let base = normalizeBase(
    explicit || tryRun(['git', 'config', '--local', '--get', 'implementation.baseBranch'], repo),
  )
  if (!base) {
    const remote = run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], repo)
    for (const line of lines(remote)) {
      if (line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD')) {
        base = line.split(/\s+/)[1].replace(/^refs\/heads\//, '')
        break
      }
    }
  }
  if (!base) throw new PrecheckError('원격 기본 브랜치를 찾지 못했다. --base 로 기준 브랜치를 지정한다.')
  run(['git', 'check-ref-format', '--branch', base], repo)
  return base
}

export function branchFacts(repo: string, branch: string, base: string, planPrefixes: string[] = PLANNING_PREFIXES): Facts {
  const remoteRef = `refs/heads/${branch}`
  const ls = run(['git', 'ls-remote', '--heads', 'origin', branch], repo)
  const exists = lines(ls).some((line) => line.endsWith(remoteRef))
  const facts: Facts = { branch, remote_exists: exists, base }
  let head: string
  if (!exists) {
    // 계획서와 구현을 한 브랜치에서 끝내고 PR 때 push 하는 흐름에서는 원격에 아직 없다.
    // 로컬 브랜치가 있으면 그 브랜치의 구현 변경을 기준 브랜치와 비교한다.
    facts.local_exists = tryRun(['git', 'rev-parse', '--verify', '--quiet', remoteRef], repo) !== null
    if (!facts.local_exists) return facts
    run(['git', 'fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], repo)
    head = remoteRef
  } else {
    // 기준을 먼저 갱신하고 작업 브랜치를 마지막에 fetch 한다. FETCH_HEAD 는 작업 브랜치다.
    run(['git', 'fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], repo)
    run(['git', 'fetch', '--quiet', 'origin', `refs/heads/${branch}`], repo)
    head = 'FETCH_HEAD'
  }
  // 기본 설정에서 git 은 한글 경로를 따옴표와 8진 escape 로 감싼다. 그러면 `.md` 로 끝나는지 판정하지 못한다.
  const changed = run(['git', '-c', 'core.quotePath=false', 'diff', '--name-only', `origin/${base}...${head}`], repo)
  const impl = lines(changed).filter((f) => f && !planPrefixes.some((p) => f.startsWith(p)) && !PLANNING_SUFFIXES.some((s) => f.endsWith(s)))
  facts.impl_files = impl
  facts.has_impl_commits = impl.length > 0
  if (!exists) return facts

  const merged = run(['git', 'branch', '--remotes', '--contains', 'FETCH_HEAD'], repo)
  facts.merged_into_base = lines(merged).some((line) => [`origin/${base}`, `origin/HEAD -> origin/${base}`].includes(strip(line)))
  return facts
}

export function openPr(repo: string, branch: string): Pr[] {
  const out = tryRun(['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title,url'], repo)
  if (out === null) throw new PrecheckError('gh pr list 가 실패했다. 인증과 GH_HOST 를 확인한다.')
  return JSON.parse(out || '[]')
}

// 이 브랜치로 머지된 PR. squash 머지 뒤 브랜치를 지우면 git 이력에서 계획서를 찾지 못한다.
//
// 같은 PR 에서 계획서를 더하고 지운 뒤 squash 하면 기준 브랜치 이력에 index.json 이 없고,
// 원 브랜치를 지우면 git log --all 도 보지 못한다. PR 목록은 남는다.
// gh 가 실패하면 빈 목록을 낸다. 호출한 쪽이 원래의 오류 안내로 돌아간다.
export function mergedPr(repo: string, branch: string, required = false): Pr[] {
  const out = tryRun(['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,title,url'], repo)
  if (required && out === null) throw new PrecheckError('재개할 브랜치의 머지된 PR 을 확인하지 못했다. gh 인증과 연결을 확인한다.')
  try {
    return JSON.parse(out || '[]')
  } catch {
    if (required) throw new PrecheckError('재개할 브랜치의 PR 결과가 올바른 JSON 이 아니다')
    return []
  }
}

function implFinding(branch: Facts): string {
  const files = (branch.impl_files ?? []).slice(0, 5).join(', ')
  const more = (branch.impl_files ?? []).length > 5 ? ` 외 ${(branch.impl_files ?? []).length - 5}개` : ''
  return `브랜치에 이미 구현 변경이 있다: ${files}${more}`
}

// 진행을 막지 않지만 알릴 사실이다. 종료 코드에 영향을 주지 않는다.
export function notes(branch: Facts, where: string): string[] {
  if (where === '로컬' && !branch.remote_exists && branch.local_exists) return [`\`${branch.branch}\` 브랜치가 로컬에만 있다. push 전 브랜치로 보고 진행한다.`]
  return []
}

const merged = (branch: Facts) => Boolean(branch.merged_into_base ?? branch.merged_into_main)

// 진행을 막을 사실만 모은다.
export function judge(index: Index, branch: Facts, prs: Pr[], resume = false): string[] {
  const found: string[] = []
  const status = index.status
  if (resume) {
    const phase = index.current_phase
    const total = index.total_phases
    if (status !== 'pending' || !Number.isInteger(phase) || !Number.isInteger(total) || !(1 <= (phase as number) && (phase as number) <= (total as number))) {
      found.push('재개는 pending 계획의 유효한 current_phase/total_phases 가 필요하다')
    }
    if (merged(branch)) found.push('이미 기준 브랜치에 머지된 계획은 재개하지 않는다')
  }

  if (status !== undefined && DONE_STATUS.has(status)) {
    found.push('index.json 상태가 completed 다. 이미 끝난 plan 을 다시 도는 중일 수 있다.')
  } else if (status !== undefined && STOPPED_STATUS.has(status)) {
    const reason = truthy(index.blocked_reason) ? index.blocked_reason : truthy(index.error_message) ? index.error_message : '사유 없음'
    found.push(`index.json 상태가 \`${status}\` 다: ${reason}`)
  }

  if (!branch.remote_exists) {
    if (status !== undefined && DONE_STATUS.has(status)) {
      found.push(`원격에 \`${branch.branch}\` 브랜치가 없다. 머지 후 정리된 것으로 보인다.`)
    } else if (branch.local_exists) {
      // push 전 브랜치다. 원격 부재는 notes 가 알리고, 로컬 구현 변경만 발견 사항으로 본다.
      if (branch.has_impl_commits && !resume) found.push(implFinding(branch))
    } else {
      found.push(`원격에 \`${branch.branch}\` 브랜치가 없다. plan 이 push 하지 않았거나 브랜치 이름 형식이 다르다.`)
    }
    return found
  }

  if (branch.has_impl_commits && !resume) found.push(implFinding(branch))

  if (prs.length && !resume) found.push(`이 브랜치로 열린 PR 이 있다: ${prs.map((p) => `#${p.number} ${p.title}`).join(', ')}`)

  if (status !== undefined && DONE_STATUS.has(status) && !merged(branch)) {
    found.push(`completed 인데 브랜치가 ${branch.base ?? 'main'} 에 머지되지 않았다. 완료 표기가 실제와 어긋난다.`)
  }
  return found
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  repo: { type: 'string', default: '.' },
  branch: { type: 'string' },
  base: { type: 'string' },
  'tasks-dir': { type: 'string', default: 'tasks' },
  'docs-dir': { type: 'string', multiple: true },
  resume: { type: 'boolean' },
  json: { type: 'boolean' },
} as const
const USAGE = 'usage: plan_precheck.ts [-h] [--repo REPO] [--branch BRANCH] [--base BASE] [--tasks-dir TASKS_DIR] [--docs-dir DOCS_DIR] [--resume] [--json] plan'

function usageError(message: string): number {
  write(2, `${USAGE}\nplan_precheck.ts: error: ${message}\n`)
  return 2
}

export function main(argv: string[]): number {
  let values: { help?: boolean; repo: string; branch?: string; base?: string; 'tasks-dir': string; 'docs-dir'?: string[]; resume?: boolean; json?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: true, strict: true })
    values = parsed.values as typeof values
    positionals = parsed.positionals
  } catch (error) {
    return usageError((error as Error).message)
  }
  if (values.help) {
    write(1, `${USAGE}\n\nimplementation 사전 검증. 재실행 사고를 막는 사실을 모아 판정한다. 자세한 것은 이 파일의 머리 주석에 있다.\n`)
    return 0
  }
  if (positionals.length < 1) return usageError('the following arguments are required: plan')
  if (positionals.length > 1) return usageError(`unrecognized arguments: ${positionals.slice(1).join(' ')}`)
  const plan = positionals[0]
  if (values.resume && !values.branch) return usageError('--resume 은 인계된 --branch 를 명시해야 한다')

  // Path.resolve() 처럼 심볼릭 링크를 따라간 경로다
  const repo = existsSync(values.repo) ? realpathSync(resolve(values.repo)) : resolve(values.repo)
  const tasksDir = values['tasks-dir'].replace(/\/+$/, '')
  const prefixes = [tasksDir, ...(values['docs-dir']?.length ? values['docs-dir'] : ['docs'])].map((d) => `${d.replace(/\/+$/, '')}/`)
  let taskDir: string | null
  let name: string
  let branch: Facts
  let prs: Pr[]
  let index: Index | null
  let where: string
  let deleted: [string, string] | null
  let mergedPrs: Pr[]
  try {
    taskDir = findLocal(repo, plan, tasksDir)
    name = taskDir ? basename(taskDir) : plan
    const base = resolveBase(repo, values.base)
    branch = branchFacts(repo, values.branch || name, base, prefixes)
    prs = branch.remote_exists ? openPr(repo, branch.branch) : []

    if (taskDir) {
      index = parseIndex(join(taskDir, 'index.json'))
      where = '로컬'
    } else if (branch.remote_exists) {
      index = loadRemoteIndex(repo, branch.branch, name, tasksDir)
      where = '브랜치'
    } else {
      index = null
      where = '없음'
    }

    deleted = index === null ? findDeleted(repo, plan, tasksDir) : null
    if (deleted) name = deleted[0]
    mergedPrs = values.resume ? mergedPr(repo, branch.branch, true) : index === null && !deleted && !branch.remote_exists ? mergedPr(repo, branch.branch) : []
    if (index === null && !branch.remote_exists && !deleted && !mergedPrs.length) {
      throw new PrecheckError(`'${plan}' 의 index.json 을 로컬 ${tasksDir}/ 에서도 원격 브랜치에서도 찾지 못했다. plan 을 먼저 돌린다.`)
    }
  } catch (error) {
    if (!(error instanceof PrecheckError)) throw error
    write(2, `검사를 돌리지 못했다: ${error.message}\n`)
    return 2
  }

  let info: string[] = []
  let found: string[]
  const openList = () => `이 브랜치로 열린 PR 이 있다: ${prs.map((p) => `#${p.number} ${p.title}`).join(', ')}`
  if (values.resume && mergedPrs.length) {
    found = [`이미 머지된 PR 의 계획은 재개하지 않는다: ${mergedPrs.map((p) => `#${p.number}`).join(', ')}`]
  } else if (index === null && mergedPrs.length) {
    found = [`\`${branch.branch}\` 브랜치로 머지된 PR 이 있다: ${mergedPrs.map((p) => `#${p.number} ${p.title}`).join(', ')}. 구현을 마치고 계획서를 지운 뒤 squash 머지한 plan 일 수 있다.`]
  } else if (index === null && deleted) {
    found = [`\`${deleted[0]}\` 은 커밋 ${deleted[1]} 에서 지운 계획서다. 구현이 끝난 plan 을 다시 도는 중일 수 있다.`]
    if (prs.length) found.push(openList())
  } else if (index === null) {
    // 브랜치는 있는데 task 가 없다. plan 이 중단됐거나 push 되지 않았다.
    found = [`\`${branch.branch}\` 브랜치는 있는데 그 안에 ${tasksDir}/${name}/index.json 이 없다. plan 이 중단됐거나 push 되지 않았다.`]
    if (prs.length) found.push(openList())
  } else {
    found = judge(index, branch, prs, Boolean(values.resume))
    info = notes(branch, where)
    if (where === '브랜치') found.unshift(`task 가 로컬 ${tasksDir}/ 에 없고 \`${branch.branch}\` 브랜치에만 있다.`)
  }

  if (values.json) {
    const foundIn = index === null && deleted ? '지운 계획서' : index === null && mergedPrs.length ? '머지된 PR' : where
    write(
      1,
      `${JSON.stringify(
        {
          task: taskDir ?? name,
          found_in: foundIn,
          deleted_in: deleted ? deleted[1] : null,
          status: index ? (index.status ?? null) : null,
          total_phases: index ? (index.total_phases ?? null) : null,
          current_phase: index ? (index.current_phase ?? null) : null,
          branch,
          open_prs: prs,
          findings: found,
          notes: info,
        },
        null,
        2,
      )}\n`,
    )
  } else if (found.length) {
    write(1, `${name}: 사용자 결정이 필요하다.\n${found.map((f) => `  - ${f}\n`).join('')}`)
  } else {
    write(1, `${name}: 진행 가능. status=${fmt(index?.status)} phase=${fmt(index?.current_phase)}/${fmt(index?.total_phases)}\n${info.map((note) => `  - ${note}\n`).join('')}`)
  }
  return found.length ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
