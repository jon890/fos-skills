// 차례가 온 PR 의 base 최신화.
// update-branch 앞에서 계약 머리 자동 합치기(lib/contract-merge.ts)를 본다. config.json 의 contracts 절이 있고 같은 저장소 PR 이며
// origin/<base> 와 합친 충돌 파일이 모두 contracts.paths 에 맞으면 로컬에서 합쳐 push 하고 update-branch 를 부르지 않는다.
// 합치지 못하면 `CONTRACT-MERGE-FAIL` 을 로그에 쓰고 지금처럼 update-branch 를 부른다(충돌이면 Conflict 로 worker 에게 간다).

import { loadConfig } from '../../lib/config.ts'
import { contractSettings, mergeContracts, onlyContracts } from '../../lib/contract-merge.ts'
import { updateBranch } from '../../lib/gh.ts'
import { conflicts, git as gitIn } from '../../lib/git.ts'
import { TURN_PHASES } from '../../lib/queue-turn.ts'
import { waitChecks } from './checks.ts'
import type { StepContext } from './model.ts'
import { Conflict, Deferred, NotReady, REJUDGE_LIMIT } from './model.ts'
import type { StepState } from './model.ts'
import { docsOnly, fetchPrRefs, needsUpdate, overlapFiles, prFiles } from './overlap.ts'
import { api, field, turn } from './pr.ts'
import { chomp, git, isDigits, log, nap, refuseWhenStopping, stop } from './runtime.ts'

// 원격 base 의 지금 SHA. 조회하지 못하면 base 가 움직인 것으로 읽지 않고 멈춘다
export function remoteBase(stepContext: StepContext, state: StepState): string {
  const p = state.p
  const done = git('ls-remote', 'origin', `refs/heads/${p.base}`)
  const sha = done.code === 0 ? done.stdout.split('\t')[0].trim() : ''
  if (!sha) stop(`${p.n} base 조회 실패`)
  return sha
}

// 머리 주석의 계약 머리 자동 합치기. push 했으면 true 다. 설정이 없거나 합칠 대상이 아니거나 실패하면 false 다
export function contractMerged(stepContext: StepContext, state: StepState): boolean {
  const p = state.p
  if (p.cross) return false
  const settings = contractSettings(loadConfig(state.repoDir))
  if (!settings) return false
  if (!fetchPrRefs(stepContext, state)) {
    log(`${p.n} CONTRACT-MERGE-FAIL PR HEAD 나 base 를 받지 못했다`)
    return false
  }
  const baseSha = gitIn(state.repoDir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${p.base}`]).stdout.trim()
  const judged = baseSha ? conflicts(state.repoDir, baseSha, p.ph) : null
  if (!judged || !judged.ok) {
    log(`${p.n} CONTRACT-MERGE-FAIL base 와 합쳐 보지 못했다`)
    return false
  }
  if (!judged.conflict || !onlyContracts(judged.files, settings)) return false
  const merged = mergeContracts(state.repoDir, { number: Number(p.n), branch: p.branch, head: p.ph, base: p.base, baseSha }, settings)
  if (merged.kind === 'pushed') {
    log(`${p.n} CONTRACT-MERGED ${merged.head.slice(0, 8)} 계약 머리만 충돌해 로컬에서 합쳐 push 했다: ${judged.files.join(', ')}`)
    if (merged.output) log(merged.output)
    return true
  }
  log(`${p.n} CONTRACT-MERGE-FAIL ${merged.kind === 'failed' ? merged.reason : merged.kind === 'other' ? `다른 파일도 충돌한다: ${merged.files.join(', ')}` : 'git 이 충돌 없이 합쳤다'}`)
  return false
}

// 필수 체크를 기다리고, 켜져 있으면 base 최신화와 문서 PR 갱신을 한다
export async function bringUpToDate(stepContext: StepContext, state: StepState): Promise<void> {
  const o = state.o
  const p = state.p
  const n = p.n
  let rounds = 0
  p.judgedBase = null
  for (;;) {
    p.judgedBase = null
    turn(stepContext, state, rounds > 0 ? TURN_PHASES.updated : TURN_PHASES.checks)
    await waitChecks(stepContext, state)
    let updateDocs = false
    if (o.updateDocs) {
      const ov = overlapFiles(stepContext, state)
      if (ov === null) stop(`${n} 문서 PR 의 겹침 판정 실패`)
      if (ov.length > 0 && docsOnly(stepContext, state)) {
        if (state.mode === 'quick') throw new NotReady('문서 PR 의 갱신이 필요하다')
        const ms = await field(stepContext, state, n, 'mergeStateStatus', '.mergeStateStatus')
        if (ms !== 'CLEAN') stop(`${n} 문서 PR 을 갱신하려면 GitHub CLEAN 이 필요하다(현재 ${ms})`)
        updateDocs = true
      }
    }
    if (!(o.upToDate || updateDocs)) return
    // 비교보다 먼저 읽는다. 그 사이 base 가 움직였으면 나중에 다른 값으로 보여 다시 판정한다
    const baseAtCompare = o.upToDateWhen === 'overlap' ? remoteBase(stepContext, state) : null
    const compared = api(stepContext, state, `repos/${p.owner}/${p.repo}/compare/${p.base}...${p.ph}`, '--jq', '.behind_by')
    const behind = compared.code === 0 ? chomp(compared.stdout) : ''
    if (!isDigits(behind)) stop(`${n} base 와 비교 실패`)
    if (behind === '0') {
      // 최신이라 판정은 거치지 않는다. 이 뒤(스레드 조회, mergeable 재시도, 머지 전 명령)에 base 가
      // 움직이면 readyToMerge 가 다시 판정하도록 지금 base 를 적어 둔다
      if (o.upToDateWhen === 'overlap') p.judgedBase = baseAtCompare
      return
    }
    // 문서 PR 갱신(updateDocs)은 겹침을 이미 확인한 뒤의 결정이라 판정을 거치지 않는다
    if (o.upToDateWhen === 'overlap' && !updateDocs) {
      // 갱신하고 CI 를 기다리는 사이 base 가 또 움직였을 수 있어, 이 자리에 올 때마다 새로 판정한다
      p.judgments += 1
      if (p.judgments > REJUDGE_LIMIT + 1) stop(`${n} 다시 판정을 ${REJUDGE_LIMIT}번 했는데도 base(${p.base}) 가 계속 움직인다`)
      if (!needsUpdate(stepContext, state)) return
    }
    if (state.mode === 'quick') throw new NotReady('base 최신화가 필요하다')
    rounds += 1
    if (rounds > (o.upToDateWhen === 'overlap' ? REJUDGE_LIMIT + 1 : 3)) {
      stop(`${n} base 를 ${rounds - 1}번 merge 해도 최신이 아니다. base 가 계속 움직인다`)
    }
    log(`${n} base(${p.base}) 보다 ${behind} 커밋 뒤처졌다. update-branch 후 체크를 다시 기다린다`)
    // 차례가 온 이 PR 에만 base 를 합친다. 검사한 HEAD 를 넘겨, 그 뒤에 push 된 커밋이 있으면 GitHub 가 거부하게 한다.
    // merge-turn 은 draft 여부를 보지 않는다
    refuseWhenStopping(n)
    if (!contractMerged(stepContext, state)) {
      const updated = updateBranch(`${p.owner}/${p.repo}`, { number: Number(n), isDraft: false }, 'merge-turn', {
        host: p.apiHost,
        expectedHead: p.ph,
      })
      if (updated.code !== 0) {
        if (/conflict/i.test(updated.stderr + updated.stdout)) throw new Conflict(`${n} update-branch 가 충돌로 실패했다`)
        stop(`${n} update-branch 실패`)
      }
    }
    // update-branch 는 비동기라 PR HEAD 가 바뀔 때까지 기다린다. 계약 합치기의 push 도 GitHub 에 보이기까지 같은 방법으로 기다린다
    let next = ''
    for (let i = 0; i < 12; i++) {
      await nap(stepContext, 5)
      next = await field(stepContext, state, n, 'headRefOid', '.headRefOid')
      if (next && next !== p.ph) break
    }
    if (!next || next === p.ph) stop(`${n} update-branch 뒤 HEAD 가 바뀌지 않았다`)
    p.ph = next
    // 체크를 기다리는 동안 뒤 PR 을 먼저 머지할 수 있게 대기를 미룬다(머리 주석의 「앞지르기」). 바꾼 파일을 읽지 못하면 미루지 않는다
    if (state.mode === 'defer') {
      const files = prFiles(stepContext, state)
      if (files !== null) throw new Deferred(n, files)
    }
  }
}
