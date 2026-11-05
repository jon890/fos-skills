// orch 명령 표. `orch <묶음> <동작> [인자]` 새 꼴과 옛 이름(`bin/orch.ts <스크립트 이름>`)을 스크립트와 인자로 푸는 유일한 원본이다.
// 진입점(bin/orch.ts), 문맥 채우기(lib/context.ts), doctor 의 문서 판정, 훅의 대기 판정이 이 표를 읽는다.
// 계약은 docs/features/orch-cli/spec.md 의 「명령 표」 와 design.md 의 「명령 표 항목」 이다. 판정 규칙은 스크립트가 소유하고 이 표는 이름과 인자만 바꾼다.
//
// 새 꼴을 푸는 차례(resolveNew):
//     1. 첫 낱말이 묶음, 다음 낱말(두 낱말 동작은 둘)이 그 묶음의 동작이면 그 행이다. 동작이 아니면 동작 없는 행(verb null)이다
//     2. 사용자가 준 인자의 첫 `--` 앞에서 금지 플래그(forbid)를 찾는다. 줄여 쓴 꼴도 금지 플래그의 접두면 거부한다.
//        스크립트의 expandArgs 가 접두를 펼쳐 금지를 우회하기 때문이다. allow 에 적은 이름(그 스크립트의 옵션이면서
//        금지 플래그의 접두인 것, wait 의 --ack)과 정확히 같은 낱말은 거부하지 않는다
//     3. 위치 인자를 옵션으로 바꾼다(positional). 그다음 prepend 를 앞에 붙인다
// 옛 이름은 인자를 바꾸지 않는다. resolveLegacy 는 새 꼴 안내 문자열만 만든다.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shQuote } from './py.ts'

export type ContextName = 'repo' | 'run' | 'specs-dir' | 'loop-repo'

export type Command = {
  group: string
  verb: string | null
  script: string
  prepend: string[]
  // required 면 위치 인자도 그 옵션도 없을 때 사용법 오류다. 없이 돌면 동작을 고르는 옵션이 빠져 다른 동작이 된다
  positional: { flag: string; repeat: boolean; context?: ContextName; required?: boolean; what?: string } | null
  context: ContextName[]
  explicit: Partial<Record<ContextName, RegExp[]>>
  required: ContextName[]
  runFrom: 'any' | 'run-current'
  skip: (args: string[]) => ContextName[]
  forbid: string[]
  allow: string[]
  passthrough: boolean
  legacy: { name: string; flags: string[] } | null
  usage: string
}

type Row = Partial<Command> & Pick<Command, 'group' | 'verb' | 'script' | 'usage'>

const none = (): ContextName[] => []

// 첫 `--` 앞의 인자. 그 뒤는 다른 명령에 넘어가는 인자라 읽지 않는다
export function beforeDashes(args: string[]): string[] {
  const i = args.indexOf('--')
  return i < 0 ? args : args.slice(0, i)
}

export function hasFlag(args: string[], name: string): boolean {
  return beforeDashes(args).some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
}

function countFlag(args: string[], name: string): number {
  return beforeDashes(args).filter((a) => a === `--${name}` || a.startsWith(`--${name}=`)).length
}

const LOOP_FORBID = ['--start', '--stop', '--status', '--foreground', '--tick']

const ROWS: Row[] = [
  // wait
  {
    group: 'wait', verb: null, script: 'wait/wait-important.ts', context: ['run', 'loop-repo'], required: ['run'],
    forbid: ['--ack-lost'], allow: ['--ack'], legacy: { name: 'wait-important', flags: [] },
    usage: 'orch wait [--ack <delivery>] [--types …] [--timeout-ms …] [--loop-repo <저장소>]',
  },
  {
    group: 'wait', verb: 'ack-lost', script: 'wait/wait-important.ts', positional: { flag: '--ack-lost', repeat: true, required: true, what: 'dispatch' }, context: ['run'], required: ['run'],
    legacy: { name: 'wait-important', flags: ['--ack-lost'] }, usage: 'orch wait ack-lost <dispatch>...',
  },
  {
    group: 'wait', verb: 'triage', script: 'wait/triage-messages.ts', context: ['run'], skip: (a) => (hasFlag(a, 'live') ? [] : ['run']),
    legacy: { name: 'triage-messages', flags: [] }, usage: 'orch wait triage <파일>... | orch wait triage --live',
  },
  { group: 'wait', verb: 'user-active', script: 'wait/user-active.ts', legacy: { name: 'user-active', flags: [] }, usage: 'orch wait user-active [--terminal <터미널>]' },
  { group: 'wait', verb: 'questions', script: 'wait/watch-questions.ts', context: ['run', 'repo'], legacy: { name: 'watch-questions', flags: [] }, usage: 'orch wait questions [--once]' },
  // loop
  {
    group: 'loop', verb: 'start', script: 'loop/orch-loop.ts', prepend: ['--start'], context: ['repo', 'run', 'specs-dir'], forbid: LOOP_FORBID,
    legacy: { name: 'orch-loop', flags: ['--start'] }, usage: 'orch loop start',
  },
  {
    group: 'loop', verb: 'stop', script: 'loop/orch-loop.ts', prepend: ['--stop'], context: ['repo', 'run'], forbid: LOOP_FORBID,
    skip: (a) => (hasFlag(a, 'all') ? ['run'] : []), legacy: { name: 'orch-loop', flags: ['--stop'] }, usage: 'orch loop stop [--all]',
  },
  {
    group: 'loop', verb: 'status', script: 'loop/orch-loop.ts', prepend: ['--status'], context: ['repo'], forbid: LOOP_FORBID,
    legacy: { name: 'orch-loop', flags: ['--status'] }, usage: 'orch loop status',
  },
  {
    group: 'loop', verb: 'run', script: 'loop/orch-loop.ts', prepend: ['--foreground'], context: ['repo', 'run', 'specs-dir'], forbid: LOOP_FORBID,
    legacy: { name: 'orch-loop', flags: ['--foreground'] }, usage: 'orch loop run [--once]',
  },
  { group: 'loop', verb: 'stalled', script: 'loop/stalled-workers.ts', context: ['repo'], legacy: { name: 'stalled-workers', flags: [] }, usage: 'orch loop stalled [--json]' },
  // worker
  {
    group: 'worker', verb: 'launch', script: 'worker/launch-worker.ts', context: ['run', 'repo'], skip: (a) => (hasFlag(a, 'worktree') ? ['repo'] : []),
    legacy: { name: 'launch-worker', flags: [] }, usage: 'orch worker launch --spec <지시서> --name <이름> [-- <worker 인자>]',
  },
  {
    group: 'worker', verb: 'send', script: 'worker/send-to-worker.ts', context: ['run'], runFrom: 'run-current',
    legacy: { name: 'send-to-worker', flags: [] }, usage: 'orch worker send --dispatch <id> (--body <글> | --body-file <파일>)',
  },
  {
    group: 'worker', verb: 'nudge', script: 'worker/nudge-worker.ts', forbid: ['--state'], legacy: { name: 'nudge-worker', flags: [] },
    usage: 'orch worker nudge --terminal <터미널> [--text <글>]',
  },
  {
    group: 'worker', verb: 'screen', script: 'worker/nudge-worker.ts', prepend: ['--state'], positional: { flag: '--terminal', repeat: false, required: true, what: '터미널' }, forbid: ['--state'],
    legacy: { name: 'nudge-worker', flags: ['--state'] }, usage: 'orch worker screen <터미널>',
  },
  { group: 'worker', verb: 'ask', script: 'worker/worker-ask.ts', legacy: { name: 'worker-ask', flags: [] }, usage: 'orch worker ask --from <터미널> --question <질문> [--decision]' },
  {
    group: 'worker', verb: 'adopt', script: 'worker/adopt-sessions.ts', context: ['run', 'repo'], skip: (a) => (hasFlag(a, 'apply') ? [] : ['run']),
    legacy: { name: 'adopt-sessions', flags: [] }, usage: 'orch worker adopt [--apply <터미널>]',
  },
  {
    group: 'worker', verb: 'worktree', script: 'worker/make-worktree.ts', positional: { flag: '--repo', repeat: false, context: 'repo' }, context: ['repo'], forbid: ['--check'],
    legacy: { name: 'make-worktree', flags: [] }, usage: 'orch worker worktree [<저장소>] --name <이름>',
  },
  {
    group: 'worker', verb: 'check', script: 'worker/make-worktree.ts', positional: { flag: '--check', repeat: false, required: true, what: '워크트리' }, forbid: ['--check'],
    legacy: { name: 'make-worktree', flags: ['--check'] }, usage: 'orch worker check <워크트리> --spec <지시서>',
  },
  { group: 'worker', verb: 'deny', script: 'worker/worktree-deny.ts', legacy: { name: 'worktree-deny', flags: [] }, usage: 'orch worker deny <워크트리>' },
  { group: 'worker', verb: 'link-profile', script: 'worker/link-claude-profile.ts', legacy: { name: 'link-claude-profile', flags: [] }, usage: 'orch worker link-profile [대상] [--apply]' },
  // queue
  {
    group: 'queue', verb: 'merge', script: 'queue/merge-with-finish.ts', context: ['repo', 'run'],
    explicit: { run: [/^--finish-arg=--run(=|$)/, /^--sweep-arg=--run(=|$)/] }, legacy: { name: 'merge-with-finish', flags: [] },
    usage: 'orch queue merge <PR>...',
  },
  { group: 'queue', verb: 'run', script: 'queue/merge_queue.ts', context: ['repo'], legacy: { name: 'merge_queue', flags: [] }, usage: 'orch queue run <PR>...' },
  { group: 'queue', verb: 'finish', script: 'queue/finish-pr.ts', context: ['repo', 'run'], legacy: { name: 'finish-pr', flags: [] }, usage: 'orch queue finish <PR>' },
  { group: 'queue', verb: 'ready', script: 'queue/ci-ready.ts', context: ['repo'], legacy: { name: 'ci-ready', flags: [] }, usage: 'orch queue ready <PR>...' },
  { group: 'queue', verb: 'conflicts', script: 'queue/notify-conflicts.ts', context: ['repo', 'run'], legacy: { name: 'notify-conflicts', flags: [] }, usage: 'orch queue conflicts' },
  { group: 'queue', verb: 'overlap', script: 'queue/overlap_units.ts', context: ['repo'], legacy: { name: 'overlap_units', flags: [] }, usage: 'orch queue overlap --base <ref> --head <ref>' },
  {
    group: 'queue', verb: 'reserve', script: 'queue/reserve-migration.ts', context: ['repo'], forbid: ['--prune'],
    legacy: { name: 'reserve-migration', flags: [] }, usage: 'orch queue reserve --module <모듈> --name <이름>',
  },
  {
    group: 'queue', verb: 'reserve prune', script: 'queue/reserve-migration.ts', prepend: ['--prune'], context: ['repo'], forbid: ['--prune'],
    legacy: { name: 'reserve-migration', flags: ['--prune'] }, usage: 'orch queue reserve prune',
  },
  // cleanup
  {
    group: 'cleanup', verb: 'sweep', script: 'cleanup/cleanup-sweep.ts', context: ['repo', 'run', 'specs-dir'],
    skip: (a) => [...(hasFlag(a, 'repo') ? (['repo'] as ContextName[]) : []), ...(countFlag(a, 'repo') > 1 ? (['specs-dir'] as ContextName[]) : [])],
    legacy: { name: 'cleanup-sweep', flags: [] }, usage: 'orch cleanup sweep [--apply]',
  },
  { group: 'cleanup', verb: 'worktree', script: 'cleanup/remove-worktree.ts', legacy: { name: 'remove-worktree', flags: [] }, usage: 'orch cleanup worktree <워크트리>' },
  { group: 'cleanup', verb: 'handoff', script: 'cleanup/handoff-cleanup.ts', context: ['repo', 'run'], legacy: { name: 'handoff-cleanup', flags: [] }, usage: 'orch cleanup handoff [--apply]' },
  // board
  { group: 'board', verb: 'sync', script: 'board/board-sync.ts', context: ['repo'], legacy: { name: 'board-sync', flags: [] }, usage: 'orch board sync' },
  { group: 'board', verb: 'release', script: 'board/board-release.ts', context: ['repo'], legacy: { name: 'board-release', flags: [] }, usage: 'orch board release --pr <N>' },
  { group: 'board', verb: 'goal', script: 'board/goal-progress.ts', legacy: { name: 'goal-progress', flags: [] }, usage: 'orch board goal <목표 id>' },
  // study
  ...(['list', 'add', 'set', 'migrate'] as const).map(
    (verb): Row => ({
      group: 'study', verb, script: 'study/study-candidates.ts', prepend: [verb], context: ['repo'],
      legacy: { name: 'study-candidates', flags: [verb] }, usage: `orch study ${verb}`,
    }),
  ),
  // spec
  { group: 'spec', verb: 'lint', script: 'spec/spec-lint.ts', context: ['repo'], legacy: { name: 'spec-lint', flags: [] }, usage: 'orch spec lint' },
  { group: 'spec', verb: 'line', script: 'spec/spec-line.ts', legacy: { name: 'spec-line', flags: [] }, usage: 'orch spec line <지시서> [--require-permission]' },
  // doctor. Run 은 문맥으로 채우지 않는다(스펙 DECISION23)
  { group: 'doctor', verb: null, script: 'doctor/orch-doctor.ts', context: ['repo'], legacy: { name: 'orch-doctor', flags: [] }, usage: 'orch doctor [--run <Run>]' },
  {
    group: 'doctor', verb: 'migrate', script: 'doctor/migrate-orch-dir.ts', context: ['repo', 'run'], forbid: ['--hooks'],
    legacy: { name: 'migrate-orch-dir', flags: [] }, usage: 'orch doctor migrate [--apply]',
  },
  {
    group: 'doctor', verb: 'migrate-hooks', script: 'doctor/migrate-orch-dir.ts', prepend: ['--hooks'], context: ['repo', 'run'], forbid: ['--hooks'],
    legacy: { name: 'migrate-orch-dir', flags: ['--hooks'] }, usage: 'orch doctor migrate-hooks [--apply]',
  },
  { group: 'doctor', verb: 'gh-usage', script: 'doctor/gh-usage.ts', legacy: { name: 'gh-usage', flags: [] }, usage: 'orch doctor gh-usage' },
  { group: 'doctor', verb: 'install-cli', script: 'doctor/install-cli.ts', legacy: null, usage: 'orch doctor install-cli' },
  // paths
  { group: 'paths', verb: null, script: 'paths/orch_paths.ts', context: ['repo'], legacy: { name: 'orch_paths', flags: [] }, usage: 'orch paths <이름> | orch paths check' },
  // status. Run 은 문맥으로 채우지 않는다(스펙 DECISION22). 주지 않으면 루프에 등록된 Run 을 모두 본다
  { group: 'status', verb: null, script: 'status/orch-status.ts', context: ['repo'], legacy: null, usage: 'orch status [--run <Run>]' },
  // slot
  { group: 'slot', verb: 'heavy', script: 'slot/heavy-slot.ts', passthrough: true, legacy: { name: 'heavy-slot', flags: [] }, usage: 'orch slot heavy -- <명령>' },
  { group: 'slot', verb: 'mem', script: 'slot/mem-gate.ts', passthrough: true, legacy: { name: 'mem-gate', flags: [] }, usage: 'orch slot mem -- <명령>' },
]

export const COMMANDS: Command[] = ROWS.map((r) => ({
  prepend: [],
  positional: null,
  context: [],
  explicit: {},
  required: [],
  runFrom: 'any',
  skip: none,
  forbid: [],
  allow: [],
  passthrough: false,
  legacy: null,
  ...r,
}))

export const GROUPS: string[] = [...new Set(COMMANDS.map((c) => c.group))]

export function isGroup(word: string | undefined): boolean {
  return word !== undefined && GROUPS.includes(word)
}

export function form(c: Command): string {
  return ['orch', c.group, ...(c.verb ? [c.verb] : [])].join(' ')
}

export function newForms(): string[] {
  return COMMANDS.map(form)
}

export function legacyNames(): string[] {
  return [...new Set(COMMANDS.flatMap((c) => (c.legacy ? [c.legacy.name] : [])))]
}

// 금지 플래그 판정. 정확히 같거나, 줄여 쓴 꼴이 금지 플래그의 접두면 금지다. allow 와 정확히 같으면 통과다
function forbidden(c: Command, args: string[]): string | null {
  for (const token of beforeDashes(args)) {
    if (!token.startsWith('--') || token.length === 2) continue
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
    if (c.allow.includes(name)) continue
    const hit = c.forbid.find((f) => f === name || (name.length > 2 && f.startsWith(name)))
    if (hit) return hit
  }
  return null
}

export type Resolved = { command: Command; args: string[]; user: string[] }

// argv 는 묶음부터다(`['wait', '--ack', 'd1']`). user 는 사용자가 준 인자(묶음과 동작 뺀 것)다
export function resolveNew(argv: string[]): Resolved | { error: string } {
  const [group, ...rest] = argv
  const rows = COMMANDS.filter((c) => c.group === group)
  if (rows.length === 0) return { error: `모르는 묶음이다: ${group}` }
  const verbs = rows.filter((c) => c.verb !== null).sort((a, b) => (b.verb as string).split(' ').length - (a.verb as string).split(' ').length)
  let command: Command | undefined
  let user = rest
  for (const c of verbs) {
    const words = (c.verb as string).split(' ')
    if (words.every((w, i) => rest[i] === w)) {
      command = c
      user = rest.slice(words.length)
      break
    }
  }
  if (!command) {
    command = rows.find((c) => c.verb === null)
    if (!command) {
      const shown = rest[0] === undefined ? '동작이 없다' : `모르는 동작이다: ${rest[0]}`
      return { error: `${shown}. 쓸 수 있는 동작: ${verbs.map((c) => c.verb).join(', ')}` }
    }
  }
  const hit = forbidden(command, user)
  if (hit) {
    const others = COMMANDS.filter((c) => c.script === command.script && c !== command).map(form)
    return { error: `${form(command)} 는 ${hit} 를 받지 않는다. 옛 모드 플래그 대신 동작을 쓴다${others.length ? `: ${others.join(', ')}` : ''}` }
  }
  let args = user
  if (command.positional) {
    // 위치 인자는 첫 옵션 앞의 낱말만이다. 진입점은 스크립트의 옵션 표를 몰라 옵션 값과 위치 인자를 가리지 못하기 때문이다
    const { flag, repeat } = command.positional
    let n = 0
    while (n < user.length && !user[n].startsWith('-') && (repeat || n < 1)) n++
    if (command.positional.required && n === 0 && !hasFlag(user, flag.slice(2))) {
      return { error: `${form(command)} 에 ${command.positional.what ?? '값'} 을 준다: ${command.usage}` }
    }
    args = [...user.slice(0, n).flatMap((v) => [flag, v]), ...user.slice(n)]
  }
  return { command, args: [...command.prepend, ...args], user }
}

// 옛 이름과 인자로 새 꼴 안내를 만든다. 인자는 바꾸지 않는다. 그 이름의 행이 없으면 null 이다
export function resolveLegacy(name: string, args: string[]): { command: Command; hint: string } | null {
  const bare = name.endsWith('.ts') ? name.slice(0, -3) : name.endsWith('.py') ? name.slice(0, -3) : name
  const rows = COMMANDS.filter((c) => c.legacy?.name === bare)
  if (rows.length === 0) return null
  const head = beforeDashes(args)
  const matches = rows.filter((c) =>
    (c.legacy as { flags: string[] }).flags.every((f) => (f.startsWith('--') ? head.some((a) => a === f || a.startsWith(`${f}=`)) : head[0] === f)),
  )
  if (matches.length === 0) return null
  const best = matches.sort((a, b) => (b.legacy as { flags: string[] }).flags.length - (a.legacy as { flags: string[] }).flags.length)[0]
  return { command: best, hint: form(best) }
}

// 이 번들의 스크립트 폴더(skills/orch/scripts). 진입 스크립트는 그 아래 `<묶음>/` 에 있다(스펙 DECISION6)
export const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function rowOf(name: string): Command | undefined {
  const bare = name.endsWith('.ts') ? name.slice(0, -3) : name
  return COMMANDS.find((c) => c.legacy?.name === bare || c.script === `${bare}.ts` || c.script.endsWith(`/${bare}.ts`))
}

// 스크립트끼리 부를 때 쓰는 경로. 옛 이름이나 파일 이름(`merge_queue`, `merge_queue.ts`)을 이 번들의 절대경로로 푼다.
// 파일이 있는지는 보지 않는다. 표에 없는 이름은 부르는 쪽의 잘못이라 던진다
export function scriptPath(name: string): string {
  const row = rowOf(name)
  if (!row) throw new Error(`명령 표에 없는 스크립트다: ${name}`)
  return join(SCRIPTS_DIR, row.script)
}

// 옛 이름이나 스크립트 파일 이름을 dir(고른 번들의 스크립트 폴더) 아래 파일 경로로 푼다. 명령 표의 경로(`<묶음>/<파일>`)를 먼저 보고,
// 없으면 dir 바로 아래 같은 이름(표에 없는 스크립트, 폴더 이동 전 배치의 체크아웃)을 본다. 둘 다 없으면 null 이다
export function scriptIn(dir: string, name: string): string | null {
  const bare = name.endsWith('.ts') ? name.slice(0, -3) : name
  const row = rowOf(bare)
  const files = [...(row ? [join(dir, row.script)] : []), join(dir, `${bare}.ts`)]
  return files.find((f) => existsSync(f)) ?? null
}

// 사람이 읽는 사용법. 묶음을 주면 그 묶음만 낸다
export function helpText(group?: string): string {
  const rows = group ? COMMANDS.filter((c) => c.group === group) : COMMANDS
  const lines = group
    ? [`사용법: orch ${group} <동작> [인자]`, '', ...rows.map((c) => `  ${c.usage}`)]
    : [
        '사용법: orch <묶음> <동작> [인자]',
        '',
        '저장소(--repo), Run(--run), 지시서 폴더(--specs-dir), 대기의 루프 저장소(--loop-repo)는 주지 않으면 작업 폴더와 코디네이터 터미널에서 읽는다.',
        '기본 출력은 판정 줄이다. --full 을 주면 스크립트의 지금 출력을 낸다.',
        '옛 꼴 `orch.ts <스크립트 이름> [인자]` 와 `orch.ts --path [이름]` 도 받는다.',
        '',
        ...GROUPS.flatMap((g) => [`${g}:`, ...COMMANDS.filter((c) => c.group === g).map((c) => `  ${c.usage}`)]),
      ]
  return `${lines.join('\n')}\n`
}

// 플러그인 루트 실행기(bin/orch)의 둘째 줄 표지. install-cli 와 doctor 도 같은 글자로 가린다
export const LAUNCHER_MARK = 'fos-skills orch launcher'
const ENTRY = fileURLToPath(new URL('../../bin/orch.ts', import.meta.url))
const words = new Map<string, string>()

// PATH 의 첫 orch 파일이 표지 있는 실행기인가
export function launcherOnPath(pathValue: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, 'orch')
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    try {
      return readFileSync(file, 'utf8').slice(0, 400).includes(LAUNCHER_MARK) ? file : null
    } catch {
      return null
    }
  }
  return null
}

// 안내 줄과 NEXT_WAIT 의 앞 낱말. PATH 의 첫 orch 가 표지 있는 실행기면 `orch`, 아니면 진입점 절대경로(셸 따옴표)다.
// 같은 PATH 값에는 프로세스 안에서 한 번만 훑는다. 테스트는 PATH 를 고정한다
export function orchWord(pathValue: string | undefined = process.env.PATH): string {
  const key = pathValue ?? ''
  let word = words.get(key)
  if (word === undefined) {
    word = launcherOnPath(pathValue) ? 'orch' : shQuote(ENTRY)
    words.set(key, word)
  }
  return word
}
