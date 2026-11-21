// 기능 PR 의 완료 근거 형식. 의미와 실행 사실은 코디네이터가 확인한다.
// PR 본문을 읽고, 현재 HEAD 의 기록과 필수 검토 누락을 막는다. 후속 검증을 끝냈는지는 배포 뒤 할 일 목록(lib/followups.ts)도 본다.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ghJson } from './gh.ts'
import { loadConfig } from './config.ts'
import { contractSettings } from '../core/contracts.ts'
import { git } from './git.ts'
import { pathOf } from './paths.ts'
import { followupDone } from './followups.ts'
import { branchesOf, specsOnBranch, taskFirstLine } from './spec.ts'
import { readLaunch } from './launched.ts'
import { worktreePaths } from './workers.ts'

export const EVIDENCE_START = '<!-- fos-feature-evidence -->'
const END = '<!-- /fos-feature-evidence -->'

export function featureLoopRequested(text: string): boolean {
  return /^루프를 쓴다\s*\(스펙\s*:/.test(taskFirstLine(text)?.text ?? '')
}

function withoutExamples(text: string): string {
  let fence = ''
  return text.split('\n').filter((line) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (mark) {
      if (!fence) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''
      return false
    }
    return !fence
  }).join('\n')
}

function implementationRequested(text: string): boolean {
  const plain = withoutExamples(text)
  const planningOnly = /이 지시서는\s*계획까지만 맡는다/.test(plain) ||
    /구현과\s+PR\s*은\s+코디네이터가\s+(?:계획을\s+보고\s+)?새\s+지시서로/.test(plain)
  return featureLoopRequested(text) && !planningOnly
}

// 브랜치에 연결된 dispatch 지시서를 우선한다. 구현 뒤 후속·충돌 해소 지시서가 붙어도
// 구현을 맡은 기록이 하나라도 있으면 기능 PR 로 본다. 옛 기록에 branch 가 없으면 worktree 로 연결한다.
export function featureBranch(repo: string, branch: string, explicit?: string): boolean {
  const config = loadConfig(repo)
  const configured = config.finish?.specs_dir
  if (configured !== undefined && typeof configured !== 'string') throw new Error('finish.specs_dir 는 경로 문자열이어야 한다')
  const records = join(pathOf('state', repo), 'launched-workers')
  if (existsSync(records)) {
    const worktree = worktreePaths(repo).get(branch)
    const launches = readdirSync(records).filter((name) => name.endsWith('.json')).flatMap((name) => {
      const launch = readLaunch(repo, name.slice(0, -5))
      if (!launch || !(launch.branch === branch || (!launch.branch && launch.worktree === worktree))) return []
      return [launch]
    })
    const texts = launches.flatMap(({ spec }) => {
      if (!spec || !existsSync(spec)) return []
      const text = readFileSync(spec, 'utf8')
      return branchesOf(text).includes(branch) ? [text] : []
    })
    if (texts.length > 0) return texts.some(implementationRequested)
  }
  // 읽을 수 있는 연결 지시서가 없으면 기존처럼 기본/설정 폴더의 브랜치 지시서를 모두 본다.
  const dirs = [pathOf('specs', repo), explicit, configured].filter((v): v is string => Boolean(v))
  return dirs.some((dir) => {
    const full = isAbsolute(dir) ? dir : join(repo, dir)
    if (!existsSync(full)) return false
    return specsOnBranch(full, branch).some((file) => implementationRequested(readFileSync(file, 'utf8')))
  })
}

// 검증 커밋 뒤 HEAD 까지 base 를 합친 merge 커밋만 있는지. 머지 큐 차례와 상주 루프의 최신화가 부르는 update-branch 는
// 검증 커밋 위에 base 를 합친 merge 커밋을 더해 HEAD 를 바꾼다. 그 merge 가 base 쪽 변경만 들여왔으면 검증한 코드는 그대로다.
// HEAD 부터 첫 부모를 따라 BASE_MERGE_LIMIT 개까지 보고, 지나는 커밋이 모두 아래를 채우고 검증 커밋에 닿으면 true 다.
//   부모가 둘이다. 둘째 부모가 origin/<base> 에 든다(base 쪽이다).
//   커밋의 tree 가 두 부모를 `git merge-tree --write-tree` 로 합친 tree 와 같다. 충돌을 풀거나 merge 커밋에 손댄 변경은 다르다.
//   resolved(config.json 의 contracts.paths)를 주면, 합친 tree 가 충돌했고 충돌 파일과 커밋 tree 와 다른 파일이 모두 resolved 에 맞는
//   merge 도 받아들인다. 계약 머리 자동 합치기(lib/contract-merge.ts)나 worker 가 계약 파일 충돌만 푼 merge 다
// 커밋이 로컬에 없거나 git 이 실패하면 false 다. 부르는 쪽은 origin/<base> 와 PR HEAD 를 받아 둔다.
// 이 경우 머지 조건은 지금 HEAD 의 CI 통과로 대신한다. 머지 큐와 자동 머지는 지금 HEAD 의 필수 체크 통과를 따로 본다.
export const BASE_MERGE_LIMIT = 50

// 검증 뒤 이 PR 계획 폴더만 삭제한 커밋을 받아들인다. 각 커밋은 삭제만 해야 하고,
// 검증 시점 index.json 이 가리키는 tracked 파일 전체가 같은 폴더에서 제거되어야 한다.
export function planDeletionOnly(repo: string, head: string, verified: string, base: string, mergedAt?: string): boolean {
  const line = (args: string[]): string | null => {
    const done = git(repo, args)
    return done.code === 0 ? done.stdout.trim() : null
  }
  const status = (from: string, to: string): string[] | null => {
    const done = git(repo, ['-c', 'core.quotepath=false', 'diff', '--no-renames', '--name-status', from, to])
    if (done.code !== 0) return null
    return done.stdout.split('\n').filter(Boolean)
  }
  const baseRef = `refs/remotes/origin/${base}`
  // 일반 머지 뒤에는 base 가 검증 커밋도 포함하므로 PR 을 머지하기 직전의 base 와 비교한다.
  const beforeMerge = mergedAt && line(['rev-parse', `${mergedAt}^2`]) === head ? `${mergedAt}^1` : baseRef
  const basePoint = line(['merge-base', beforeMerge, verified])
  if (!basePoint) return false
  const before = git(repo, ['-c', 'core.quotepath=false', 'diff', '--no-renames', '--name-status', basePoint, verified])
  if (before.code !== 0) return false
  const indexes = before.stdout.split('\n').filter((row) => row.startsWith('A\t') && row.endsWith('/index.json')).map((row) => row.slice(2))
  const plans = indexes.filter((file) => {
    const dir = file.slice(0, -'/index.json'.length)
    const raw = line(['show', `${verified}:${file}`])
    if (!raw) return false
    try {
      const data = JSON.parse(raw) as { name?: unknown; phases?: unknown }
      return data.name === dir.slice(dir.lastIndexOf('/') + 1) && Array.isArray(data.phases) && data.phases.length > 0 &&
        data.phases.every((phase) => phase && typeof phase === 'object' && typeof (phase as { file?: unknown }).file === 'string')
    } catch { return false }
  })
  if (plans.length !== 1) return false
  const expectedFolder = plans[0].slice(0, -'/index.json'.length)
  let commit = head
  const removed = new Set<string>()
  let folder = ''
  for (let i = 0; i < BASE_MERGE_LIMIT; i++) {
    if (commit === verified) break
    const parents = line(['rev-list', '--parents', '-n', '1', commit])?.split(/\s+/) ?? []
    if (parents.length !== 2) return false
    const [, parent] = parents
    const changes = status(parent, commit)
    if (!changes?.length) return false
    for (const change of changes) {
      const [kind, file] = change.split('\t')
      if (kind !== 'D' || !file || !file.includes('/')) return false
      const dir = file.slice(0, file.lastIndexOf('/'))
      if (dir !== expectedFolder) return false
      if (folder && folder !== dir) return false
      folder = dir
      removed.add(file)
    }
    commit = parent
  }
  if (commit !== verified || !folder || !removed.has(`${folder}/index.json`)) return false
  if (folder !== expectedFolder) return false
  const index = line(['show', `${verified}:${folder}/index.json`])
  if (!index) return false
  const record = JSON.parse(index) as { phases: { file: string }[] }
  const tracked = line(['ls-tree', '-r', '--name-only', verified, '--', folder])?.split('\n').filter(Boolean) ?? []
  if (!tracked.length || tracked.some((file) => !removed.has(file)) || [...removed].some((file) => !tracked.includes(file))) return false
  return record.phases.every((phase) => tracked.includes(`${folder}/${(phase as { file: string }).file}`))
}

// 충돌한 합친 tree 와 커밋 tree 사이에서 바뀐 파일과 충돌 파일이 모두 resolved 에 맞는지
function resolvedOnly(repo: string, merged: string, tree: string, conflicted: string[], resolved: RegExp): boolean {
  if (conflicted.length === 0 || !conflicted.every((file) => resolved.test(file))) return false
  const diff = git(repo, ['diff', '--name-only', '--no-renames', merged, tree])
  if (diff.code !== 0) return false
  return diff.stdout.split('\n').filter((x) => x).every((file) => resolved.test(file))
}

export function baseMergesOnly(repo: string, head: string, verified: string, base: string, resolved: RegExp | null = null): boolean {
  const line = (args: string[]): string | null => {
    const done = git(repo, args)
    return done.code === 0 ? done.stdout.trim() : null
  }
  let commit = head
  for (let i = 0; i < BASE_MERGE_LIMIT; i++) {
    if (commit === verified) return i > 0
    const parents = line(['rev-list', '--parents', '-n', '1', commit])?.split(/\s+/) ?? []
    if (parents.length !== 3) return false
    const [, first, second] = parents
    if (git(repo, ['merge-base', '--is-ancestor', second, `refs/remotes/origin/${base}`]).code !== 0) return false
    const tree = line(['rev-parse', `${commit}^{tree}`])
    const result = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', first, second])
    const [merged, ...conflicted] = result.stdout.split('\n').filter((x) => x)
    if (!tree || !merged || !/^[0-9a-f]{40,64}$/.test(merged)) return false
    if (tree !== merged && !(resolved && result.code === 1 && resolvedOnly(repo, merged, tree, conflicted, resolved))) return false
    commit = first
  }
  return false
}

// acceptVerified 는 검증 커밋이 현재 HEAD 와 다를 때 그 검증 커밋을 받아들일지 정한다(base 합치기 또는 계획 폴더 삭제).
export function featureEvidenceProblem(
  body: string,
  head: string,
  required = false,
  afterMerge = false,
  acceptVerified?: (verified: string) => boolean,
  acceptPlanDeletion?: (verified: string) => boolean,
): string | null {
  const plain = withoutExamples(body)
  if (!required && !plain.includes(EVIDENCE_START)) return null // 기존 PR 은 읽기 호환
  const parts = plain.split(EVIDENCE_START)
  if (parts.length !== 2 || parts[1].split(END).length !== 2) return '기능 완료 근거 블록이 하나 필요하다'
  const block = parts[1].split(END)[0]
  const fields = new Map<string, string>()
  for (const line of block.split('\n')) {
    const match = /^(검증 커밋|인수 검증|문서 대조|독립 리뷰|후속 검증):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    if (fields.has(match[1])) return `기능 완료 근거의 ${match[1]} 이 중복됐다`
    fields.set(match[1], match[2].trim())
  }
  const verified = fields.get('검증 커밋') ?? ''
  if (!/^[a-f0-9]{40}$/i.test(head)) return '기능 완료 근거의 검증 커밋이 현재 PR HEAD 와 다르다'
  if (verified !== head && !(/^[a-f0-9]{40}$/i.test(verified) && (acceptVerified?.(verified) || acceptPlanDeletion?.(verified)))) {
    return '기능 완료 근거의 검증 커밋이 현재 PR HEAD 와 다르다'
  }
  for (const key of ['인수 검증', '문서 대조', '독립 리뷰', '후속 검증']) {
    const value = fields.get(key) ?? ''
    const match = /^(통과|대기|없음)\s*\|\s*(.+)$/.exec(value)
    if (!match || /^(?:TBD|미정|없음|[-?]|<.*>)$/i.test(match[2].trim())) return `기능 완료 근거의 ${key} 에 판정과 실제 근거가 필요하다`
    const allowed = key === '후속 검증' ? (afterMerge ? ['통과', '없음'] : ['통과', '대기', '없음']) : ['통과']
    if (!allowed.includes(match[1])) return `${key} 이 완료되지 않았다: ${value}`
  }
  return null
}

// finish-pr 밖의 자동 정리와 보드 동기화도 같은 후속 검증 기준을 적용한다.
export function featureCompletionProblem(repo: string, number: string, branch = '', specsDir?: string, knownBody = ''): string | null {
  const required = featureBranch(repo, branch, specsDir) || knownBody.includes(EVIDENCE_START)
  const got = ghJson<{ body?: unknown; headRefOid?: unknown; headRefName?: unknown }>(
    ['pr', 'view', number, '--json', 'body,headRefOid,headRefName', '--jq', '.'], { cwd: repo, cache: false })
  if (!got.ok || !got.data || typeof got.data !== 'object') return '기능 완료 근거 조회 실패'
  const body = typeof got.data.body === 'string' ? got.data.body : ''
  const discovered = typeof got.data.headRefName === 'string' ? got.data.headRefName : branch
  if (!required && !body.includes(EVIDENCE_START) && !featureBranch(repo, discovered, specsDir)) return null
  const head = String(got.data.headRefOid ?? '')
  // base 는 검증 커밋이 HEAD 와 다를 때만 따로 읽는다
  const accept = (verified: string): boolean => {
    const got = ghJson<{ baseRefName?: unknown; mergeCommit?: { oid?: string } }>(['pr', 'view', number, '--json', 'baseRefName,mergeCommit'], { cwd: repo, cache: false })
    const base = got.ok && got.data && typeof got.data.baseRefName === 'string' ? got.data.baseRefName : ''
    return acceptsVerifiedCommit(repo, head, verified, base, { fetch: true, mergedAt: got.ok ? got.data?.mergeCommit?.oid : undefined })
  }
  // 코디네이터가 배포 뒤 할 일을 끝낸 PR(lib/followups.ts)은 본문의 「후속 검증: 대기」 를 끝난 것으로 본다
  return featureEvidenceProblem(body, head, true, !followupDone(repo, number), accept)
}

// 완료 근거 블록의 「후속 검증: 대기 | <글>」 의 글. 블록이 없거나 대기가 아니면 null 이다
export function pendingFollowup(body: string): string | null {
  const parts = withoutExamples(body).split(EVIDENCE_START)
  if (parts.length !== 2) return null
  for (const line of parts[1].split(END)[0].split('\n')) {
    const match = /^후속 검증:\s*대기\s*\|\s*(.+)$/.exec(line.trim())
    if (match) return match[1].trim()
  }
  return null
}

// 관문은 PR ref 를 먼저 받는다. 다른 경로는 필요할 때 여기서 받는다.
export function acceptsVerifiedCommit(
  repo: string,
  head: string,
  verified: string,
  base: string,
  options: { fetch?: boolean; mergedAt?: string } = {},
): boolean {
  if (!base) return false
  if (options.fetch) {
    git(repo, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`])
    if (git(repo, ['cat-file', '-e', `${head}^{commit}`]).code !== 0) git(repo, ['fetch', '-q', 'origin', head])
  }
  return baseMergesOnly(repo, head, verified, base, contractSettings(loadConfig(repo))?.paths ?? null) ||
    planDeletionOnly(repo, head, verified, base, options.mergedAt)
}
