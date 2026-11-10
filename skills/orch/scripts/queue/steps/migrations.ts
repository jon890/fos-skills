// 코디네이터의 큐도 자동 머지와 같은 번호 순서와 base 최고 번호 검사를 쓴다.
import { autoMergeConfig, judgeMigrations, maxByModule, migrationOf, queueOrder, watchedDirs } from '../../lib/auto-merge.ts'
import type { Migration, QueueItem } from '../../lib/auto-merge.ts'
import { loadConfig } from '../../lib/config.ts'
import { ghJson } from '../../lib/gh.ts'
import { addedPaths } from '../../lib/reservations.ts'
import type { GateReason } from './gate.ts'
import { HeadChanged, Usage } from './model.ts'
import type { StepState } from './model.ts'
import { git, out } from './runtime.ts'

function migrationDirs(repo: string): Record<string, string[]> {
  const config = loadConfig(repo)
  if (!config.migrations) return {}
  const { dirs, watch } = autoMergeConfig(config)
  return watchedDirs(dirs, watch)
}

function migrations(files: unknown, dirs: Record<string, string[]>): Migration[] {
  return addedPaths(files).flatMap((path) => {
    const found = migrationOf(path, dirs)
    return found ? [found] : []
  })
}

// 순서 제약을 합쳐 위상 정렬한다. 수동 묶음은 유지하고, 자동 묶음과 모순되면 시작 전에 거절한다.
export function orderedMigrations(items: QueueItem[], manual: number[][]): { order: number[]; chains: number[][] } {
  const automatic = queueOrder(items)
  if (automatic.order.length !== items.length) throw new Usage('마이그레이션 모듈 사이의 번호 순서가 모순된다. PR 을 나누거나 번호를 다시 받는다')
  const chains = [...manual, ...automatic.chains]
  const edges = new Map(automatic.order.map((pr) => [pr, new Set<number>()]))
  for (const chain of chains) for (let i = 1; i < chain.length; i++) edges.get(chain[i - 1])!.add(chain[i])
  const order: number[] = []
  const remaining = new Set(automatic.order)
  while (remaining.size) {
    const next = automatic.order.find((pr) => remaining.has(pr) && ![...remaining].some((before) => edges.get(before)!.has(pr)))
    if (next === undefined) throw new Usage('--chain 과 마이그레이션 번호 순서가 모순된다. 낮은 번호 PR 이 먼저 오도록 묶음을 고친다')
    order.push(next)
    remaining.delete(next)
  }
  // select.ts 는 PR 하나를 묶음 하나에만 둔다. 겹치는 자동·수동 묶음을 합친다.
  const groups: Set<number>[] = []
  for (const chain of chains) {
    const merged = new Set(chain)
    for (let i = groups.length - 1; i >= 0; i--) {
      if (![...groups[i]].some((pr) => merged.has(pr))) continue
      for (const pr of groups.splice(i, 1)[0]) merged.add(pr)
    }
    groups.push(merged)
  }
  return { order, chains: groups.map((group) => order.filter((pr) => group.has(pr))) }
}

export function orderQueueMigrations(state: StepState): void {
  const dirs = migrationDirs(state.repoDir)
  if (!Object.keys(dirs).length) return
  const items = state.o.items.map((item, i) => {
    const pr = Number(item.split(':')[0])
    const read = ghJson<{ files: unknown; state: string }>(['pr', 'view', String(pr), '--json', 'files,state', '--jq', '.'], { cwd: state.repoDir, cache: false })
    if (!read.ok) throw new Usage(`#${pr} 마이그레이션 파일을 읽지 못했다`)
    return { pr, readyAt: new Date(i).toISOString(), migrations: read.data.state === 'MERGED' ? [] : migrations(read.data.files, dirs) }
  })
  const result = orderedMigrations(items, state.o.chains.map((chain) => chain.map(Number)))
  const byPr = new Map(state.o.items.map((item) => [Number(item.split(':')[0]), item]))
  const ordered = result.order.map((pr) => byPr.get(pr)!)
  if (ordered.some((item, i) => item !== state.o.items[i])) out(`QUEUE-ORDER ${result.order.join(' ')}: 마이그레이션 번호가 낮은 PR 부터, --chain 순서를 지켜 머지한다`)
  state.o.items = ordered
  state.o.chains = result.chains.map((chain) => chain.map(String))
}

// 조회 실패도 머지를 막는다. gate 와 실제 머지 직전에 모두 새 base 를 받아 확인한다.
export function migrationReasons(state: StepState): GateReason[] {
  const dirs = migrationDirs(state.repoDir)
  if (!Object.keys(dirs).length) return []
  const p = state.p
  const read = ghJson<{ files: unknown; headRefOid: string }>(['pr', 'view', p.n, '--json', 'files,headRefOid', '--jq', '.'], { cwd: state.repoDir, cache: false })
  if (!read.ok) return [{ kind: 'lookup', text: '마이그레이션 파일 조회 실패' }]
  if (read.data.headRefOid !== p.ph) throw new HeadChanged(`${p.n} 마이그레이션 검사 중 HEAD 가 바뀌었다`)
  const mine = migrations(read.data.files, dirs)
  if (!mine.length) return []
  if (git('fetch', '--quiet', 'origin', p.base).code !== 0) return [{ kind: 'lookup', text: `마이그레이션 검사: origin/${p.base} fetch 실패` }]
  const listed = git('ls-tree', '-r', '--name-only', `origin/${p.base}`, '--', ...new Set(Object.values(dirs).flat()))
  if (listed.code !== 0) return [{ kind: 'lookup', text: 'base 마이그레이션 파일 조회 실패' }]
  return judgeMigrations(Number(p.n), mine, maxByModule(listed.stdout.trim().split('\n'), dirs), []).clashes.map((clash) => ({
    kind: 'migration', text: `${clash.module} ${clash.label}: ${clash.reason}. 기존 예약 인자로 orch queue reserve ... --again 을 실행해 새 번호를 받고 파일을 고친다`,
  }))
}
