// 여러 저장소의 피드백 조회와 알림 조건. collect는 읽기 전용, notify만 원래 파일을 고친다.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { acceptedPr, duplicateOf, isCore, parse, scan, type Candidate } from './feedback.ts'
import { ensure, pathOf } from './paths.ts'
import { orcaJson } from './orca.ts'
import { findMain } from './main-coordinator.ts'
import { notifyRun } from './run-notice.ts'
import { moveToTrash } from './spec.ts'

export type FeedbackRepo = { name: string; path: string }
export type FeedbackRow = { repo: FeedbackRepo; candidate: Candidate; group: string; detail?: string; pr?: number; version?: string; resultStatus?: string }
export type FeedbackCollected = { rows: FeedbackRow[]; errors: string[]; core: FeedbackRepo }
const BOARD_CACHE = 'feedback-board-cache.json'
const BOARD_CACHE_MS = 30 * 60 * 1000
function cacheFile(core: FeedbackRepo): string { return join(pathOf('state', core.path), BOARD_CACHE) }
function canonical(path: string): string { try { return realpathSync(path) } catch { return path } }

// collect/notify의 마지막 분류만 기록한다. 후보 파일과 메시지는 건드리지 않는다.
function saveBoardCache(collected: FeedbackCollected): void {
  const file = cacheFile(collected.core)
  const entries = collected.rows.filter(row => row.group === '보낼 알림')
    .map(row => ({ repo: canonical(row.repo.path), slug: row.candidate.slug, status: row.candidate.values.상태 }))
  try {
    ensure('state', collected.core.path)
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify({ at: Date.now(), entries }))
    renameSync(temp, file)
  } catch { /* 캐시 오류는 collect의 후보 조회를 막지 않는다 */ }
}

// 보드에서는 파일만 읽는다. PR 결과가 필요한 알림은 최근 collect 결과에 있을 때만 센다.
export function localFeedbackCount(repoPath: string, repos: FeedbackRepo[] = feedbackRepos(), time = Date.now()): number {
  const core = repos.find(row => row.name === 'fos-skills')
  if (!core) throw new Error('Orca 저장소 목록에 fos-skills가 없다')
  const current = canonical(repoPath)
  const coreBoard = current === canonical(core.path)
  let entries: Array<{ repo: string; slug: string; status: string }> = []
  try {
    const cache = JSON.parse(readFileSync(cacheFile(core), 'utf8'))
    if (typeof cache.at === 'number' && time - cache.at >= 0 && time - cache.at <= BOARD_CACHE_MS && Array.isArray(cache.entries)) entries = cache.entries
  } catch { /* 저장본이 없으면 PR 판정이 필요한 알림을 세지 않는다 */ }
  const sendable = new Set(entries.map(row => `${row.repo}\t${row.slug}\t${row.status}`))
  let count = 0
  for (const repo of coreBoard ? repos : repos.filter(row => canonical(row.path) === current)) {
    const dir = pathOf('feedback', repo.path)
    if (!existsSync(dir)) continue
    for (const candidate of scan(dir).candidates) {
      const status = candidate.values.상태
      if (existsSync(sentMarker(candidate.file))) continue
      if (status === '후보' && (coreBoard ? isCore(candidate) || canonical(repo.path) === current : !isCore(candidate))) count++
      else if ((status.startsWith('반영됨 ') || status.startsWith('기각(')) && canonical(repo.path) === current) count++
      else if (coreBoard && isCore(candidate) && sendable.has(`${canonical(repo.path)}\t${candidate.slug}\t${status}`)) count++
    }
  }
  return count
}
type Pr = { state: string; mergeCommit?: { oid?: string } }
export function sentMarker(file: string): string { return `${file}.sent` }

export function feedbackRepos(): FeedbackRepo[] {
  const got = orcaJson<{ repos?: Array<{ path?: unknown; displayName?: unknown }> }>(['repo', 'list'])
  if (!got.ok) throw new Error(got.error)
  if (!Array.isArray(got.data.repos)) throw new Error('orca repo list 의 repos 가 배열이 아니다')
  return got.data.repos.filter(row => typeof row.path === 'string' && typeof row.displayName === 'string')
    .map(row => ({ path: row.path as string, name: row.displayName as string }))
}

function command(bin: string, args: string[], cwd: string): string {
  return execFileSync(bin, args, { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function prResult(repo: string, number: number): { state: 'merged' | 'closed' | 'open' | 'unknown'; sha?: string; error?: string } {
  try {
    const pr = JSON.parse(command(process.env.ORCH_FEEDBACK_GH || 'gh', ['pr', 'view', String(number), '--json', 'state,mergeCommit'], repo)) as Pr
    if (pr.state === 'MERGED' && pr.mergeCommit?.oid) return { state: 'merged', sha: pr.mergeCommit.oid }
    if (pr.state === 'CLOSED') return { state: 'closed' }
    if (pr.state === 'OPEN') return { state: 'open' }
    return { state: 'unknown', error: 'PR 결과 또는 merge commit을 읽지 못했다' }
  } catch (error) { return { state: 'unknown', error: (error as Error).message.split('\n')[0] } }
}

export function versionResult(repo: string, mergeSha: string): { version?: string; error?: string } {
  try {
    try { command('git', ['merge-base', '--is-ancestor', mergeSha, 'origin/main'], repo) }
    catch (error) { return { error: `반영 PR을 origin/main에서 확인하지 못했다: ${(error as Error).message.split('\n')[0]}` } }
    // main의 첫 부모 경로만 보면 PR 전에 갈라진 브랜치의 version commit을 잘못 고르지 않는다.
    const commits = command('git', ['log', '--first-parent', '--reverse', '--format=%H', `${mergeSha}..origin/main`, '--', '.claude-plugin/plugin.json'], repo).split('\n').filter(Boolean)
    for (const sha of commits) {
      const current = JSON.parse(command('git', ['show', `${sha}:.claude-plugin/plugin.json`], repo)) as { version?: string }
      let previous: { version?: string } = {}
      const parents = command('git', ['rev-list', '--parents', '-n', '1', sha], repo).split(' ')
      if (parents[1]) previous = JSON.parse(command('git', ['show', `${parents[1]}:.claude-plugin/plugin.json`], repo)) as { version?: string }
      if (!current.version) throw new Error(`${sha}의 플러그인 버전이 없다`)
      if (current.version !== previous.version) return { version: current.version }
    }
  } catch (error) { return { error: (error as Error).message.split('\n')[0] } }
  return {}
}

export function releasedVersion(repo: string, mergeSha: string): string | null {
  return versionResult(repo, mergeSha).version ?? null
}

export function collectFeedback(repos = feedbackRepos(), trash = join(homedir(), '.Trash', 'orch-feedback')): FeedbackCollected {
  const core = repos.find(row => row.name === 'fos-skills')
  if (!core) throw new Error('Orca 저장소 목록에 fos-skills가 없다')
  const rows: FeedbackRow[] = [], errors: string[] = []
  const all: Array<{ repo: FeedbackRepo; candidate: Candidate }> = []
  for (const repo of repos) {
    const dir = pathOf('feedback', repo.path)
    if (!existsSync(dir)) continue
    try {
      readdirSync(dir)
      // scan은 깨진 개별 파일을 legacy로 보고한다. 폴더 자체 권한 오류는 명시한다.
      const found = scan(dir)
      for (const candidate of found.candidates) all.push({ repo, candidate })
      for (const file of found.legacy) errors.push(`${repo.name}\t읽지 못한 후보 형식: ${basename(file)}`)
    } catch (error) { errors.push(`${repo.name}\t${(error as Error).message}`) }
  }
  const bySlug = new Map(all.map(item => [`${item.repo.name}/${item.candidate.slug}`, item]))
  const fromTrash = (key: string): { repo: FeedbackRepo; candidate: Candidate } | null => {
    const slash = key.lastIndexOf('/')
    if (slash < 0) return null
    const repo = repos.find(row => row.name === key.slice(0, slash))
    if (!repo) return null
    const slug = key.slice(slash + 1)
    const dir = join(trash, basename(repo.path))
    try {
      const names = readdirSync(dir).filter(name => name === `${slug}.md` || new RegExp(`^${slug}\\.md\\.[2-9]\\d*$`).test(name))
        .sort((a, b) => Number(a.split('.md.')[1] || 1) - Number(b.split('.md.')[1] || 1))
      for (const name of names.reverse()) {
        const file = join(dir, name)
        const candidate = parse(readFileSync(file, 'utf8'), file, slug)
        if (candidate && isCore(candidate) && (candidate.values.상태.startsWith('반영됨 ') || candidate.values.상태.startsWith('기각('))) return { repo, candidate }
      }
    } catch { /* 휴지통에 대표 기록이 없으면 계속 기다린다 */ }
    return null
  }
  const prCache = new Map<string, ReturnType<typeof prResult>>()
  const versionCache = new Map<string, ReturnType<typeof versionResult>>()
  const pr = (repo: FeedbackRepo, number: number) => {
    const key = `${repo.path}#${number}`
    if (!prCache.has(key)) prCache.set(key, prResult(repo.path, number))
    return prCache.get(key)!
  }
  for (const item of all) {
    const { repo, candidate } = item
    const status = candidate.values.상태
    const base = { repo, candidate }
    if (!isCore(candidate)) {
      rows.push({ ...base, group: status.startsWith('반영됨 ') || status.startsWith('기각(') ? '받은 알림' : '저장소 몫' })
      continue
    }
    if (status.startsWith('반영됨 ') || (status.startsWith('기각(') && !duplicateOf(candidate))) {
      rows.push({ ...base, group: '받은 알림' }); continue
    }
    const duplicate = duplicateOf(candidate)
    const key = duplicate ? (duplicate.includes('/') ? duplicate : `${repo.name}/${duplicate}`) : ''
    const representative = duplicate ? (bySlug.get(key) ?? fromTrash(key)) : null
    const source = representative ?? item
    if (duplicate && !representative) {
      rows.push({ ...base, group: '보낼 알림', resultStatus: `기각(대표 없음: ${duplicate})` })
      continue
    }
    if (duplicate && representative?.candidate.values.상태.startsWith('기각(')) {
      rows.push({ ...base, group: '보낼 알림', resultStatus: `기각(대표 ${duplicate}: ${representative.candidate.values.상태})` })
      continue
    }
    const reflected = duplicate ? /^반영됨 #([1-9]\d*) \(([^()]+)\)$/.exec(source.candidate.values.상태) : null
    if (reflected && isCore(source.candidate)) {
      rows.push({ ...base, group: '보낼 알림', pr: Number(reflected[1]), version: reflected[2] })
      continue
    }
    const number = acceptedPr(source.candidate)
    if (number) {
      const prRepo = isCore(source.candidate) ? core : source.repo
      const result = pr(prRepo, number)
      if (result.state === 'closed') rows.push({ ...base, group: '닫힌 PR', pr: number })
      else if (result.state === 'unknown') rows.push({ ...base, group: '조회 실패', pr: number, detail: result.error })
      else if (result.state === 'open') rows.push({ ...base, group: 'PR 머지 대기', pr: number })
      else {
        const version = versionCache.get(result.sha!) ?? versionResult(core.path, result.sha!)
        versionCache.set(result.sha!, version)
        rows.push({ ...base, group: version.error ? '조회 실패' : version.version ? '보낼 알림' : '버전 대기', pr: number, ...(version.version ? { version: version.version } : {}), ...(version.error ? { detail: version.error } : {}) })
      }
    } else if (duplicate) rows.push({ ...base, group: '버전 대기', detail: `대표 후보 ${duplicate}의 반영 대기` })
    else if (status === '후보') rows.push({ ...base, group: isCore(candidate) ? '판정할 core 후보' : '저장소 몫' })
    else if (status.startsWith('보류(')) rows.push({ ...base, group: isCore(candidate) ? '보류' : '저장소 몫' })
  }
  const collected = { rows, errors, core }
  saveBoardCache(collected)
  return collected
}

export function saveStatus(candidate: Candidate, status: string): void {
  const text = candidate.text.replace(/^- 상태: .+$/m, `- 상태: ${status}`)
  if (!parse(text, candidate.file, candidate.slug)) throw new Error(`상태 형식이 잘못됐다: ${candidate.file}`)
  const temp = `${candidate.file}.tmp-${process.pid}`
  writeFileSync(temp, text, { flag: 'wx' })
  renameSync(temp, candidate.file)
}

export function notifyFeedback(collected: FeedbackCollected, trash: string, deps: { findMain: typeof findMain; notifyRun: typeof notifyRun } = { findMain, notifyRun }): string[] {
  const lines: string[] = []
  const notices = new Map<string, FeedbackRow[]>()
  for (const row of collected.rows.filter(row => row.group === '보낼 알림' || row.group === '받은 알림')) {
    if (row.group === '받은 알림') continue
    const status = row.resultStatus ?? (row.version ? `반영됨 #${row.pr} (${row.version})` : `반영됨 #${row.pr} (저장소 PR)`)
    try { saveStatus(row.candidate, status) }
    catch (error) { lines.push(`UPDATE-FAIL ${row.repo.name}\t${row.candidate.slug}\t${(error as Error).message}`); continue }
    lines.push(`UPDATED ${row.repo.name}\t${row.candidate.slug}\t${status}`)
    const group = notices.get(row.repo.path) ?? []
    group.push(row)
    notices.set(row.repo.path, group)
  }
  for (const row of collected.rows.filter(row => row.group === '받은 알림' && isCore(row.candidate))) {
    if (existsSync(sentMarker(row.candidate.file))) continue
    const reflected = /^반영됨 #([1-9]\d*) \(([^()]+)\)$/.exec(row.candidate.values.상태)
    if (reflected) { row.pr = Number(reflected[1]); row.version = reflected[2] === '저장소 PR' ? undefined : reflected[2] }
    const group = notices.get(row.repo.path) ?? []
    group.push(row)
    notices.set(row.repo.path, group)
  }
  for (const [repoPath, group] of notices) {
    const main = deps.findMain(repoPath)
    if (main.kind !== 'main') { lines.push(`MESSAGE-SKIP ${group[0].repo.name} ${main.kind}`); continue }
    const body = group.map(row => (row.resultStatus ?? row.candidate.values.상태).startsWith('기각(') && (row.resultStatus || !duplicateOf(row.candidate))
      ? `${row.candidate.title}: ${row.resultStatus ?? row.candidate.values.상태}`
      : `${row.candidate.title}: PR #${row.pr}, 버전 ${row.version ?? '저장소 PR'}`).join('\n')
      + (group.some(row => row.version) ? '\n플러그인 갱신 필요' : '')
    const marked: string[] = []
    try {
      for (const row of group) {
        const marker = sentMarker(row.candidate.file)
        writeFileSync(marker, '전송 표시\n', { flag: 'wx' })
        marked.push(marker)
      }
    } catch (error) {
      for (const marker of marked) unlinkSync(marker)
      lines.push(`MESSAGE-MARK-FAIL ${group[0].repo.name} ${(error as Error).message}`)
      continue
    }
    const sent = deps.notifyRun(main.run, 'FEEDBACK', body, null, { subject: `스킬 개선 결과: ${group[0].repo.name}`, repo: repoPath, source: 'orch-feedback' })
    if (!sent.ok) {
      for (const marker of marked) unlinkSync(marker)
      lines.push(`MESSAGE-FAIL ${group[0].repo.name} ${sent.error}`); continue
    }
    lines.push(`MESSAGE-SENT ${group[0].repo.name} ${group.length}`)
    for (const row of group) {
      try {
        lines.push(`TRASHED ${row.repo.name}\t${row.candidate.slug}\t${moveToTrash(row.candidate.file, join(trash, basename(row.repo.path)))}`)
        unlinkSync(sentMarker(row.candidate.file))
      }
      catch (error) { lines.push(`TRASH-FAIL ${row.repo.name}\t${row.candidate.slug}\t${(error as Error).message}`) }
    }
  }
  return lines
}
