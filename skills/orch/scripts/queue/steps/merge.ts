// 머지 전 조건 확인, 머지와 원격 브랜치 정리.

import { ConfigError } from '../../lib/config.ts'
import { fire } from '../../lib/events.ts'
import { baseMergesOnly, featureBranch, featureEvidenceProblem } from '../../lib/feature-evidence.ts'
import { apiTarget, gh, ghJson, isOwnPr, ownAuthors } from '../../lib/gh.ts'
import { oneLine, short } from '../../lib/output.ts'
import { NO_LIMIT_MS, runAsync, runInherit, stopping } from '../../lib/proc.ts'
import { TURN_PHASES } from '../../lib/queue-turn.ts'
import { requiredChecks } from './checks.ts'
import type { GhPr, Pr, StepContext } from './model.ts'
import { Conflict, FAIL_SEL, HeadChanged, NotReady, PENDING, ROLL_NAMES, ROLL_NAMES_NO_SKIPPED, WorkerFix } from './model.ts'
import type { StepState } from './model.ts'
import { docsOnly, fetchPrRefs, overlapFiles, overlapsDeferred } from './overlap.ts'
import { eventContext, field, prEnv, prInput, turn } from './pr.ts'
import { chomp, failed, git, log, namesJson, nap, out, refuseWhenStopping, stop } from './runtime.ts'
import { bringUpToDate, remoteBase } from './update.ts'
import { verifyMerged } from './verify.ts'

export async function processPr(stepContext: StepContext, state: StepState, item: string): Promise<void> {
  const o = state.o
  const colon = item.indexOf(':')
  const n = colon >= 0 ? item.slice(0, colon) : item
  // `PR:명령` 은 이벤트가 아니라 before-merge 다음에 따로 돈다.
  // 콜론 뒤가 비면 일회성 명령은 돌리지 않는다. 콜론이 없으면 null 이다
  const prCommand = colon >= 0 ? item.slice(colon + 1) : null
  const p: Pr = (state.pr = {
    n,
    ph: '',
    branch: '',
    cross: false,
    apiHost: '',
    owner: '',
    repo: '',
    base: '',
    beforeHead: null,
    judgments: 0,
    judgedBase: null,
    ov: [],
    title: null,
    author: null,
    draft: false,
    url: '',
  })

  const st = await field(stepContext, state, n, 'state', '.state')
  if (st === 'MERGED') {
    log(`${n} 이미 MERGED`)
    state.sweepBase = state.sweepBase || (await field(stepContext, state, n, 'baseRefName', '.baseRefName'))
    return
  }
  if (st !== 'OPEN') stop(`${n} state=${st || '조회 실패'}`)

  // 검사 대상 HEAD 를 체크를 보기 전에 고정한다
  p.ph = await field(stepContext, state, n, 'headRefOid', '.headRefOid')
  p.branch = await field(stepContext, state, n, 'headRefName', '.headRefName')
  const cross = await field(stepContext, state, n, 'isCrossRepository', '.isCrossRepository')
  if (!p.ph) stop(`${n} headRefOid 조회 실패`)
  if (!p.branch) stop(`${n} headRefName 조회 실패`)
  if (cross !== 'true' && cross !== 'false') stop(`${n} isCrossRepository 조회 실패`)
  p.cross = cross === 'true'

  // https://<호스트>/<owner>/<repo>/pull/<번호>. `://` 가 없으면 호스트가 비어 조회 실패다
  const url = await field(stepContext, state, n, 'url', '.url')
  const scheme = url.indexOf('://')
  const [host, owner, repo] = (scheme >= 0 ? url.slice(scheme + 3) : '').split('/')
  p.apiHost = host ?? ''
  p.owner = owner ?? ''
  p.repo = repo ?? ''
  if (!(p.owner && p.repo && p.apiHost)) stop(`${n} url 조회 실패`)
  p.url = url
  // 이벤트 입력의 pr 을 채운다. 조회하지 못했으면 핸들러에 틀린 값을 넘기지 않도록 멈춘다
  const info = await field(stepContext, state, n, 'title,author,isDraft', '{title, author: .author.login, isDraft} | tojson')
  try {
    const parsed = JSON.parse(info) as { title: unknown; author: unknown; isDraft: unknown }
    p.title = typeof parsed.title === 'string' ? parsed.title : null
    p.author = typeof parsed.author === 'string' ? parsed.author : null
    p.draft = parsed.isDraft === true
  } catch {
    stop(`${n} title, author, isDraft 조회 실패`)
  }
  p.base = await field(stepContext, state, n, 'baseRefName', '.baseRefName')
  if (!p.base) stop(`${n} baseRefName 조회 실패`)
  state.sweepBase = p.base

  const req = requiredChecks(state)
  for (const name of o.allowFail) {
    if (req.includes(name)) stop(`${n} --allow-fail 의 ${name} 는 필수 체크다. 필수 체크의 실패는 허용할 수 없다`)
  }
  const roll = o.skippedMissing ? ROLL_NAMES_NO_SKIPPED : ROLL_NAMES
  const allowed = `(.name // .context) as $nm | (${namesJson(o.allowFail)} | any(. == $nm))`
  state.q = {
    missing: `((${namesJson(req)}) - ${roll})`,
    failed: `[.statusCheckRollup[] | ${FAIL_SEL} | select(${allowed} | not)] | length`,
    allowedFailed: `[.statusCheckRollup[] | ${FAIL_SEL} | select(${allowed}) | (.name // .context)] | unique | .[]`,
  }

  p.beforeHead = null
  p.judgments = 0
  if (state.mode === 'quick') {
    const clash = overlapsDeferred(state)
    if (clash) throw new NotReady(clash)
  }
  await readyToMerge(stepContext, state, prCommand)

  // 머지 뒤에는 merge-base 가 바뀌어 문서 PR 인지 다시 판정할 수 없다. 머지 전에 정한다
  const kind = o.docsGlob && docsOnly(state) ? 'docs' : 'code'
  refuseWhenStopping(n)
  turn(state, TURN_PHASES.merge)
  const merge = gh(['pr', 'merge', n, `--${o.method}`, '--match-head-commit', p.ph], { timeoutMs: NO_LIMIT_MS })
  // 옛 명령은 stderr 를 stdout 에 합쳐 마지막 줄만 찍었다
  const last = chomp(merge.stdout + merge.stderr).split('\n').pop() ?? ''
  // 짧은 출력은 gh 의 줄을 따로 내지 않는다. 머지하지 못하면 아래 STOP 의 이유로 붙인다(설계 DECISION21)
  if (last && !short()) out(last)
  let merged = false
  for (let i = 0; i < 3; i++) {
    await nap(stepContext, 5)
    if ((await field(stepContext, state, n, 'state', '.state')) === 'MERGED') {
      merged = true
      break
    }
  }
  if (!merged) stop(short() && last ? `${n} 머지 실패: ${oneLine(last)}` : `${n} 머지 실패`)
  log(`${n} MERGED`)
  state.merged.push([n, kind])
  // 머지 뒤 원격 추적 브랜치를 갱신해야 remove-worktree.ts 가 워크트리 커밋을 원격에 있다고 본다
  git('fetch', '-q', 'origin')
  const branch = !o.keepBranch && !p.cross ? deleteBranch(state) : { retargeted: [], deleted: false }
  await afterMerge(stepContext, state, branch)
}

// 머지 직전까지의 확인을 끝낸다. 바로 머지로 판정한 뒤 base 가 움직였으면 다시 판정한다
export async function readyToMerge(stepContext: StepContext, state: StepState, prCommand: string | null): Promise<void> {
  const o = state.o
  const p = state.p
  const n = p.n
  for (;;) {
    await bringUpToDate(stepContext, state)

    const f = await field(stepContext, state, n, 'statusCheckRollup', state.q.failed)
    for (const name of (await field(stepContext, state, n, 'statusCheckRollup', state.q.allowedFailed)).split('\n')) {
      if (name) out(`경고: ${n} 실패를 허용한 체크 ${name}`)
    }
    const threads = await runAsync(['bash', '-c', o.threadsCmd], { env: { ...prEnv(state), GH_HOST: p.apiHost, ORCH_GH_CACHE: '0' }, timeoutMs: NO_LIMIT_MS })
    // 옛 명령은 스레드 명령의 stderr 를 받지 않고 그대로 흘렸다
    if (threads.stderr) process.stderr.write(threads.stderr)
    if (threads.code !== 0) stop(`${n} 스레드 조회 실패`)
    const t = chomp(threads.stdout)

    let m = await field(stepContext, state, n, 'mergeable', '.mergeable')
    for (let i = 0; i < 4; i++) {
      if (m !== 'UNKNOWN') break
      await nap(stepContext, 20)
      m = await field(stepContext, state, n, 'mergeable', '.mergeable')
    }

    log(`${n} fails=${f} threads=${t} mergeable=${m}`)
    if (m === 'CONFLICTING') throw new Conflict(`${n} base(${p.base}) 와 충돌한다(mergeable=CONFLICTING)`)
    if (f === '0' && t !== '0' && m === 'MERGEABLE') throw new WorkerFix(n, `미해결 리뷰 스레드 ${t} 개`, true)
    if (f !== '0' || t !== '0' || m !== 'MERGEABLE') stop(n)

    p.ov = []
    if (o.overlap) {
      const ov = overlapFiles(state)
      if (ov === null) stop(`${n} 겹침 판정 실패(PR HEAD 나 base 를 받지 못했다)`)
      p.ov = ov
      const listing = ov.join(' ')
      if (!state.verify) {
        if (ov.length > 0) stop(`${n} 겹침: ${listing}`)
      } else {
        if (ov.length > 0) log(`${n} 겹침: ${listing}`)
        if (o.verifyWhen !== 'overlap' || ov.length > 0) {
          if (o.verifyWhen !== 'always' && o.docsGlob && docsOnly(state)) {
            log(`${n} 문서만 바꿨다(--docs-glob). 합친 사본 검사 없이 머지한다`)
          } else {
            turn(state, TURN_PHASES.verify)
            await verifyMerged(state)
          }
        }
      }
    }

    // 같은 HEAD 에는 한 번만 낸다. base 가 움직여 다시 판정해도 HEAD 가 같으면 다시 내지 않는다
    if (p.beforeHead !== p.ph) {
      p.beforeHead = p.ph
      if (prCommand !== null || state.hooks.has('before-merge')) turn(state, TURN_PHASES.before)
      await beforeMerge(state, prCommand)
    }

    const ph2 = await field(stepContext, state, n, 'headRefOid', '.headRefOid')
    if (p.ph !== ph2) throw new HeadChanged(`${n} 검사 뒤 HEAD 가 바뀌었다 checked=${p.ph.slice(0, 8)} now=${ph2.slice(0, 8)}`)
    const evidence = ghJson<{ body: string; headRefOid: string }>(['pr', 'view', n, '--json', 'body,headRefOid', '--jq', '.'], { cwd: o.repo, cache: false })
    if (!evidence.ok || evidence.data.headRefOid !== p.ph) stop(`${n} 기능 완료 근거 또는 HEAD 조회 실패`)
    // 검증 커밋 뒤에 base 를 합친 merge 만 있으면(이 큐나 상주 루프의 update-branch) 받아들인다. 지금 HEAD 의 필수 체크는 위에서 기다렸다
    const problem = featureEvidenceProblem(evidence.data.body ?? '', p.ph, featureBranch(o.repo, p.branch), false,
      (verified) => fetchPrRefs(state) && baseMergesOnly(state.repoDir, p.ph, verified, p.base))
    if (problem) throw new WorkerFix(`${n} ${problem}`, problem)

    // 같은 HEAD 에 재실행만 생겨도 캐시의 완료 결과로 머지하지 않는다. 머지 전 명령 뒤에 읽는다.
    const latestFailed = await field(stepContext, state, n, 'statusCheckRollup', state.q.failed, true)
    const latestPending = await field(stepContext, state, n, 'statusCheckRollup', PENDING)
    const latestMissing = await field(stepContext, state, n, 'statusCheckRollup', `${state.q.missing} | length`)
    if (latestFailed !== '0' || latestPending !== '0' || latestMissing !== '0') stop(`${n} 머지 직전 체크가 바뀌었다 fails=${latestFailed} pending=${latestPending} missing=${latestMissing}`)
    if (!p.cross) {
      if (git('fetch', '-q', 'origin', p.branch).code !== 0) stop(`${n} 원격 브랜치 fetch 실패`)
      const rh = git('rev-parse', '-q', '--verify', `origin/${p.branch}`).stdout.trim()
      if (p.ph !== rh) stop(`${n} head 불일치 pr=${p.ph.slice(0, 8)} remote=${rh.slice(0, 8)}`)
    }
    if (!p.judgedBase) return
    if (remoteBase(state) === p.judgedBase) return
    log(`${n} 판정한 뒤 base(${p.base}) 가 움직였다. 새로 들어온 변경으로 다시 판정한다`)
  }
}

// before-merge 를 내고 `PR:명령` 을 돌린다.
export async function beforeMerge(state: StepState, prCommand: string | null): Promise<void> {
  const o = state.o
  const p = state.p
  const n = p.n
  const env = { ...prEnv(state), GH_HOST: p.apiHost }
  if (state.hooks.has('before-merge')) {
    const ctx = eventContext(state)
    const input = { pr: prInput(state), owner: p.owner, name: p.repo, last_of_task: o.lastOfTask.includes(n), has_pr_command: prCommand !== null }
    const done = await fire('before-merge', input, ctx)
    if (done.result === 'reject') stop(`${n} HOOK-REJECT`)
    if (failed(done)) stop(`${n} HOOK-FAIL`)
  }
  if (!prCommand) return
  log(`${n} 머지 전 명령: ${prCommand}`)
  const done = await runInherit(['bash', '-c', prCommand], { env, timeoutMs: NO_LIMIT_MS })
  if (done.code !== 0) stop(`${n} 머지 전 명령 실패`)
}

// after-merge 를 낸다. PR 은 이미 머지됐으므로 실패해도 멈추지 않고 HOOK-FAIL 줄만 남긴다(종료 코드 3)
export async function afterMerge(stepContext: StepContext, state: StepState, branch: { retargeted: number[]; deleted: boolean }): Promise<void> {
  if (!state.hooks.has('after-merge')) return
  const p = state.p
  const commit = await field(stepContext, state, p.n, 'mergeCommit', '.mergeCommit.oid // ""')
  const input = { pr: prInput(state), merge_commit: commit || null, remote_branch_deleted: branch.deleted, retargeted: branch.retargeted }
  try {
    if (failed(await fire('after-merge', input, eventContext(state)))) state.notifyFailed = true
  } catch (e) {
    // 설정 오류는 사용법 오류로 올린다. 그 밖의 오류로 머지된 PR 을 보류로 읽지 않는다
    if (e instanceof ConfigError) throw e
    process.stderr.write(`after-merge 를 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
    out('HOOK-FAIL after-merge error')
    state.notifyFailed = true
  }
}

// 머지한 브랜치를 base 로 둔 열린 PR. 조회하지 못하면 null
export function basedOn(state: StepState): GhPr[] | null {
  const found = ghJson<GhPr[]>(['pr', 'list', '--state', 'open', '--base', state.p.branch, '--json', 'number,author,url'])
  return found.ok && Array.isArray(found.data) ? found.data : null
}

// 「내 PR」 인지. 작성자 목록은 PR URL 의 호스트마다 한 번 읽는다. 정하지 못하면 null
export function ownPr(state: StepState, pr: GhPr): boolean | null {
  const host = apiTarget(pr.url)?.host
  if (!host) return null
  if (!state.authors.has(host)) state.authors.set(host, ownAuthors(state.repoDir, host))
  const authors = state.authors.get(host)
  if (!authors) return null
  return Boolean(pr.author?.login) && isOwnPr(pr as { author: { login: string } }, authors)
}

// 머지한 PR 의 원격 브랜치를 지운다. 그 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면 먼저 머지한 PR 의 base 로 옮긴다.
// 지우면 그 브랜치를 base 로 둔 열린 PR 이 닫히므로, 다른 사람의 PR 이 있거나 조회나 옮기기가 실패하면 남긴다
export function deleteBranch(state: StepState): { retargeted: number[]; deleted: boolean } {
  const p = state.p
  const retargeted: number[] = []
  const kept = (why: string) => {
    log(`${p.n} ${why} ${p.branch}`)
    return { retargeted, deleted: false }
  }
  if (p.branch.startsWith('release/')) {
    log(`${p.n} release 브랜치는 남긴다 ${p.branch}`)
    return { retargeted, deleted: false }
  }
  const based = basedOn(state)
  if (based === null) return kept('열린 PR 조회에 실패해 남긴다')
  if (based.length > 0) {
    const owns = based.map((pr) => ownPr(state, pr))
    if (owns.includes(null)) return kept('쌓인 PR 의 작성자를 정하지 못해 남긴다')
    const others = based.filter((_, i) => !owns[i]).map((pr) => pr.number)
    if (others.length > 0) return kept(`다른 사람의 열린 PR(${others.join(' ')}) 의 base 라 남긴다`)
    for (const pr of based) {
      if (stopping()) return kept(`${stopping()} 를 받아 끝내는 중이라 남긴다`)
      if (gh(['pr', 'edit', String(pr.number), '--base', p.base], { timeoutMs: NO_LIMIT_MS }).code !== 0) {
        return kept(`쌓인 PR ${pr.number} 의 base 를 옮기지 못해 남긴다`)
      }
      retargeted.push(pr.number)
      log(`${p.n} 쌓인 PR ${pr.number} 의 base 를 ${p.base} 로 옮겼다`)
    }
    // 옮기는 사이 새로 열린 PR 이 있으면 지우면서 닫는다. 다시 읽어 남은 것이 없을 때만 지운다
    const left = basedOn(state)
    if (left === null || left.length > 0) return kept('다른 열린 PR 의 base 이거나 조회 실패라 남긴다')
  }
  if (stopping()) return kept(`${stopping()} 를 받아 끝내는 중이라 남긴다`)
  const deleted = git('push', '-q', 'origin', '--delete', p.branch).code === 0
  if (deleted) log(`${p.n} 원격 브랜치 삭제 ${p.branch}`)
  git('fetch', '-q', '--prune', 'origin')
  return { retargeted, deleted }
}
