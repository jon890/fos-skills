// base 와 합친 임시 사본의 검사.

import { mkdirSync, realpathSync } from 'node:fs'
import type { FireContext } from '../../lib/events.ts'
import { fire } from '../../lib/events.ts'
import { WorkerFix } from './model.ts'
import type { StepState } from './model.ts'
import { names } from './overlap.ts'
import { eventContext, prInput } from './pr.ts'
import { failLabel, git, log, stop } from './runtime.ts'
import { dropCopy } from './setup.ts'
import { remoteBase } from './update.ts'

// origin/BASE 에 PR HEAD 를 merge 한 임시 사본에서 verify-merged 를 낸다. 통과하지 않으면 멈춘다
export async function verifyMerged(state: StepState): Promise<void> {
  const p = state.p
  const o = state.o
  let parent = ''
  try {
    mkdirSync(state.copyDir, { recursive: true })
    parent = realpathSync(state.copyDir)
  } catch {
    stop(`${p.n} 사본 폴더를 만들지 못했다: ${state.copyDir}`)
  }
  const bhDone = git('rev-parse', '-q', '--verify', `origin/${p.base}`)
  if (bhDone.code !== 0) stop(`${p.n} origin/${p.base} 를 읽지 못했다`)
  const bh = bhDone.stdout.trim()
  const mb = git('merge-base', bh, p.ph)
  if (mb.code !== 0) stop(`${p.n} 파일 목록의 기준을 읽지 못했다`)
  const changed = names(state, mb.stdout.trim(), p.ph)
  if (changed === null) stop(`${p.n} 바뀐 파일 목록을 읽지 못했다`)
  state.copy = `${parent}/merge-queue-pr${p.n}-${process.pid}`
  if (git('worktree', 'add', '-q', '--detach', state.copy, bh).code !== 0) stop(`${p.n} 사본을 만들지 못했다: ${state.copy}`)
  const merged = git(
    '-C',
    state.copy,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=merge-queue',
    '-c',
    'user.email=merge-queue@localhost',
    'merge',
    '-q',
    '--no-edit',
    p.ph,
  )
  if (merged.code !== 0) stop(`${p.n} base(${p.base}) 와 합치면 충돌한다`)
  log(`${p.n} 합친 사본에서 검사: hooks/verify-merged.ts`)
  const input = { pr: prInput(state), copy: state.copy, base_head: bh, changed_files: changed, overlap_files: p.ov }
  const ctx: FireContext = { ...eventContext(state), cwd: state.copy }
  const done = await fire('verify-merged', input, ctx)
  dropCopy(state)
  // 핸들러를 큐 시작 뒤에 지웠으면 none 이다. 검사하지 않은 조합을 머지하지 않도록 통과로 읽지 않는다
  if (done.result === 'none') stop(`${p.n} 합친 사본의 검사 실패(hooks/verify-merged.ts 가 없다)`)
  if (done.result !== 'pass') {
    throw new WorkerFix(`${p.n} 합친 사본의 검사 실패(종료 코드 ${failLabel(done)})`, `base(${p.base}) 와 합친 사본의 검사(hooks/verify-merged.ts)가 실패했다`)
  }
  // 검사하는 동안 base 가 움직였으면 검사한 조합과 머지할 조합이 다르다
  if (remoteBase(state) !== bh) stop(`${p.n} 검사하는 동안 base(${p.base}) 가 움직였다. 다시 돌린다`)
  log(`${p.n} 합친 사본의 검사 통과`)
}
