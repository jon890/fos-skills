// 상주 루프의 「뒤처진 PR 최신화」 판정 한 벌이다. 루프(orch-loop.ts)가 읽기, 기록, 부르기를 하고 여기는 설정 읽기와 판정만 한다.
// 단계의 차례와 알림은 orch-loop.ts 머리 주석의 「최신화」 가 소유한다. 결정의 배경은 docs/adr/020-orch-loop-refresh.md 다.
//
// 설정(refreshSettings):
//   pipeline.refresh_slots         0 이상의 정수. 기본 0 이고 0 이면 단계가 돌지 않는다. 루프가 건 최신화 가운데
//                                  CI 가 아직 도는 것의 상한이다. CI runner 수보다 작게 둔다(worker 의 push 와 머지 큐도 runner 를 쓴다)
//   pipeline.refresh_worker_paths  정규식 문자열이나 그 목록(Python 정규식, 목록은 `|` 로 잇는다). PR 과 base 가 모두 바꾼 파일이
//                                  맞으면 update-branch 대신 worker 에게 합치기를 보낸다. 계약 버전처럼 글자 충돌은 없어도
//                                  worker 가 판단해야 하는 파일을 적는다
//   queue.require_up_to_date, queue.up_to_date_when, queue.shared_paths, queue.unit_prefix, queue.unit_groups, queue.docs_glob
//                                  머지 큐(merge-with-finish 가 넘기는 옵션)와 같은 값으로 판정한다. 차례가 온 PR 에 머지 큐가 할
//                                  update-branch 를 미리 하는 것이라 기준이 다르면 안 된다. require_up_to_date 가 false 면 머지 큐가
//                                  최신화하지 않으므로 이 단계도 돌지 않는다
//
// 판정(verdict): PR 하나의 파일 목록으로 정한다. git 조회는 부르는 쪽(forkFiles)이 한다.
//   최신(base 를 품는다)이면 skip. up_to_date_when 이 overlap 이면 lib/overlap.ts 의 judge 가 갱신 필요일 때만, always 면 뒤처지면 늘 최신화한다.
//   최신화할 PR 가운데 refresh_worker_paths 에 맞는 파일을 양쪽이 모두 바꿨으면 worker 다.
//
// 큐 뒤로 미루기(aheadInQueue): 도는 머지 큐에 아직 머지되지 않은 앞 PR 이 있고 그 PR 의 변경이 이 PR 과 겹치면 미룬다.
//   그 PR 이 머지되면 이 PR 은 다시 뒤처져 방금 돌린 CI 가 쓸모없어지기 때문이다. 큐에 든 PR 의 「앞」 은 큐 순서에서 앞선 PR 이고,
//   큐에 없는 PR 의 「앞」 은 큐의 남은 PR 전부다. always 면 겹침을 따지지 않고 앞 PR 이 하나라도 있으면 미룬다.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, PIPELINE_KEYS, QUEUE_KEYS, section } from './config.ts'
import type { Config } from './config.ts'
import { git } from './git.ts'
import { judge } from './overlap.ts'
import type { JudgeOptions } from './overlap.ts'
import { makeParent, pathOf } from './paths.ts'
import { pyRegExp } from './py.ts'

export type RefreshSettings = {
  slots: number
  workerPaths: RegExp | null
  upToDate: boolean
  when: 'always' | 'overlap'
  judge: JudgeOptions & { sharedPaths: string; unitPrefix: string; docsGlobs: string[]; groups: string[][] }
}

function joined(value: unknown, key: string, glue: string): string {
  if (value === undefined) return ''
  if (typeof value === 'string' && value) return value
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v)) return (value as string[]).join(glue)
  throw new ConfigError(`설정 파일의 ${key} 는 비지 않은 문자열이나 그 목록이어야 한다`)
}

export function refreshSettings(config: Config): RefreshSettings {
  const pipeline = section<Record<string, unknown>>(config, 'pipeline', PIPELINE_KEYS)
  const slots = pipeline.refresh_slots ?? 0
  if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 0) throw new ConfigError('설정 파일의 pipeline.refresh_slots 는 0 이상의 정수여야 한다')
  const off: RefreshSettings = {
    slots: 0,
    workerPaths: null,
    upToDate: false,
    when: 'always',
    judge: { sharedPaths: '', unitPrefix: 'modules/', docsGlobs: [], groups: [] },
  }
  // 끈 저장소에서는 나머지 키를 읽지 않는다. 다른 명령이 검사하는 키의 오류로 루프가 멈추지 않게 한다
  if (slots === 0) return off
  const queue = section<Record<string, unknown>>(config, 'queue', QUEUE_KEYS)
  const workerSource = joined(pipeline.refresh_worker_paths, 'pipeline.refresh_worker_paths', '|')
  let workerPaths: RegExp | null = null
  if (workerSource) {
    try {
      workerPaths = pyRegExp(workerSource)
    } catch (e) {
      throw new ConfigError(`설정 파일의 pipeline.refresh_worker_paths 를 정규식으로 읽지 못했다: ${(e as Error).message}`)
    }
  }
  const upToDate = queue.require_up_to_date ?? false
  if (typeof upToDate !== 'boolean') throw new ConfigError('설정 파일의 queue.require_up_to_date 는 true 나 false 여야 한다')
  const when = queue.up_to_date_when ?? 'always'
  if (when !== 'always' && when !== 'overlap') throw new ConfigError('설정 파일의 queue.up_to_date_when 은 always, overlap 중 하나다')
  const sharedPaths = joined(queue.shared_paths, 'queue.shared_paths', '|')
  if (sharedPaths) {
    try {
      pyRegExp(sharedPaths)
    } catch (e) {
      throw new ConfigError(`설정 파일의 queue.shared_paths 를 정규식으로 읽지 못했다: ${(e as Error).message}`)
    }
  }
  const unitPrefix = queue.unit_prefix ?? 'modules/'
  if (typeof unitPrefix !== 'string' || !unitPrefix) throw new ConfigError('설정 파일의 queue.unit_prefix 는 비지 않은 문자열이어야 한다')
  const docs = joined(queue.docs_glob, 'queue.docs_glob', ',')
  const groups = queue.unit_groups ?? []
  const groupsOk = Array.isArray(groups) && groups.every((g) => Array.isArray(g) && g.length >= 2 && g.every((m) => typeof m === 'string' && m && !m.includes(',')))
  if (!groupsOk) throw new ConfigError('설정 파일의 queue.unit_groups 는 단위 이름이 둘 이상인 문자열 목록의 목록이어야 한다')
  return {
    slots,
    workerPaths,
    upToDate,
    when,
    judge: { sharedPaths, unitPrefix, docsGlobs: docs.split(',').filter((g) => g), groups: groups as string[][] },
  }
}

// PR 이 갈라진 뒤 양쪽에서 바뀐 파일. 이름 바꾸기는 옛 경로와 새 경로를 따로 센다(overlap_units.ts 와 같다).
// behind 는 head 가 base 를 품지 않는다는 뜻이다. 두 커밋은 로컬에 있어야 한다
export type ForkFiles = { behind: boolean; pr: string[]; base: string[] }

export function forkFiles(repo: string, base: string, head: string): { ok: true; files: ForkFiles } | { ok: false; error: string } {
  const lines = (args: string[]): string[] | null => {
    const done = git(repo, args)
    return done.code === 0 ? done.stdout.split('\n').filter((line) => line) : null
  }
  const ancestor = git(repo, ['merge-base', '--is-ancestor', base, head])
  if (ancestor.code !== 0 && ancestor.code !== 1) return { ok: false, error: `git merge-base --is-ancestor ${base} ${head}: ${ancestor.stderr.trim() || `종료 코드 ${ancestor.code}`}` }
  const mb = lines(['merge-base', base, head])?.[0]
  if (!mb) return { ok: false, error: `git merge-base ${base} ${head} 가 커밋을 내지 않았다` }
  const pr = lines(['diff', '--name-only', '--no-renames', mb, head])
  const theirs = lines(['diff', '--name-only', '--no-renames', mb, base])
  if (pr === null || theirs === null) return { ok: false, error: `git diff ${mb.slice(0, 8)} 를 읽지 못했다` }
  return { ok: true, files: { behind: ancestor.code === 1, pr, base: theirs } }
}

export type Verdict = { action: 'skip'; reason: string } | { action: 'update'; reason: string } | { action: 'worker'; reason: string; files: string[] }

export function verdict(files: ForkFiles, settings: RefreshSettings): Verdict {
  if (!files.behind) return { action: 'skip', reason: '최신' }
  let reason = 'base 에 뒤처졌다'
  if (settings.when === 'overlap') {
    const judged = judge(files.pr, files.base, settings.judge)
    if (!judged.update) return { action: 'skip', reason: '겹치지 않아 머지 큐가 바로 머지한다' }
    reason = judged.reason
  }
  const paths = settings.workerPaths
  if (paths) {
    const theirs = new Set(files.base)
    const both = [...new Set(files.pr)].filter((file) => theirs.has(file) && paths.test(file)).sort()
    if (both.length > 0) return { action: 'worker', reason: `양쪽이 바꾼 worker 판단 파일: ${both.join(', ')}`, files: both }
  }
  return { action: 'update', reason }
}

// 도는 큐에서 이 PR 보다 앞에 있고 겹치는 PR 의 번호. 없으면 null. queue 는 차례 기록의 남은 PR 이고, changed 는 그 PR 이 바꾼 파일이다
export function aheadInQueue(
  number: number,
  files: ForkFiles,
  queue: readonly number[],
  changed: (pr: number) => string[] | null,
  settings: RefreshSettings,
): number | null {
  const at = queue.indexOf(number)
  const ahead = at >= 0 ? queue.slice(0, at) : queue
  for (const other of ahead) {
    if (settings.when === 'always') return other
    const theirs = changed(other)
    // 읽지 못한 PR 은 겹친 것으로 본다. 미루는 쪽이 잃는 것은 한 틱이지만, 거는 쪽은 runner 를 쓴다
    if (theirs === null || judge(files.pr, theirs, settings.judge).update) return other
  }
  return null
}

// 기록: <orch 루트>/state/refresh.json 의 { "<PR>": RefreshRecord }. PR 마다 마지막으로 건 것 하나다.
//   base 는 그때의 base SHA, from 은 그때의 PR HEAD, value 는 결과(update 는 updated 나 failed, worker 는 dispatch id 나 orphan)다.
//   같은 (PR, base SHA) 에는 다시 걸지 않는다. 파일이 없거나 깨졌으면 빈 기록이다. 쓰기는 옆 파일에 쓰고 rename 한다
export type RefreshRecord = { base: string; from: string; at: string; action: 'update' | 'worker'; value: string }

export function refreshFile(repo: string): string {
  return join(pathOf('state', repo), 'refresh.json')
}

function isRecord(value: unknown): value is RefreshRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.base === 'string' && typeof row.from === 'string' && typeof row.at === 'string' &&
    (row.action === 'update' || row.action === 'worker') && typeof row.value === 'string'
  )
}

export function readRefresh(file: string): Record<string, RefreshRecord> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => /^\d+$/.test(key) && isRecord(value))) as Record<string, RefreshRecord>
}

export function writeRefresh(file: string, repo: string, records: Record<string, RefreshRecord>): void {
  makeParent(file, repo)
  const sorted = Object.fromEntries(Object.keys(records).sort((a, b) => Number(a) - Number(b)).map((key) => [key, records[key]]))
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

// 루프가 건 최신화 가운데 CI 가 아직 도는 것으로 셀 기록인지. head 는 그 PR 의 지금 HEAD, ci 는 이번 틱의 CI 상태다.
// update 를 건 뒤 HEAD 가 아직 그대로면 GitHub 가 합치는 중이다(10분까지). HEAD 가 바뀐 뒤에는 CI 가 pending 인 동안이다.
// 3시간 넘은 기록은 세지 않는다. CI 가 붙지 않은 채 남은 기록이 자리를 계속 쥐지 않게 한다
export const LANDING_MS = 10 * 60_000
export const IN_FLIGHT_MS = 3 * 60 * 60_000

export function inFlight(record: RefreshRecord, head: string, ci: 'passed' | 'failed' | 'pending' | null, nowMs: number): boolean {
  if (record.value === 'failed' || record.value === 'orphan') return false
  const age = nowMs - Date.parse(record.at)
  if (!Number.isFinite(age) || age > IN_FLIGHT_MS) return false
  if (head === record.from) return record.action === 'update' && age <= LANDING_MS
  return ci === 'pending' || ci === null
}
