// 스킬을 열 때 설치본이 낡지 않았는지, 문서가 부르는 스크립트가 모두 있는지, 저장소의 핸들러와 설정을 본다.
//
// 플러그인 스킬은 체크아웃이 아니라 설치 캐시의 복사본이 실행된다. 캐시가 옛 커밋이면
// 문서가 부르는 스크립트(`spec-line.ts` 같은 것)가 없어 그 단계를 건너뛰게 된다.
// 갱신 명령을 보여 주는 것까지만 하고 갱신은 하지 않는다. 다른 세션이 같은 캐시를 쓰고 있을 수 있다.
//
// Node 버전은 여기서 보지 않는다. 타입 제거를 지원하지 않는 낮은 node 는 이 파일을 읽지 못하고 ERR_UNKNOWN_FILE_EXTENSION 으로 죽는다.
// 그래서 SKILL.md 가 doctor 를 부르기 전에 셸에서 node 버전을 보고, 낮으면 NODE-TOO-OLD 줄을 내고 doctor 를 부르지 않는다.
//
// 사용법:
//     orch-doctor.ts [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version] [--run ID] [--skip-questions] [--repo DIR]
//
//     --skill-dir       볼 스킬 디렉터리. 기본은 이 스크립트의 상위 디렉터리($SKILL_DIR)
//     --remote          원본 저장소. 주지 않으면 설치 경로의 마켓플레이스 clone 의 origin 을 쓴다
//     --branch          원본의 기준 브랜치. 기본 main
//     --skip-version    설치본 비교를 건너뛰고 스크립트 존재만 본다. 저장소 테스트가 스킬마다 이것으로 부른다
//     --run             미답변 질문과 worker 판정을 볼 Run. 주면 session-resume 이벤트도 낸다
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
//     진입점으로 부르는 `$SKILL_DIR/bin/orch.ts <이름>` 은 `bin/orch.ts` 와 `scripts/<이름>.ts` 를 모두 본다.
//
// 저장소 판정(--repo):
//     <orch 루트>/hooks/ 바로 아래의 .ts 가운데 이벤트 이름이 아닌 파일은 UNKNOWN-HOOK 이다(lib/events.ts 의 unknownHandlers).
//     <orch 루트>/config.json 에 5.1.0 에서 지운 옛 칸이 있으면 INVALID-CONFIG 와 종료 코드 1 이다.
//     설정 파일이 깨졌으면 그 이유를 stderr 에 내고 이 판정만 건너뛴다.
//     UNKNOWN-HOOK 과 깨진 JSON 경고는 종료 코드를 바꾸지 않는다. 오타 난 핸들러는 불리지 않아 조용히 빠지므로 알려야 한다.
//
// 설치 기록 판정(늘 본다):
//     `CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)의 `plugins/installed_plugins.json` 에 적힌 모든 플러그인의 installPath 가 실제로 있는지 본다.
//     Orca 가 세션을 새 설정 폴더로 열면 기록의 installPath 가 옛 설정 폴더를 가리킨 채 남을 수 있다. 그 경로에 복사본이 없으면
//     Claude Code 는 그 플러그인을 싣지 않는다(디버그 로그의 `Plugin "<이름>" not cached at <경로>`). 스킬과 슬래시 명령이 통째로 빠지는데
//     위의 설치본 판정은 실린 스킬의 버전만 보므로 알아채지 못한다. 없는 것만 낸다. fos-skills 도 같은 규칙이다.
//     installPath 에서 `/plugins/` 뒤를 현재 설정 폴더의 plugins 아래에 붙인 경로가 있으면 그 경로를 함께 낸다(복사본이 옮겨 간 경우).
//     기록 파일이 없거나 읽지 못하면 판정하지 않는다. 파일은 고치지 않는다. 경고라 종료 코드를 바꾸지 않는다.
//
// 루프 번들 판정(늘 본다):
//     `ps -axo pid=,command=`(PS 환경 변수로 바꾼다)에서 `orch-loop.ts` 와 `--foreground` 가 든 행(상주 루프의 부모)을 읽는다.
//     --tick 자식과 --start 는 뺀다. 스크립트 경로는 첫 낱말(node) 뒤 처음 `/` 로 시작하는 곳부터 `orch-loop.ts` 까지다(경로에 빈칸이 있을 수 있다).
//     그 경로가 설치 캐시 꼴(`<plugins>/cache/<마켓플레이스>/<플러그인>/<sha>/orch/scripts/orch-loop.ts`)이면 같은 `<plugins>` 의
//     installed_plugins.json 에서 `<플러그인>@<마켓플레이스>` 의 installPath 를 읽는다. 루프마다 그 루프를 띄운 프로필의 설치본과 비교한다.
//     installPath 가운데 그 `<sha>` 폴더가 없으면 LOOP-STALE 이다. 이미 고친 결함이 옛 번들의 루프에서 계속 난다.
//     캐시 꼴이 아니면(저장소 체크아웃에서 띄운 개발 중인 루프) 보지 않는다. installed_plugins.json 을 읽지 못하면 판정하지 않는다.
//     다시 띄우는 명령은 그 루프의 Run 코디네이터 세션에서 돌리라는 안내와 함께 낸다. 루프는 띄운 터미널의 Run 명의를 물려받는다
//     (orch-loop.ts 머리 주석의 「명의」). Run 은 그 저장소 loop.json 의 bound_run, 없으면 run 이다. 경고라 종료 코드를 바꾸지 않는다.
//
// worker 판정(--run 을 줄 때):
//     그 Run 의 worker-list 행 가운데 살아 있는 dispatch 이고 터미널의 ownershipState 가 user_owned 인 것을 lib/worker-state.ts 로 판정한다.
//     새 세션에서 띄운 worker 를 Orca 가 user_takeover 로 적어, 일하는 worker 가 사용자에게 넘어간 것처럼 보인다.
//     그 터미널 화면을 읽어 에이전트가 작업 중이면 working, 아니면 taken_over 다. 판정마다 WORKER-STATE 줄을 낸다.
//     worker-list 를 30초 안에 읽지 못하면 SKIP-WORKERS 다. 경고라 종료 코드를 바꾸지 않는다.
//
// session-resume 이벤트(--run 을 줄 때, lib/events.ts 머리 주석의 「이벤트별 필드」):
//     loop_alive  --repo 의 주 checkout 에서 상주 루프가 살아 있는지(lib/loop.ts 의 loopStatus).
//                 죽었으면 `LOOP-DEAD <repo> <이유>` 줄과, 다음 줄에 다시 띄울 orch-loop.ts --start 명령을 낸다. 종료 코드는 바꾸지 않는다.
//                 Run 등록을 아는 살아 있는 루프(loop.json 에 runs 가 있다)에 이 Run 이 등록되지 않았으면 그 루프는 이 Run 을 맡지 않는다.
//                 false 로 보고 `LOOP-DEAD <repo> run <Run> 미등록` 줄과 같은 --start 명령을 낸다(wait-important 의 미등록 판정과 같다).
//                 pid 가 살아 있는 루프 프로세스인데 alive_at 만 오래됐으면(loopStatus 의 recheck) lib/loop.ts 의 recheckMs 를
//                 기다린 뒤 한 번 더 판정한다. 잠들었다 깬 macOS 에서 루프의 타이머가 아직 alive_at 을 쓰지 못했을 수 있다
//     waiters     `ps -axo pid=,command=` 의 행 가운데 명령줄에 `wait-important` 나 `watch-questions` 와 Run id(낱말)가 든 것의 pid.
//                 살아 있는 대기와 질문 감시다. 다음 행은 뺀다.
//                   - `orchestration check` 행. wait-important 가 띄운 자식이라 대기 하나를 두 번 세게 된다
//                   - 셸 행(sh, bash, zsh, dash, fish 가 띄운 `-c` 명령). 대기 자신이 아니라 그것을 띄운 셸이다
//                   - doctor 자신
//                 PS 환경 변수로 ps 실행 파일을 바꾼다. ps 는 LC_ALL=C 로 부른다(wait-important 와 같다)
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
//     INVALID-CONFIG <이유>                       삭제한 옛 설정 칸
//     UNANSWERED <id> <설명>                     10분 이상 답이 없는 질문이 있다
//     SKIP-QUESTIONS <이유>                      질문 상태를 조회하지 못했다. orca 가 조회마다 30초(ORCH_QUESTIONS_TIMEOUT_SEC) 안에 답하지 않은 경우도 여기다
//     PLUGIN-PATH-MISSING <플러그인> <scope> <경로>   설치 기록의 installPath 가 없다. 이어서 현재 설정 폴더에 같은 상대 경로가 있으면 그 경로,
//                                                고치는 방법과 `/reload-plugins` 안내가 온다
//     LOOP-DEAD <repo> <이유>                    --run 을 줬는데 상주 루프가 죽었다. 다음 줄에 다시 띄울 명령이 온다
//     LOOP-STALE <repo> <pid> <번들 sha>          설치되지 않은 번들의 스크립트로 도는 상주 루프. 다음 줄에 안내와 다시 띄울 명령이 온다
//     WORKER-STATE <dispatch> <상태> <근거>       --run 의 살아 있는 dispatch 가운데 user_owned 로 표시된 것의 판정(위 「worker 판정」)
//     SKIP-WORKERS <이유>                         worker 판정을 하지 못했다
//     질문이 많은 Run 의 조회 범위 안내는 stderr 로 낸다(lib/questions.ts 머리 주석).
//
// 종료 코드:
//     0  STALE, MISSING, UNANSWERED, INVALID-CONFIG 가 없다(SKIP, UNKNOWN-HOOK, PLUGIN-PATH-MISSING, LOOP-DEAD, LOOP-STALE, WORKER-STATE, HOOK-FAIL 줄은 있을 수 있다)
//     1  STALE, MISSING, UNANSWERED 나 INVALID-CONFIG 가 있다
//     2  사용법 오류
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError, RemovedConfigError, loadConfig } from './lib/config.ts'
import { fire, unknownHandlers } from './lib/events.ts'
import { isFile, real, realPath } from './lib/fs.ts'
import { defaultBase, mainCheckout } from './lib/git.ts'
import { isRegistered, loopStatus, readLoop, recheckMs } from './lib/loop.ts'
import { run } from './lib/proc.ts'
import { shQuote } from './lib/py.ts'
import { ageSeconds, snapshot } from './lib/questions.ts'
import { workerRows } from './lib/workers.ts'
import { isLive, judge, readScreens, screenHandles } from './lib/worker-state.ts'

const USAGE =
  '사용법: orch-doctor.ts [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version] [--run ID] [--skip-questions] [--repo DIR]'
const SHA = /^[0-9a-f]{7,40}$/
const REF = /(?:\$(?:(?<sibling>[A-Z][A-Z0-9_]*)_)?SKILL_DIR\/|\]\((?<up>(?:\.\.\/)*))scripts\/(?<name>[A-Za-z0-9_.-]+)/g
// 진입점(bin/orch.ts)이 부르는 스크립트. `"$SKILL_DIR/bin/orch.ts" wait-important --run ...` 의 이름이 scripts/ 의 .ts 다
const BIN_REF = /\$SKILL_DIR\/bin\/(?<name>[A-Za-z0-9_.-]+)/g
const VIA_ENTRY = /\$SKILL_DIR\/bin\/orch\.ts"?\s+(?<name>[A-Za-z0-9_][A-Za-z0-9_-]*)/g
const GIT_TIMEOUT_MS = 20_000
const OVERDUE_SEC = 600
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const WORKERS_TIMEOUT_MS = 30_000

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
      const entry = [
        ...[...text.matchAll(BIN_REF)].map((m) => ['bin', `bin/${m.groups?.name}`] as const),
        ...[...text.matchAll(VIA_ENTRY)].map((m) => ['scripts', `scripts/${m.groups?.name}.ts`] as const),
      ]
      for (const [, shown] of entry) {
        const target = join(skillDir, shown)
        seen.add(target)
        if (!exists(target)) lines.push(`MISSING ${relative(skillDir, doc)}:${index + 1} ${shown}`)
      }
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

// 머리 주석의 「설치 기록 판정」. 없는 installPath 마다 줄을 내고, 하나라도 있으면 고치는 방법을 한 번 안내한다.
function checkInstallPaths(configDir: string): string[] {
  let plugins: unknown
  try {
    plugins = (JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: unknown }).plugins
  } catch {
    return []
  }
  if (typeof plugins !== 'object' || plugins === null) return []
  const lines: string[] = []
  for (const [name, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries as { installPath?: unknown; scope?: unknown }[]) {
      const path = entry?.installPath
      if (typeof path !== 'string' || !path || exists(path)) continue
      lines.push(`PLUGIN-PATH-MISSING ${name} ${typeof entry.scope === 'string' ? entry.scope : '-'} ${path}`)
      const tail = path.split(`${sep}plugins${sep}`).slice(1).join(`${sep}plugins${sep}`)
      const moved = tail ? join(configDir, 'plugins', tail) : ''
      if (moved && exists(moved)) lines.push(`  현재 설정 폴더에 같은 경로가 있다: ${moved}`)
    }
  }
  if (lines.length > 0) {
    lines.push(
      '  이 플러그인들은 실리지 않아 스킬과 슬래시 명령이 빠진다. 아래는 사용자가 한다(doctor 는 설치 기록을 고치지 않는다)',
      `  고치기: ${join(configDir, 'plugins', 'installed_plugins.json')} 을 백업한 뒤 installPath 를 위의 현재 설정 폴더 경로로 고치거나, 플러그인을 다시 설치한다(claude plugin install <플러그인>@<마켓플레이스>)`,
      '  반영: /reload-plugins',
    )
  }
  return lines
}

function checkRepo(repo: string): string[] {
  const lines = unknownHandlers(repo).map((file) => `UNKNOWN-HOOK ${file}`)
  try {
    loadConfig(repo)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    if (e instanceof RemovedConfigError) lines.push(`INVALID-CONFIG ${e.message}`)
    else process.stderr.write(`orch-doctor: 설정 파일의 옛 칸을 보지 못했다: ${e.message}\n`)
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

// 이 Run 의 살아 있는 대기(wait-important)와 질문 감시(watch-questions) pid. ps 를 읽지 못하면 빈 목록이다.
function waiterPids(runId: string): number[] {
  const done = run([process.env.PS || 'ps', '-axo', 'pid=,command='], { env: { LC_ALL: 'C' } })
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
    if (pid === process.pid || !word.test(command)) continue
    if (!command.includes('wait-important') && !command.includes('watch-questions')) continue
    // 가짜 orca 의 경로처럼 `wait-important` 가 든 orca 명령줄도 자식 check 다
    if (/\borchestration\s+check\b/.test(command)) continue
    if (SHELLS.has(basename(command.split(/\s+/)[0]).replace(/^-+/, ''))) continue
    pids.push(pid)
  }
  return pids
}

// 머리 주석의 「루프 번들 판정」. 설치 캐시가 아닌 경로나 판정하지 못한 경로는 null 이다
function staleBundle(script: string): { sha: string; installed: string } | null {
  const skillDir = dirname(dirname(script))
  const layout = installLayout(skillDir)
  if (!layout) return null
  const [plugins, marketplace, plugin, sha] = layout
  let entries: unknown
  try {
    entries = (JSON.parse(readFileSync(join(plugins, 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> }).plugins?.[
      `${plugin}@${marketplace}`
    ]
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  const rows = (entries as { installPath?: unknown; scope?: unknown }[]).filter((e) => typeof e?.installPath === 'string')
  if (rows.length === 0) return null
  // 다시 띄울 번들은 worker-ask 와 같이 user 범위를 먼저 고른다
  rows.sort((a, b) => Number(a.scope !== 'user') - Number(b.scope !== 'user'))
  const bundle = real(dirname(skillDir))
  if (rows.some((e) => real(e.installPath as string) === bundle)) return null
  return { sha, installed: join(rows[0].installPath as string, basename(skillDir)) }
}

function staleLoops(): string[] {
  const done = run([process.env.PS || 'ps', '-axo', 'pid=,command='], { env: { LC_ALL: 'C' } })
  if (done.code !== 0) return []
  const lines: string[] = []
  for (const row of done.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(row)
    if (!m || !/\s--foreground(\s|$)/.test(m[3]) || /\s--tick(\s|$)/.test(m[3])) continue
    const found = /(?:^|\s)(\/.*?orch-loop\.ts)(?=\s|$)/.exec(m[3])
    if (!found) continue
    const stale = staleBundle(found[1])
    if (!stale) continue
    const repo = /\s--repo\s+(.+?)(?=\s--|$)/.exec(m[3])?.[1] ?? '<repo>'
    const state = repo === '<repo>' ? null : readLoop(repo)
    const named = typeof state?.bound_run === 'string' && state.bound_run ? state.bound_run : state?.run
    const runId = typeof named === 'string' && named ? named : '<Run>'
    const script = join(stale.installed, 'scripts', 'orch-loop.ts')
    lines.push(
      `LOOP-STALE ${repo} ${m[1]} ${stale.sha}`,
      `  안내: 이 루프는 설치되지 않은 번들(${stale.sha})로 돈다. 아래 두 명령은 그 루프의 Run(${runId}) 코디네이터 세션에서 돌린다. ` +
        '다른 세션에서 띄우면 새 루프가 그 세션의 Run 명의를 물려받아 원래 Run 의 질문을 읽지 못한다',
      `  node --disable-warning=ExperimentalWarning "${script}" --repo ${shQuote(repo)} --stop --all`,
      `  node --disable-warning=ExperimentalWarning "${script}" --repo ${shQuote(repo)} --run ${shQuote(runId)} --start`,
    )
  }
  return lines
}

// 머리 주석의 「worker 판정」. 살아 있는 dispatch 가운데 터미널이 user_owned 로 표시된 것만 판정해 낸다
function checkWorkers(runId: string): string[] {
  const got = workerRows(runId, { timeoutMs: WORKERS_TIMEOUT_MS })
  if (!got.ok) return [`SKIP-WORKERS ${got.error}`]
  const lines: string[] = []
  for (const row of got.rows) {
    const resource = row.resource as Record<string, unknown> | undefined
    if (!isLive(row) || resource?.ownershipState !== 'user_owned') continue
    const verdict = judge({ rows: [row], screens: readScreens(screenHandles([row])) })
    lines.push(`WORKER-STATE ${String(row.dispatchId ?? '?')} ${verdict.state} ${verdict.reason}`)
  }
  return lines
}

async function main(argv: string[]): Promise<number> {
  let values
  try {
    const options = {
      'skill-dir': { type: 'string' },
      remote: { type: 'string' },
      branch: { type: 'string', default: 'main' },
      'skip-version': { type: 'boolean', default: false },
      run: { type: 'string' },
      'skip-questions': { type: 'boolean', default: false },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
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
  const installLines = checkInstallPaths(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  const repoLines = checkRepo(repo)
  const questions = values['skip-questions'] ? { lines: [], code: 0, pending: [] } : checkQuestions(runId)
  let loop = runId ? loopStatus(repo, Date.now()) : null
  if (loop && !loop.alive && loop.recheck) {
    await sleep(recheckMs())
    loop = loopStatus(repo, Date.now())
  }
  // 살아 있어도 이 Run 이 등록되지 않았으면 이 Run 에는 루프가 없다(머리 주석의 loop_alive)
  const unregistered = loop?.alive === true && Array.isArray(loop.state.runs) && !isRegistered(repo, runId as string)
  const loopLines =
    loop && (!loop.alive || unregistered)
      ? [
          loop.alive ? `LOOP-DEAD ${repo} run ${runId} 미등록` : `LOOP-DEAD ${repo} ${loop.reason}`,
          `  node --disable-warning=ExperimentalWarning "${join(skillDir, 'scripts', 'orch-loop.ts')}" --repo ${shQuote(repo)} --run ${shQuote(runId as string)} --start`,
        ]
      : []
  const workerLines = runId ? checkWorkers(runId) : []
  process.stdout.write(`${[...version.lines, ...scripts.lines, ...installLines, ...repoLines, ...questions.lines, ...loopLines, ...staleLoops(), ...workerLines].join('\n')}\n`)

  if (runId) {
    try {
      await fire(
        'session-resume',
        { loop_alive: (loop?.alive ?? false) && !unregistered, waiters: waiterPids(runId), unanswered: questions.pending },
        { repo, base: defaultBase(repo) ?? '', run: runId },
      )
    } catch (e) {
      // 진단 줄은 이미 냈다. 이벤트 실행기의 오류(설정 파일 오류 포함)로 진단 결과의 종료 코드를 바꾸지 않는다
      process.stderr.write(`orch-doctor: session-resume 을 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
    }
  }
  return Math.max(version.code, scripts.code, questions.code, repoLines.some((line) => line.startsWith('INVALID-CONFIG')) ? 1 : 0)
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
