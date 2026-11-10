import { ConfigError, PIPELINE_KEYS, QUEUE_KEYS, section } from './config.ts'
import type { Config } from './config.ts'
import { judge } from './overlap.ts'
import type { JudgeOptions } from './overlap.ts'
import { pyRegExp } from './regexp.ts'
export type RefreshSettings = {
  slots: number
  workerPaths: RegExp | null
  upToDate: boolean
  when: 'always' | 'overlap'
  judge: JudgeOptions & { sharedPaths: string; unitPrefix: string; docsGlobs: string[]; groups: string[][] }
}
export function joined(value: unknown, key: string, glue: string): string {
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
export function isRecord(value: unknown): value is RefreshRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.base === 'string' && typeof row.from === 'string' && typeof row.at === 'string' &&
    (row.action === 'update' || row.action === 'worker') && typeof row.value === 'string'
  )
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
