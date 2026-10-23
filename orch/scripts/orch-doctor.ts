// 스킬을 열 때 설치본이 낡지 않았는지, 문서가 부르는 스크립트가 모두 있는지, 저장소의 핸들러와 설정을 본다.
//
// 플러그인 스킬은 체크아웃이 아니라 설치 캐시의 복사본이 실행된다. 캐시가 옛 커밋이면
// 문서가 부르는 스크립트(`spec-line.ts` 같은 것)가 없어 그 단계를 건너뛰게 된다.
// 갱신 명령을 보여 주는 것까지만 하고 갱신은 하지 않는다. 다른 세션이 같은 캐시를 쓰고 있을 수 있다.
//
// Node 버전은 여기서 보지 않는다. 22.18 보다 낮은 node 는 이 파일을 읽지 못하고 ERR_UNKNOWN_FILE_EXTENSION 으로 죽는다.
// 그래서 SKILL.md 는 옛 진입점 orch-doctor.py 로 부르고, 그 진입점(ts_shim.py)이 버전을 보고 낮으면 NODE-TOO-OLD 로 멈춘다.
//
// 사용법:
//     orch-doctor.ts [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version] [--run ID] [--skip-questions] [--repo DIR]
//
//     --skill-dir       볼 스킬 디렉터리. 기본은 이 스크립트의 상위 디렉터리($SKILL_DIR)
//     --remote          원본 저장소. 주지 않으면 설치 경로의 마켓플레이스 clone 의 origin 을 쓴다
//     --branch          원본의 기준 브랜치. 기본 main
//     --skip-version    설치본 비교를 건너뛰고 스크립트 존재만 본다. 저장소 테스트가 스킬마다 이것으로 부른다
//     --run             미답변 질문을 확인할 Run. 주면 session-resume 이벤트도 낸다
//     --skip-questions  질문 상태 조회를 건너뛴다
//     --repo            핸들러와 설정을 볼 저장소. 기본은 작업 디렉터리의 주 checkout
//
// 설치본 판정:
//     설치 경로는 `<plugins>/cache/<마켓플레이스>/<플러그인>/<sha>/<스킬>` 이다. `<sha>` 가 설치한 커밋이다.
//     원본 브랜치의 커밋을 `git ls-remote` 로 읽어 앞자리가 같으면 최신이다.
//     다르면 설치본 스킬 디렉터리의 tree hash 를 마켓플레이스 clone 의 `<원본 커밋>:<스킬>` 과 비교한다.
//     같으면 최신으로 본다. 다른 스킬만 바뀐 커밋에 갱신하라고 하지 않기 위해서다.
//     마켓플레이스 clone 은 커밋 하나뿐인 shallow clone 이라 커밋끼리 diff 하지 못한다. 그래서 tree 를 비교한다.
//     clone 에 원본 커밋이 없거나(마켓플레이스를 아직 갱신하지 않았다) 그 경로가 없으면 판정할 수 없어 낡은 것으로 본다.
//     설치 경로가 이 꼴이 아니면(`--plugin-dir` 로 체크아웃을 실은 경우) 비교하지 않는다.
//     원본을 읽지 못하면(오프라인) 비교하지 않고 SKIP-VERSION 을 낸다. 스킬을 여는 일을 막지 않는다.
//
// 스크립트 판정:
//     SKILL.md 와 그 아래 .md 에서 `$SKILL_DIR/scripts/<이름>` 과 상대 링크 `](scripts/<이름>)`, `](../scripts/<이름>)` 를 읽는다.
//     확장자는 가리지 않는다. `.py` 와 `.ts` 가 함께 쓰인다.
//     형제 번들 변수 `$PLANNING_SKILL_DIR/scripts/<이름>` 은 같은 플러그인의 `planning/scripts/<이름>` 으로 본다
//     (변수 이름의 `_SKILL_DIR` 앞을 소문자로 바꾸고 `_` 를 `-` 로 바꾼 디렉터리).
//     백틱 안의 `scripts/verify.sh` 처럼 앞에 아무것도 없는 경로는 저장소 쪽 예시일 수 있어 보지 않는다.
//
// 저장소 판정(--repo):
//     <orch 루트>/hooks/ 바로 아래의 .ts 가운데 이벤트 이름이 아닌 파일은 UNKNOWN-HOOK 이다(lib/events.ts 의 unknownHandlers).
//     <orch 루트>/config.json 에 다음 major 에서 지울 옛 칸(lib/config.ts 의 DEPRECATED_KEYS)이 있으면 DEPRECATED-CONFIG 다.
//     설정 파일이 깨졌으면 그 이유를 stderr 에 내고 이 판정만 건너뛴다.
//     둘 다 경고라 종료 코드를 바꾸지 않는다. 오타 난 핸들러는 불리지 않아 조용히 빠지므로 알려야 한다.
//
// session-resume 이벤트(--run 을 줄 때, docs/data-schema.md 「이벤트별 필드」):
//     loop_alive  늘 false 다. 상주 루프는 아직 없다
//     waiters     `ps -axo pid=,command=` 의 행 가운데 명령줄에 `wait-important` 와 Run id(낱말)가 든 것의 pid.
//                 doctor 자신과 셸 행(sh, bash, zsh, dash, fish 가 띄운 `-c` 명령)은 뺀다. 셸 행은 대기 자신이 아니라 그것을 띄운 셸이다.
//                 PS 환경 변수로 ps 실행 파일을 바꾼다
//     unanswered  질문 조회가 낸 미답변 질문 id 전부. 조회하지 못했거나 --skip-questions 면 빈 목록
//     repo 는 --repo, base 는 그 저장소의 origin/HEAD 브랜치(없으면 빈 문자열), run 은 --run 이다.
//     핸들러의 실패는 `HOOK-FAIL` 줄만 남기고 종료 코드를 바꾸지 않는다.
//
// 출력 (한 줄에 하나):
//     OK-VERSION <sha>                           설치본이 원본과 같거나 그 스킬이 바뀌지 않았다
//     STALE <설치 sha> <원본 sha>                설치본이 낡았다. 다음 줄에 갱신 명령이 온다
//     SKIP-VERSION <이유>                        비교하지 않았다
//     MISSING <문서>:<줄> <경로>                 문서가 부르는 스크립트가 없다
//     OK-SCRIPTS <개수>                          문서가 부르는 스크립트가 모두 있다
//     UNKNOWN-HOOK <파일>                        이벤트 이름이 아닌 핸들러 파일
//     DEPRECATED-CONFIG <절>.<키> → hooks/<이벤트>.ts   옛 설정 칸
//     UNANSWERED <id> <설명>                     10분 이상 답이 없는 질문이 있다
//     SKIP-QUESTIONS <이유>                      질문 상태를 조회하지 못했다
//     질문이 많은 Run 의 조회 범위 안내는 stderr 로 낸다(lib/questions.ts 머리 주석).
//
// 종료 코드:
//     0  STALE, MISSING, UNANSWERED 가 없다(SKIP, UNKNOWN-HOOK, DEPRECATED-CONFIG, HOOK-FAIL 줄은 있을 수 있다)
//     1  STALE, MISSING 이나 UNANSWERED 가 있다
//     2  사용법 오류

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ConfigError, DEPRECATED_KEYS, loadConfig } from './lib/config.ts'
import { fire, unknownHandlers } from './lib/events.ts'
import { isFile, real, realPath } from './lib/fs.ts'
import { defaultBase, mainCheckout } from './lib/git.ts'
import { run } from './lib/proc.ts'
import { ageSeconds, snapshot } from './lib/questions.ts'

const USAGE =
  '사용법: orch-doctor.ts [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version] [--run ID] [--skip-questions] [--repo DIR]'
const SHA = /^[0-9a-f]{7,40}$/
const REF = /(?:\$(?:(?<sibling>[A-Z][A-Z0-9_]*)_)?SKILL_DIR\/|\]\((?<up>(?:\.\.\/)*))scripts\/(?<name>[A-Za-z0-9_.-]+)/g
const GIT_TIMEOUT_MS = 20_000
const OVERDUE_SEC = 600
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])

type Checked = { lines: string[]; code: number }

function git(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): { code: number; out: string } {
  // ls-remote 가 ssh 나 인증을 표준 입력으로 물으면 스킬을 열 때 멈춘다. 입력을 막고 시간을 제한한다
  const env = {
    ...opts.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
  }
  const done = run(['git', ...args], { cwd: opts.cwd, env, input: '', timeoutMs: GIT_TIMEOUT_MS })
  return { code: done.code, out: done.stdout.trim() }
}

// 디렉터리 내용의 git tree hash. 임시 저장소에 쓰므로 원본과 clone 을 건드리지 않는다.
function treeHash(directory: string, excludes: string): string | null {
  const tmp = mkdtempSync(join(tmpdir(), 'orch-doctor-'))
  try {
    const env = { GIT_DIR: join(tmp, 'git'), GIT_INDEX_FILE: join(tmp, 'index'), GIT_WORK_TREE: directory }
    git(['init', '-q'], { env })
    const config = isFile(excludes) ? ['-c', `core.excludesFile=${excludes}`] : []
    if (git([...config, 'add', '-A', '.'], { env, cwd: directory }).code !== 0) return null
    const written = git(['write-tree'], { env })
    return written.code === 0 ? written.out : null
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// [plugins 디렉터리, 마켓플레이스, 플러그인, 설치 sha]. 설치 캐시가 아니면 null.
function installLayout(skillDir: string): [string, string, string, string] | null {
  const parents: string[] = []
  for (let dir = dirname(skillDir); parents.length < 5; dir = dirname(dir)) {
    parents.push(dir)
    if (dirname(dir) === dir) break
  }
  if (parents.length < 5 || basename(parents[3]) !== 'cache' || !SHA.test(basename(parents[0]))) return null
  return [parents[4], basename(parents[2]), basename(parents[1]), basename(parents[0])]
}

function marketplaceClone(plugins: string, marketplace: string): string | null {
  let location: unknown
  try {
    const known = JSON.parse(readFileSync(join(plugins, 'known_marketplaces.json'), 'utf8')) as Record<string, { installLocation?: unknown }>
    location = known[marketplace].installLocation
  } catch {
    return null
  }
  if (typeof location !== 'string') return null
  try {
    statSync(join(location, '.git'))
    return location
  } catch {
    return null
  }
}

function checkVersion(skillDir: string, remote: string | undefined, branch: string): Checked {
  const layout = installLayout(skillDir)
  if (!layout) return { lines: [`SKIP-VERSION 설치 캐시가 아니다: ${skillDir}`], code: 0 }
  const [plugins, marketplace, plugin, installed] = layout
  const clone = marketplaceClone(plugins, marketplace)
  let found: { code: number; out: string }
  if (remote) found = git(['ls-remote', remote, `refs/heads/${branch}`])
  else if (clone) found = git(['-C', clone, 'ls-remote', 'origin', `refs/heads/${branch}`])
  else return { lines: [`SKIP-VERSION 마켓플레이스 clone 을 찾지 못했다: ${marketplace}`], code: 0 }
  const latest = found.code === 0 && found.out ? found.out.split(/\s+/)[0] : ''
  if (!latest) return { lines: [`SKIP-VERSION 원본 ${branch} 의 커밋을 읽지 못했다(오프라인이면 그대로 진행한다)`], code: 0 }
  if (latest.startsWith(installed) || installed.startsWith(latest)) return { lines: [`OK-VERSION ${installed}`], code: 0 }
  if (clone) {
    const upstream = git(['-C', clone, 'rev-parse', '--verify', '-q', `${latest}:${basename(skillDir)}`])
    if (upstream.code === 0 && upstream.out === treeHash(skillDir, join(clone, '.gitignore'))) {
      return { lines: [`OK-VERSION ${installed}`], code: 0 }
    }
  }
  return {
    lines: [
      `STALE ${installed} ${latest.slice(0, 12)}`,
      `  claude plugin marketplace update ${marketplace}`,
      `  claude plugin update ${plugin}@${marketplace}`,
    ],
    code: 1,
  }
}

// skillDir 아래의 .md. tests 폴더 안은 뺀다. 링크된 폴더는 따라가지 않는다. 경로 마디 차례로 정렬한다.
function markdownFiles(skillDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md') && isFile(full)) found.push(full)
    }
  }
  walk(skillDir)
  const parts = (file: string) => relative(skillDir, file).split(sep)
  return found
    .filter((file) => !parts(file).slice(0, -1).includes('tests'))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)]
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
      }
      return x.length - y.length
    })
}

function exists(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}

function checkScripts(skillDir: string): Checked {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const doc of markdownFiles(skillDir)) {
    const rows = readFileSync(doc, 'utf8').split(/\r\n|\r|\n/)
    rows.forEach((text, index) => {
      for (const m of text.matchAll(REF)) {
        const { sibling, up, name } = m.groups as { sibling?: string; up?: string; name: string }
        let target: string
        if (sibling) target = join(dirname(skillDir), sibling.toLowerCase().replaceAll('_', '-'), 'scripts', name)
        else if (up === undefined) target = join(skillDir, 'scripts', name)
        else target = realPath(resolve(dirname(doc), up, 'scripts', name))
        seen.add(target)
        if (!exists(target)) {
          const shown = sibling ? relative(dirname(skillDir), target) : `scripts/${name}`
          lines.push(`MISSING ${relative(skillDir, doc)}:${index + 1} ${shown}`)
        }
      }
    })
  }
  if (lines.length === 0) lines.push(`OK-SCRIPTS ${seen.size}`)
  return { lines, code: lines.some((line) => line.startsWith('MISSING')) ? 1 : 0 }
}

function checkRepo(repo: string): string[] {
  const lines = unknownHandlers(repo).map((file) => `UNKNOWN-HOOK ${file}`)
  try {
    const config = loadConfig(repo)
    for (const { section, key, event } of DEPRECATED_KEYS) {
      const values = config[section]
      if (values && Object.hasOwn(values, key)) lines.push(`DEPRECATED-CONFIG ${section}.${key} → hooks/${event}.ts`)
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`orch-doctor: 설정 파일의 옛 칸을 보지 못했다: ${e.message}\n`)
  }
  return lines
}

function checkQuestions(runId: string | null): Checked & { pending: string[] } {
  let found
  try {
    found = snapshot(runId)
  } catch (e) {
    const reason = String((e as Error)?.message ?? e).replace(/\r?\n|\r/g, ' ')
    return { lines: [`SKIP-QUESTIONS ${reason}`], code: 0, pending: [] }
  }
  // 조회를 마친 뒤의 시각으로 잰다. 조회가 오래 걸려도 그만큼 질문이 덜 늦은 것으로 보이지 않게 한다
  const now = Date.now() / 1000
  const overdue = found.pending.filter((m) => ageSeconds(m, now) >= OVERDUE_SEC)
  return {
    lines: overdue.map((m) => `UNANSWERED ${String(m.id)} 10분 이상 답이 없다 (Run ${found.run})`),
    code: overdue.length > 0 ? 1 : 0,
    pending: found.pending.map((m) => String(m.id)),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 이 Run 의 살아 있는 대기(wait-important) pid. ps 를 읽지 못하면 빈 목록이다.
function waiterPids(runId: string): number[] {
  const done = run([process.env.PS || 'ps', '-axo', 'pid=,command='])
  if (done.code !== 0) {
    process.stderr.write(`orch-doctor: 프로세스 목록을 읽지 못했다(ps 종료 코드 ${done.code}): ${done.stderr.trim()}\n`)
    return []
  }
  const word = new RegExp(`(?<![\\w-])${escapeRegExp(runId)}(?![\\w-])`)
  const pids: number[] = []
  for (const line of done.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const command = m[2]
    if (pid === process.pid || !command.includes('wait-important') || !word.test(command)) continue
    if (SHELLS.has(basename(command.split(/\s+/)[0]).replace(/^-+/, ''))) continue
    pids.push(pid)
  }
  return pids
}

async function main(argv: string[]): Promise<number> {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        'skill-dir': { type: 'string' },
        remote: { type: 'string' },
        branch: { type: 'string', default: 'main' },
        'skip-version': { type: 'boolean', default: false },
        run: { type: 'string' },
        'skip-questions': { type: 'boolean', default: false },
        repo: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch (e) {
    process.stderr.write(`${USAGE}\norch-doctor: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const skillDir = real(values['skill-dir'] ?? fileURLToPath(new URL('..', import.meta.url)))
  if (!isFile(join(skillDir, 'SKILL.md'))) {
    process.stderr.write(`orch-doctor: SKILL.md 가 없다: ${skillDir}\n`)
    return 2
  }
  const repo = mainCheckout(values.repo ?? process.cwd())
  const runId = values.run ?? null

  const version = values['skip-version'] ? { lines: [], code: 0 } : checkVersion(skillDir, values.remote, values.branch as string)
  const scripts = checkScripts(skillDir)
  const repoLines = checkRepo(repo)
  const questions = values['skip-questions'] ? { lines: [], code: 0, pending: [] } : checkQuestions(runId)
  process.stdout.write(`${[...version.lines, ...scripts.lines, ...repoLines, ...questions.lines].join('\n')}\n`)

  if (runId) {
    try {
      await fire(
        'session-resume',
        { loop_alive: false, waiters: waiterPids(runId), unanswered: questions.pending },
        { repo, base: defaultBase(repo) ?? '', run: runId },
      )
    } catch (e) {
      // 진단 줄은 이미 냈다. 이벤트 실행기의 오류(설정 파일 오류 포함)로 진단 결과의 종료 코드를 바꾸지 않는다
      process.stderr.write(`orch-doctor: session-resume 을 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
    }
  }
  return Math.max(version.code, scripts.code, questions.code)
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    process.stderr.write(`orch-doctor: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  },
)
