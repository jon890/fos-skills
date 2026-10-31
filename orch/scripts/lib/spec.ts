// 지시서 읽기와 지우기의 한 벌이다. 브랜치 줄과 허락 줄, worker 선택 줄, 살아 있는 dispatch 가 쓰는 지시서 목록, 지시서 삭제 경로를 둔다.
//
// 지시서 삭제는 deleteSpecs 한 경로다. 어떤 파일을 지울지 고르는 일과 지우는 일을 나눈다.
//   - 본문의 브랜치 줄로 고르면 branchesOf, 이름 규칙으로 고르면 specCandidates 를 쓴다
//   - deleteSpecs 는 받은 경로만 다루고, 살아 있는 지시서 목록(live)을 인자로 받아야 한다
//     live 가 null(목록을 읽지 못했다)이면 지시서와 PR 본문 모두 지우지 않는다. 남은 파일은 다음 정리가 지운다
// 브랜치가 모두 머지됐다는 이유로 아직 일하는 worker 의 지시서를 지운 일이 있어, 부르는 쪽이 이 확인을 건너뛸 수 없게 했다.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { inside, isFile, realPath } from './fs.ts'
import { orcaJson } from './orca.ts'

// 줄 머리의 `브랜치: \`x\``. 목록 기호(-, *)와 굵은 글씨(**브랜치:**, **브랜치**:)를 모두 받는다.
// 어느 꼴이라도 놓치면 그 지시서가 지워지지 않거나 워크트리가 만들어지지 않는다.
// 옛 make-worktree 는 `- ` 목록만 받았다. 이 한 벌로 모으며 `* ` 목록도 받게 넓어졌다(CHANGELOG 3.0.0).
// g 플래그를 두지 않는다. g 가 있으면 lastIndex 가 남아 같은 줄을 두 번 검사할 때 결과가 달라진다.
export const BRANCH_LINE: RegExp = /^\s*(?:[-*]\s+)?(?:\*\*)?브랜치(?:\*\*)?:(?:\*\*)?\s*`([^`]+)`/

// 줄 머리의 `허락: ...`. 목록 기호와 굵은 글씨는 벗긴다. `- **허락:** ...` 도 같은 줄로 본다.
const PERMISSION = /^\s*(?:[-*]\s+)?(?:\*\*)?허락\s*:\s*(?:\*\*)?\s*(.+?)\s*$/

// 줄 머리의 `worker 선택: ...`. 목록 기호와 굵은 글씨는 허락 줄과 같이 받는다.
const SELECTION = /^\s*(?:[-*]\s+)?(?:\*\*)?worker 선택\s*:\s*(?:\*\*)?\s*(.+?)\s*$/
const TICK = /`([^`]+)`/g

// worker 선택 줄의 값. 줄 판정과 형식은 selectionsOf 가 소유한다
export type Selection = { no: number; agent: string | null; model: string | null; effort: string | null; problems: string[] }

// 형식 예: worker 선택: `codex` `gpt-6.1-sol` effort `low`. 비교: Claude Sonnet 5.5. 이유: ...
// `effort` 뒤의 백틱 값이 effort 이고, 그 밖의 백틱 값 가운데 첫째가 에이전트, 둘째가 모델이다.
// problems 에는 빠진 요소를 적는다. `비교:` 와 `이유:` 는 낱말이 있는지만 본다. 코디네이터가 비교 없이 고른 일을 막으려는 것이다.
export const SELECTION_FORMAT = 'worker 선택: `<에이전트>` `<모델>` effort `<effort>`. 비교: <다른 후보>. 이유: <고른 이유>.'

export function selectionsOf(text: string): Selection[] {
  const found: Selection[] = []
  lines(text).forEach((line, index) => {
    const m = SELECTION.exec(line)
    if (!m) return
    const body = m[1]
    const effortAt = /effort\s*`([^`]+)`/.exec(body)
    const rest = effortAt ? body.slice(0, effortAt.index) + body.slice(effortAt.index + effortAt[0].length) : body
    const values = [...rest.matchAll(TICK)].map((t) => t[1].trim())
    const problems: string[] = []
    if (values.length < 1) problems.push('에이전트')
    if (values.length < 2) problems.push('모델')
    if (!effortAt) problems.push('effort')
    if (!/비교\s*:/.test(body)) problems.push('비교')
    if (!/이유\s*:/.test(body)) problems.push('이유')
    found.push({ no: index + 1, agent: values[0] ?? null, model: values[1] ?? null, effort: effortAt?.[1].trim() ?? null, problems })
  })
  return found
}

// spec 줄에서 / 로 시작하고 .md 로 끝나는 경로. 뒤에 글자나 점이 이어지면 경로의 끝이 아니다.
// u 플래그로 글자를 유니코드로 본다. 옮기기 전 Python 의 \w 가 한글도 글자로 보았다.
const SPEC_PATH = /(\/[^\s`'"]+?\.md)(?![\p{L}\p{N}\p{M}_.])/gu

// Python 의 str.splitlines 가 나누는 줄 경계. 지시서의 줄을 옛 명령(spec-line, spec-lint)과 같게 나눈다. spec-lint 가 줄 번호를 셀 때도 쓴다
export const LINE_BREAK: RegExp = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/

const ACTIVE = new Set(['pending', 'dispatched', 'running'])
const PAGE_LIMIT = '100'

function lines(text: string): string[] {
  return text.split(LINE_BREAK)
}

// 브랜치 줄들이 가리키는 브랜치 이름. 지시서에 나온 순서이고 겹쳐도 그대로 낸다.
// 브랜치 줄이 하나여야 하는 쪽(워크트리 만들기)이 같은 줄이 둘인 지시서도 둘로 세게 하려는 것이다.
export function branchesOf(text: string): string[] {
  const found: string[] = []
  for (const line of lines(text)) {
    const m = BRANCH_LINE.exec(line)
    if (m) found.push(m[1])
  }
  return found
}

// 줄 머리의 `보드 항목 id: x`. 목록 기호는 받고 굵은 글씨는 받지 않는다(보드 쓰기 쪽이 그렇게 읽어 왔다)
const BOARD_ID = /^\s*(?:[-*]\s*)?보드 항목 id\s*:\s*(.+?)\s*$/

// `보드 항목 id:` 줄의 id 와 그 뒤 설명. id 는 백틱 안의 글이거나 공백 앞 첫 토큰이다.
// `326-eval-resume (이 PR 은 5단계)` 처럼 설명이 붙으면 note 에 남아, 줄 끝까지 id 로 읽어 가짜 보드 항목을 만들던 일을 막는다
export function boardIdOfLine(line: string): { id: string; note: string } | null {
  const value = BOARD_ID.exec(line)?.[1]
  if (!value) return null
  const ticked = /^`([^`]+)`\s*(.*)$/.exec(value)
  if (ticked) return { id: ticked[1].trim(), note: ticked[2] }
  const [id, ...rest] = value.split(/\s+/)
  const bare = id.replaceAll('`', '')
  return bare ? { id: bare, note: rest.join(' ') } : null
}

// 지시서의 첫 `보드 항목 id:` 줄. 없으면 null 이다
export function boardIdOf(text: string): { id: string; note: string } | null {
  for (const line of lines(text)) {
    const found = boardIdOfLine(line)
    if (found) return found
  }
  return null
}

// 허락 줄의 문구. 마침표로 끝나지 않으면 붙인다. 첫 지시 줄에 문장으로 이어 붙이기 때문이다.
export function permissionsOf(text: string): string[] {
  const found: string[] = []
  for (const line of lines(text)) {
    const m = PERMISSION.exec(line)
    if (m) {
      const phrase = m[1].trim()
      found.push(phrase.endsWith('.') ? phrase : `${phrase}.`)
    }
  }
  return found
}

type Page<K extends string> = { [P in K]?: unknown } & { page?: { nextCursor?: unknown }; scope?: { source?: unknown } }

// 한 조회를 page.nextCursor 가 없을 때까지 이어 읽는다. 한 페이지라도 실패하면 null 이다.
// 같은 cursor 가 다시 오면 끝나지 않는 조회라 실패로 본다.
function readAll<K extends string>(args: string[], key: K): { rows: Record<string, unknown>[]; source: unknown } | null {
  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let source: unknown = undefined
  let cursor: string | null = null
  for (let first = true; first || cursor !== null; first = false) {
    const got = orcaJson<Page<K>>(cursor === null ? args : [...args, '--cursor', cursor])
    if (!got.ok || typeof got.data !== 'object' || got.data === null) return null
    if (first) source = got.data.scope?.source
    const list = got.data[key]
    if (Array.isArray(list)) {
      for (const row of list) if (typeof row === 'object' && row !== null) rows.push(row as Record<string, unknown>)
    }
    const next = got.data.page?.nextCursor
    cursor = typeof next === 'string' && next ? next : null
    if (cursor !== null) {
      if (seen.has(cursor)) return null
      seen.add(cursor)
    }
  }
  return { rows, source }
}

// 살아 있는 dispatch 가 쓰는 지시서의 실경로 집합. 판정할 수 없으면 null 이다.
//
// 살아 있는 것:
//   - task-list 의 status 가 pending, dispatched, running 인 Task
//   - worker-list 의 dispatchStatus 가 그 셋인 dispatch 의 Task
//   그 Task 의 spec 줄에서 / 로 시작하고 .md 로 끝나는 경로를 모두 실경로로 바꿔 모은다.
//
// worker-list 는 100행씩 나뉘므로 --limit 100 과 --cursor 로 끝까지 읽는다(lib/orca.ts 머리 주석). task-list 도
// 응답에 page.nextCursor 가 있으면 같은 방식으로 읽는다.
// run 이 null 이면 범위 없이 부르고, 아래 가운데 하나라도 맞으면 null 이다. 지시서 폴더는 저장소마다 하나라,
// 부른 터미널에 묶인 Run 만 본 결과로는 다른 Run 의 살아 있는 지시서를 지켜 주지 못한다.
//   - worker-list 의 scope.source 가 all 이 아니다
//   - task-list 응답에 scope.source 가 있는데 all 이 아니다
//   - 살아 있는 dispatch 의 taskId 가 task-list 행에 없다. task-list 가 묶인 Run 의 Task 만 주었을 수 있어서다.
//     task-list 가 scope 를 알리지 않아도 이것으로 범위가 좁았던 응답을 알아챈다
// run 을 주면 그 Run 만 본다. 그 run 이 옛 Run 을 가리키면 새 Run 의 worker 가 쓰는 지시서가 이 목록에 없어 지워질 수 있다.
// 옮기기 전 live_specs.py 도 같았다.
// 조회가 하나라도 실패하면(중간 페이지 실패 포함) null 이다.
export function liveSpecPaths(run: string | null): Set<string> | null {
  const scope = run === null ? [] : ['--run', run]
  const workers = readAll(['orchestration', 'worker-list', ...scope, '--limit', PAGE_LIMIT], 'workers')
  if (workers === null) return null
  if (run === null && workers.source !== 'all') return null
  const tasks = readAll(['orchestration', 'task-list', ...scope], 'tasks')
  if (tasks === null) return null
  const activeTasks = new Set(workers.rows.filter((w) => ACTIVE.has(String(w.dispatchStatus))).map((w) => w.taskId))
  if (run === null) {
    if (tasks.source !== undefined && tasks.source !== 'all') return null
    const known = new Set(tasks.rows.map((task) => task.id))
    for (const id of activeTasks) if (!known.has(id)) return null
  }
  const paths = new Set<string>()
  for (const task of tasks.rows) {
    if (!ACTIVE.has(String(task.status)) && !activeTasks.has(task.id)) continue
    const spec = typeof task.spec === 'string' ? task.spec : ''
    for (const m of spec.matchAll(SPEC_PATH)) paths.add(realPath(m[1]))
  }
  return paths
}

// 그 Run 의 Task 가 쓴 지시서의 실경로 집합. 상태와 상관없이 그 Run 의 모든 Task 를 본다. 조회가 실패하면 null 이다.
// handoff-cleanup --run 이 그 Run 의 지시서만 옮기는 데 쓴다(ADR-012).
export function runSpecPaths(run: string): Set<string> | null {
  const tasks = readAll(['orchestration', 'task-list', '--run', run], 'tasks')
  if (tasks === null) return null
  const paths = new Set<string>()
  for (const task of tasks.rows) {
    const spec = typeof task.spec === 'string' ? task.spec : ''
    for (const m of spec.matchAll(SPEC_PATH)) paths.add(realPath(m[1]))
  }
  return paths
}

// cleanup-sweep 의 이름 규칙으로 지울 후보를 낸다. 파일이 있는지 보지 않는다.
//   specs     <specsDir>/<name>.md, <specsDir>/spec-<name>.md
//   prBodies  옛 위치인 <specsDir 의 부모>/pr-<후보>.md. 후보는 name, branch 의 / 를 모두 - 로 바꾼 것,
//             branch 에서 첫 / 앞을 뗀 나머지(/ 가 없으면 branch 그대로), prNumber 다. 겹치는 경로는 한 번만 낸다
export function specCandidates(opts: { specsDir: string; name: string; branch?: string; prNumber?: number }): {
  specs: string[]
  prBodies: string[]
} {
  const { specsDir, name, branch, prNumber } = opts
  const specs = [join(specsDir, `${name}.md`), join(specsDir, `spec-${name}.md`)]
  const names = [name]
  if (branch) {
    const slash = branch.indexOf('/')
    names.push(branch.replaceAll('/', '-'), slash < 0 ? branch : branch.slice(slash + 1))
  }
  if (prNumber) names.push(String(prNumber))
  const parent = dirname(resolve(specsDir))
  const prBodies = [...new Set(names.map((n) => join(parent, `pr-${n}.md`)))]
  return { specs, prBodies }
}

// 지시서 폴더에서 `브랜치:` 줄이 그 브랜치를 가리키는 지시서. 이름이 워크트리 이름과 달라 specCandidates 가 못 고르는
// 후속 지시서(spec-328-pr3-resync.md 같은 것)를 머지된 브랜치로 찾는다. 폴더 바로 아래의 .md 만 본다. 읽지 못하면 건너뛴다.
// 고르기만 한다. 살아 있는 dispatch 의 지시서를 남기는 일은 deleteSpecs 가 한다
export function specsOnBranch(specsDir: string, branch: string): string[] {
  if (!branch) return []
  let names: string[]
  try {
    names = readdirSync(specsDir).filter((name) => name.endsWith('.md'))
  } catch {
    return []
  }
  return names.sort().flatMap((name) => {
    const file = join(specsDir, name)
    try {
      return branchesOf(readFileSync(file, 'utf8')).includes(branch) ? [file] : []
    } catch {
      return []
    }
  })
}

// 같은 이름이 있으면 <이름>.2, <이름>.3 처럼 번호를 붙인다. 휴지통의 파일을 덮어쓰지 않는다.
function uniqueDest(dest: string): string {
  const taken = (target: string) => {
    try {
      lstatSync(target)
      return true
    } catch {
      return existsSync(target)
    }
  }
  if (!taken(dest)) return dest
  let n = 2
  while (taken(`${dest}.${n}`)) n += 1
  return `${dest}.${n}`
}

// 휴지통이 다른 볼륨이면 rename 이 EXDEV 로 실패하므로 복사한 뒤 지운다.
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

// 파일 하나를 destDir 아래로 옮긴다. 같은 이름이 있으면 번호를 붙이고, 옮긴 경로를 돌려준다.
export function moveToTrash(from: string, destDir: string): string {
  const dest = uniqueDest(join(destDir, basename(from)))
  mkdirSync(dirname(dest), { recursive: true })
  moveFile(from, dest)
  return dest
}

const KIND = {
  spec: { object: '지시서를', subject: '지시서' },
  pr: { object: 'PR 본문을', subject: 'PR 본문' },
} as const

// 받은 지시서(specs)와 PR 본문(prBodies)을 지우거나 휴지통으로 옮긴다. root 는 orch 루트다.
//   - 없는 파일은 건너뛴다. removed 에도 kept 에도 넣지 않는다
//   - live 가 null 이면 모두 kept 다
//   - 실경로가 live 에 든 파일, root 밖의 파일은 kept 다
//   - mode 가 'delete' 면 지운다. { trash } 면 <trash>/<root 의 폴더 이름>/<root 기준 상대경로> 로 옮긴다.
//     휴지통으로 옮긴 것은 되살릴 수 있다(handoff 산출물 정리의 사용자 결정)
//   - apply 가 false 면 파일을 건드리지 않고 할 일을 log 로만 낸다. removed 에는 할 일의 경로가 든다
//   - 지우거나 옮기다 실패한 파일은 kept 에 이유와 함께 넣고 다음 파일로 간다
export function deleteSpecs(opts: {
  root: string
  specs: string[]
  prBodies: string[]
  live: Set<string> | null
  mode: 'delete' | { trash: string }
  apply: boolean
  log: (line: string) => void
}): { removed: string[]; kept: { path: string; reason: string }[] } {
  const { live, mode, apply, log } = opts
  const root = resolve(opts.root)
  const rootReal = realPath(root)
  const removed: string[] = []
  const kept: { path: string; reason: string }[] = []
  const keep = (target: string, kind: keyof typeof KIND, reason: string) => {
    kept.push({ path: target, reason })
    log(`${KIND[kind].object} 남긴다 ${target}: ${reason}`)
  }
  const items = [
    ...opts.specs.map((target) => ({ target, kind: 'spec' as const })),
    ...opts.prBodies.map((target) => ({ target, kind: 'pr' as const })),
  ]
  for (const { target, kind } of items) {
    if (!isFile(target)) continue
    if (live === null) {
      keep(target, kind, '살아 있는 지시서 목록을 읽지 못했다')
      continue
    }
    const real = realPath(target)
    if (live.has(real)) {
      keep(target, kind, '살아 있는 dispatch 가 쓴다')
      continue
    }
    // root 자신은 안으로 치지 않는다. 지울 대상은 root 아래의 파일이다.
    if (real === rootReal || !inside(real, rootReal)) {
      keep(target, kind, 'orch 루트 밖이다')
      continue
    }
    if (mode === 'delete') {
      if (!apply) {
        log(`${KIND[kind].object} 지울 것 ${target}`)
        removed.push(target)
        continue
      }
      try {
        unlinkSync(target)
      } catch (e) {
        keep(target, kind, `지우지 못했다: ${(e as Error).message}`)
        continue
      }
      log(`${KIND[kind].subject} 삭제 ${target}`)
      removed.push(target)
      continue
    }
    const rel = join(basename(root), relative(rootReal, real))
    if (!apply) {
      log(`${KIND[kind].object} 휴지통으로 옮길 것 ${target}`)
      removed.push(target)
      continue
    }
    const dest = uniqueDest(join(resolve(mode.trash), rel))
    try {
      mkdirSync(dirname(dest), { recursive: true })
      moveFile(target, dest)
    } catch (e) {
      keep(target, kind, `휴지통으로 옮기지 못했다: ${(e as Error).message}`)
      continue
    }
    log(`${KIND[kind].subject} 옮김 ${target} -> ${dest}`)
    removed.push(target)
  }
  return { removed, kept }
}
