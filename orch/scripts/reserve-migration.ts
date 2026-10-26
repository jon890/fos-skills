// worker 가 Flyway 마이그레이션 파일을 만들기 전에 다음 번호를 잠금을 걸고 예약한다. 근거는 docs/adr/017-orch-migration-reserve.md 다.
// 파일은 만들지 않는다. 경로만 돌려주고 worker 가 그 이름으로 만든다. 명령이 만들면 다른 worktree 의 경로와 섞인다.
//
// 사용법:
//     reserve-migration.ts --repo DIR --module M --name TEXT [--branch B] [--base B] [--again]
//     reserve-migration.ts --repo DIR --prune
//
//     --repo    대상 저장소. 주 checkout 으로 바꿔 쓴다. 예약 파일과 잠금은 그 주 checkout 의 <orch 루트>/state/ 에 있다
//     --module  config.json 의 migrations.dirs 에 있는 모듈 이름. 없으면 사용법 오류다
//     --name    마이그레이션 설명. 영문으로 준다. 파일 이름 조각(lib/reservations.ts 의 slug)으로 바꿔 비면 사용법 오류다
//     --branch  예약할 브랜치. 기본은 작업 디렉터리의 `git branch --show-current` 다. worker 는 자기 worktree 에서 부른다. 비면 사용법 오류다
//     --base    기준 브랜치. 기본은 origin/HEAD(lib/git.ts 의 defaultBase), 그것도 없으면 main 이다
//     --again   같은 브랜치, 모듈, 설명의 예약을 버리고 새 번호를 받는다
//     --prune   번호를 받지 않고 정리만 한다. 형식이 틀린 예약도 파일에서 뺀다. --repo 밖의 옵션과 함께 주면 사용법 오류다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// 번호: base 최고, 열린 PR 이 더한 그 모듈 마이그레이션, 남은 예약 가운데 가장 큰 것의 첫 자리에 1 을 더한다.
//     같은 브랜치, 모듈, 설명의 예약이 있으면 그 예약을 다시 준다. 그 번호가 base 최고 이하가 됐거나(다른 PC 에서 같은 번호가 머지됨)
//     다른 브랜치의 열린 PR 이나 다른 예약과 같으면 새로 정한다. 판정은 lib/reservations.ts 의 choose 가 소유한다.
//     열린 PR 은 base 를 가리지 않고 모두 센다. 다른 base 로 가는 PR 의 번호도 나중에 같은 base 에 모일 수 있어 피하는 쪽을 고른다.
//
// 순서: 네트워크 조회는 잠금 밖에서 먼저 하고, 잠금 안에서는 파일만 다룬다.
//     1. 잠금 밖: 예약을 읽고 예약마다 정리 판정을 한다. --prune 이 아니면 `git fetch --quiet origin <base>`,
//        `git ls-tree -r --name-only origin/<base> -- <모듈 폴더>` 로 base 최고를, `gh pr list --state open --limit 200
//        --json number,headRefName,baseRefName,files` 로 열린 PR 의 마이그레이션을 읽는다. 하나라도 실패하면 예약하지 않는다.
//        열린 PR 이 200 개 이상이면 목록이 잘렸을 수 있어 실패로 본다.
//        모르는 번호를 피한 척 예약하면 겹친다. 정리 판정의 실패는 그 항목을 남길 뿐 실패가 아니다
//     2. 예약 잠금(lib/reservations.ts 의 lockFile)을 잡는다. RESERVE_LOCK_WAIT_MS 동안 잡지 못하면 LOCK-TIMEOUT 이다
//     3. 잠금 안: 예약을 다시 읽고 1 의 정리 판정을 (branch, module, name, at) 이 같은 항목에만 적용한다. 그 사이 더해지거나
//        --again 으로 바뀐 항목은 판정하지 않은 것으로 보고 남긴다. 판정은 근거와 함께 넘긴다(merged 나 gone).
//        근거가 gone(브랜치 없음)인 항목은 지우기 직전에 `git show-ref --verify --quiet refs/heads/<branch>` 로 로컬 브랜치를
//        한 번 더 보고, 0(있음)이면 남긴다. 1 과 3 사이에 같은 이름의 브랜치가 다시 생겨 그 예약을 reused 로 받았을 수 있기 때문이다.
//        로컬 git 만 보고 네트워크는 부르지 않는다. 근거가 merged(예약 뒤 머지)인 항목은 다시 보지 않고 지운다.
//        쌓인 PR 처럼 다른 base 로 머지된 예약은 번호가 main 최고보다 클 수 있어, 로컬 브랜치가 남는 동안 main 쪽 PR 을 늘 막기 때문이다.
//        그래서 다른 base 로 머지된 브랜치에서 같은 모듈과 설명으로 다시 부른 reused 예약은 같은 순간의 정리가 지울 수 있다.
//        쌓인 PR 이 main 쪽 PR 을 막지 않게 하려고 고른 절충이다.
//        머지됨은 시간이 지나도 뒤집히지 않고, 예약 파일을 잠금 안에서 다시 읽으므로 동시 예약도 서로 다른 번호를 받는다
//     4. 쓰기 직전에 잠금이 아직 내 것인지 본다. 아니면 쓰지 않고 LOCK-LOST 다. 죽은 잠금을 세 실행이 함께 회수하는 경합을 막는다
//        (lib/events.ts 의 「잠금」 이 적은 보장 범위)
//     5. 잠금을 푼다(예외 포함)
//
// 정리 판정(예약마다. 같은 브랜치의 조회는 한 번만 한다):
//     `gh pr list --state all --head <branch> --limit 20 --json state,mergedAt,closedAt`
//       OPEN 이 있으면 남긴다. 예약 시각(at) 뒤에 머지된(mergedAt) PR 이 있으면 지운다(근거 merged). 브랜치 이름을 다시 써 남은 옛 PR 은 세지 않는다.
//       머지 없이 닫힌 PR 은 다시 열 수 있어 세지 않는다. PR 이 없거나, 닫힌 것뿐이거나, 머지가 모두 at 이전이면 브랜치를 본다.
//       gh 조회 실패는 판정 못 함이다
//     `git ls-remote --heads origin <branch>`  0 이고 그 브랜치 줄이 없으면 원격에 없음, 있으면 있음, 0 이 아니면 판정 못 함
//     `git show-ref --verify --quiet refs/heads/<branch>`  0 이면 있음, 1 이면 없음, 그 밖은 판정 못 함
//     둘 다 없음이면 지운다(근거 gone. 잠금 안에서 로컬 브랜치를 다시 본다). 하나라도 있음이면 남긴다. 그 밖은 판정 못 함이라 남긴다. 지우면 그 번호가 다시 나가기 때문이다
//
// 출력(stdout):
//     PRUNED <module> <label> <branch>      정리로 지운 항목마다. 아래 끝 줄보다 앞에 낸다
//     RESERVED <module> <label> <path>      예약했다. path 는 저장소 루트 기준이다. 다시 준 예약이면 끝에 ` reused`,
//                                           번호가 무효가 되어 새로 정했으면 ` renewed` 를 붙인다. --again 은 붙이지 않는다
//     PRUNED-INVALID <건너뛴 수>            --prune 이 형식이 틀린 예약을 파일에서 뺐다. PRUNE-DONE 바로 앞에 낸다.
//                                           상주 루프는 예약 파일에 형식이 틀린 항목이 있으면 마이그레이션 PR 을 멈추므로,
//                                           코디네이터가 --prune 으로 풀 수 있게 지울 항목이 없어도 다시 쓴다
//     PRUNE-DONE <지운 수>                  --prune 이 끝났다. 지운 것이나 형식이 틀린 예약이 있을 때만 파일에 쓴다
//     LOOKUP-FAIL <이유>                    base 나 열린 PR 을 읽지 못함(200 개 이상이라 잘렸을 수 있음 포함), 예약 파일을 읽지 못함,
//                                           예약 파일 쓰기 실패, 그 밖의 예기치 않은 오류(이유는 오류 메시지 한 줄)
//     LOCK-TIMEOUT <잠금 경로>              잠금을 잡지 못했다
//     LOCK-LOST <잠금 경로>                 쓰기 직전에 잠금이 내 것이 아니었다. 쓰지 않았다
//     형식이 틀려 건너뛴 예약이 있으면 stderr 에 `경고: 형식이 틀린 예약 <n> 개를 건너뛴다. 다음 쓰기에서 빠진다` 를 낸다.
//
// 종료 코드: 0 예약함(reused, renewed 포함)이나 PRUNE-DONE, 1 LOOKUP-FAIL(그 밖의 예기치 않은 오류도 LOOKUP-FAIL 줄을 낸다),
//     2 사용법 오류(설정 파일 오류 포함), 4 LOCK-TIMEOUT 이나 LOCK-LOST
//
// 환경 변수:
//     RESERVE_LOCK_WAIT_MS  잠금을 기다리는 최대 시간(밀리초). 기본 10000. 0 이상의 정수가 아니면 기본값을 쓴다
//     GH                    gh 실행 파일(lib/gh.ts). 기본 gh
//     ORCH_DIR              orch 루트(lib/paths.ts). 기본은 주 checkout 의 .orch

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { autoMergeConfig, maxByModule, migrationOf } from './lib/auto-merge.ts'
import type { Migration } from './lib/auto-merge.ts'
import { ConfigError, loadConfig } from './lib/config.ts'
import { acquireLock, ownsLock, releaseLock } from './lib/events.ts'
import { ghJson } from './lib/gh.ts'
import { defaultBase, git, mainCheckout } from './lib/git.ts'
import { makeParent } from './lib/paths.ts'
import { addedPaths, choose, lockFile, prune, readReservations, slug, writeReservations } from './lib/reservations.ts'
import type { Reservation } from './lib/reservations.ts'

const USAGE = [
  '사용법: reserve-migration.ts --repo DIR --module M --name TEXT [--branch B] [--base B] [--again]',
  '        reserve-migration.ts --repo DIR --prune',
].join('\n')
const LOCK_WAIT_MS = 10_000
const OPEN_FIELDS = 'number,headRefName,baseRefName,files'
const OPEN_LIMIT = 200

class Usage extends Error {}

type Target = { module: string; name: string; branch: string; base: string; again: boolean; dir: string; dirs: Record<string, string> }
type Presence = 'present' | 'absent' | null
// 정리 판정. merged 는 예약 뒤 머지, gone 은 브랜치가 원격과 로컬에 모두 없음이라 지운다. false 남김, null 판정 못 함
type Verdict = 'merged' | 'gone' | false | null

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ')
}

function say(line: string): void {
  process.stdout.write(`${line}\n`)
}

function lookupFail(reason: string): number {
  say(`LOOKUP-FAIL ${oneLine(reason)}`)
  return 1
}

function lockWaitMs(): number {
  const raw = process.env.RESERVE_LOCK_WAIT_MS ?? ''
  return /^\d+$/.test(raw) ? Number(raw) : LOCK_WAIT_MS
}

// 잠금 밖의 판정을 잠금 안에서 다시 읽은 목록에 붙이는 열쇠. --again 으로 바뀐 항목은 at 이 달라 옛 판정이 붙지 않는다
function verdictKey(r: Reservation): string {
  return JSON.stringify([r.branch, r.module, r.name, r.at])
}

function remoteBranch(repo: string, branch: string): Presence {
  const done = git(repo, ['ls-remote', '--heads', 'origin', branch])
  if (done.code !== 0) return null
  // ls-remote 의 패턴은 끝이 맞는 ref 도 낸다(x/<branch>). 그 브랜치 줄만 센다
  return done.stdout.split('\n').some((line) => line.endsWith(`\trefs/heads/${branch}`)) ? 'present' : 'absent'
}

function localBranch(repo: string, branch: string): Presence {
  const done = git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (done.code === 0) return 'present'
  return done.code === 1 ? 'absent' : null
}

// 예약마다의 정리 판정. merged 와 gone 은 지움(근거), false 남김, null 판정 못 함(남김). 같은 브랜치의 조회는 한 번만 한다
function pruneJudge(repo: string): (r: Reservation) => Verdict {
  const prs = new Map<string, Record<string, unknown>[] | null>()
  const branches = new Map<string, Presence>()
  const time = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : Number.NaN)
  return (r) => {
    if (!prs.has(r.branch)) {
      const got = ghJson<unknown>(['pr', 'list', '--state', 'all', '--head', r.branch, '--limit', '20', '--json', 'state,mergedAt,closedAt'], { cwd: repo })
      prs.set(r.branch, got.ok && Array.isArray(got.data) ? got.data.filter(isObject) : null)
    }
    const rows = prs.get(r.branch) ?? null
    if (rows === null) return null
    if (rows.some((row) => row.state === 'OPEN')) return false
    const at = Date.parse(r.at)
    if (rows.some((row) => time(row.mergedAt) > at)) return 'merged'
    if (!branches.has(r.branch)) {
      const remote = remoteBranch(repo, r.branch)
      const local = localBranch(repo, r.branch)
      branches.set(r.branch, remote === 'present' || local === 'present' ? 'present' : remote === 'absent' && local === 'absent' ? 'absent' : null)
    }
    const state = branches.get(r.branch) ?? null
    return state === null ? null : state === 'absent' ? 'gone' : false
  }
}

// base 최고와 열린 PR 의 그 모듈 마이그레이션. 하나라도 읽지 못하면 error 다
function lookupNumbers(
  repo: string,
  target: Target,
): { ok: true; baseMax: Migration | null; open: { branch: string; migrations: Migration[] }[] } | { ok: false; error: string } {
  const { base, dir, dirs, module } = target
  const fetched = git(repo, ['fetch', '--quiet', 'origin', base])
  if (fetched.code !== 0) return { ok: false, error: `origin ${base} 를 받지 못했다(종료 코드 ${fetched.code}): ${fetched.stderr}` }
  const listed = git(repo, ['ls-tree', '-r', '--name-only', `origin/${base}`, '--', dir])
  if (listed.code !== 0) return { ok: false, error: `origin/${base} 의 ${dir} 를 읽지 못했다(종료 코드 ${listed.code}): ${listed.stderr}` }
  const paths = listed.stdout.split('\n').filter((line) => line)
  const baseMax = maxByModule(paths, dirs).get(module) ?? null
  const got = ghJson<unknown>(['pr', 'list', '--state', 'open', '--limit', String(OPEN_LIMIT), '--json', OPEN_FIELDS], { cwd: repo })
  if (!got.ok) return { ok: false, error: got.error }
  if (!Array.isArray(got.data)) return { ok: false, error: '열린 PR 의 파일 목록이 목록이 아니다' }
  if (got.data.length >= OPEN_LIMIT) return { ok: false, error: `열린 PR 이 ${OPEN_LIMIT} 개 이상이라 목록이 잘렸을 수 있다` }
  const open = got.data.filter(isObject).map((row) => ({
    // 브랜치를 모르는 행은 다른 브랜치로 센다. 빼는 것보다 피하는 쪽이 겹치지 않는다
    branch: typeof row.headRefName === 'string' ? row.headRefName : '',
    migrations: addedPaths(row.files)
      .map((path) => migrationOf(path, dirs))
      .filter((m): m is Migration => m !== null && m.module === module),
  }))
  return { ok: true, baseMax, open }
}

function parse(argv: string[]): { repo: string; prune: boolean; values: Record<string, string | boolean | undefined> } {
  const options = {
    repo: { type: 'string' },
    module: { type: 'string' },
    name: { type: 'string' },
    branch: { type: 'string' },
    base: { type: 'string' },
    again: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv, options, ['name', 'branch', 'base', 'module']), options }).values
  } catch (e) {
    throw new Usage((e as Error).message)
  }
  if (values.help) return { repo: '', prune: false, values }
  if (!values.repo) throw new Usage('--repo 가 필요하다')
  if (values.prune) {
    const extra = (['module', 'name', 'branch', 'base'] as const).filter((key) => values[key] !== undefined)
    if (extra.length > 0 || values.again) throw new Usage('--prune 은 --repo 와만 준다')
  } else {
    if (!values.module) throw new Usage('--module 이 필요하다')
    if (!values.name) throw new Usage('--name 이 필요하다')
  }
  return { repo: values.repo, prune: values.prune, values }
}

async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parse(argv)
  } catch (e) {
    if (!(e instanceof Usage)) throw e
    process.stderr.write(`${USAGE}\nreserve-migration: ${e.message}\n`)
    return 2
  }
  if (parsed.values.help) {
    say(USAGE)
    return 0
  }
  const repo = mainCheckout(resolve(parsed.repo))

  let target: Target | null = null
  if (!parsed.prune) {
    const values = parsed.values
    let dirs: Record<string, string>
    try {
      dirs = autoMergeConfig(loadConfig(repo)).dirs
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      process.stderr.write(`reserve-migration: ${e.message}\n`)
      return 2
    }
    try {
      const module = values.module as string
      if (!Object.hasOwn(dirs, module)) {
        const known = Object.keys(dirs).sort()
        throw new Usage(`설정의 migrations.dirs 에 모듈 ${module} 이 없다. ${known.length > 0 ? `있는 모듈: ${known.join(', ')}` : 'migrations.dirs 가 비었다'}`)
      }
      const name = values.name as string
      try {
        slug(name)
      } catch (e) {
        throw new Usage((e as Error).message)
      }
      const branch = (values.branch as string | undefined) ?? git(process.cwd(), ['branch', '--show-current']).stdout.trim()
      if (!branch) throw new Usage('--branch 가 없고 작업 디렉터리의 현재 브랜치도 읽지 못했다')
      const base = (values.base as string | undefined) || defaultBase(repo) || 'main'
      target = { module, name, branch, base, again: values.again === true, dir: dirs[module], dirs }
    } catch (e) {
      if (!(e instanceof Usage)) throw e
      process.stderr.write(`${USAGE}\nreserve-migration: ${e.message}\n`)
      return 2
    }
  }

  // 1. 잠금 밖의 조회
  let first
  try {
    first = readReservations(repo)
  } catch (e) {
    return lookupFail(`예약 파일을 읽지 못했다: ${(e as Error).message}`)
  }
  const judge = pruneJudge(repo)
  const verdicts = new Map<string, Verdict>()
  for (const r of first.list) verdicts.set(verdictKey(r), judge(r))
  const lookup = target ? lookupNumbers(repo, target) : null
  if (lookup && !lookup.ok) return lookupFail(lookup.error)

  // 2. 잠금
  const lock = lockFile(repo)
  makeParent(lock, repo)
  if (!(await acquireLock(lock, Date.now() + lockWaitMs()))) {
    say(`LOCK-TIMEOUT ${lock}`)
    return 4
  }
  try {
    // 3. 잠금 안에서는 파일만 다룬다
    let current
    try {
      current = readReservations(repo)
    } catch (e) {
      return lookupFail(`예약 파일을 읽지 못했다: ${(e as Error).message}`)
    }
    if (current.skipped > 0) process.stderr.write(`경고: 형식이 틀린 예약 ${current.skipped} 개를 건너뛴다. 다음 쓰기에서 빠진다\n`)
    // 브랜치 없음으로 지울 항목은 로컬 브랜치를 한 번 더 본다. 그 사이 다시 생긴 브랜치가 받은 예약을 지우지 않는다(머리 주석의 「순서」 3)
    const { kept, removed } = prune(current.list, (r) => {
      const verdict = verdicts.get(verdictKey(r)) ?? null
      if (verdict === 'merged') return true
      if (verdict === 'gone') return localBranch(repo, r.branch) !== 'present'
      return verdict
    })

    let chosen: ReturnType<typeof choose> | null = null
    if (target && lookup?.ok) {
      chosen = choose({
        module: target.module,
        name: target.name,
        branch: target.branch,
        again: target.again,
        dir: target.dir,
        at: new Date().toISOString(),
        baseMax: lookup.baseMax,
        open: lookup.open,
        reservations: kept,
      })
    }
    const next = chosen ? chosen.list : kept
    // --prune 은 형식이 틀린 예약만 있어도 다시 써서 뺀다(머리 주석의 PRUNED-INVALID)
    const dropInvalid = chosen === null && current.skipped > 0
    if (removed.length > 0 || dropInvalid || (chosen !== null && !chosen.reused)) {
      // 4. 쓰기 직전에 잠금을 다시 본다
      if (!ownsLock(lock)) {
        say(`LOCK-LOST ${lock}`)
        return 4
      }
      try {
        writeReservations(repo, next)
      } catch (e) {
        return lookupFail(`예약 파일에 쓰지 못했다: ${(e as Error).message}`)
      }
    }
    for (const r of removed) say(`PRUNED ${r.module} ${r.label} ${r.branch}`)
    if (!chosen) {
      if (dropInvalid) say(`PRUNED-INVALID ${current.skipped}`)
      say(`PRUNE-DONE ${removed.length}`)
      return 0
    }
    const { reservation } = chosen
    const suffix = chosen.reused ? ' reused' : chosen.renewed ? ' renewed' : ''
    say(`RESERVED ${reservation.module} ${reservation.label} ${reservation.path}${suffix}`)
    return 0
  } finally {
    // 5. 예외가 나도 내 잠금은 푼다
    releaseLock(lock)
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    say(`LOOKUP-FAIL ${oneLine(e instanceof Error ? e.message : String(e))}`)
    process.exitCode = 1
  },
)
