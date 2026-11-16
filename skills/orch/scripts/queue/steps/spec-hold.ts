// 루프와 수동 큐가 같은 지시서에서 보류를 읽는다. 같은 브랜치는 앞 Run 의 첫 지시서가 정한다.
import { isAbsolute, join } from 'node:path'
import { prHold, specHold } from '../../lib/auto-merge.ts'
import { gh } from '../../lib/gh.ts'
import { loadConfig } from '../../lib/config.ts'
import { specFiles } from '../../lib/last-pr.ts'
import { mainCheckout } from '../../lib/git.ts'
import { registeredRuns } from '../../lib/loop.ts'
import { pathOf } from '../../lib/paths.ts'
import { branchesOf } from '../../lib/spec.ts'
import type { StepState } from './model.ts'
import { out, stop } from './runtime.ts'

type SpecRun = { run: string | null; specsDir: string | null }
export function specTargets(repo: string, runs?: SpecRun[]): Map<string, { run: string; text: string; hold: string | null }> {
  const sources = runs ?? registeredRuns(repo).map((r) => ({ run: r.run, specsDir: r.specs_dir }))
  // 루프에 등록하지 않고 직접 gate/merge 를 부르는 경우에도 기본/설정 지시서를 본다.
  if (runs === undefined) {
    const configured = loadConfig(repo).finish?.specs_dir
    for (const dir of [pathOf('specs', repo), typeof configured === 'string' ? configured : null]) {
      if (dir) sources.push({ run: 'manual', specsDir: dir })
    }
  }
  const targets = new Map<string, { run: string; text: string; hold: string | null }>()
  for (const { run, specsDir } of sources) {
    if (!run || !specsDir) continue
    for (const spec of specFiles(isAbsolute(specsDir) ? specsDir : join(mainCheckout(repo), specsDir))) {
      for (const branch of branchesOf(spec.text)) {
        if (!targets.has(branch)) targets.set(branch, { run, text: spec.text, hold: specHold(spec.text) })
      }
    }
  }
  return targets
}

// PR 본문을 지금 읽는다. 열린 뒤에 본문만 고쳐 보류를 적을 수 있어서 캐시를 쓰지 않는다. 읽지 못하면 null 이다
function prBody(state: StepState): string | null {
  const got = gh(['pr', 'view', state.p.n, '--json', 'body', '--jq', '.body'], { cache: false })
  return got.code === 0 ? got.stdout : null
}

// 지시서 보류가 먼저고, 없으면 PR 본문의 보류다. gate 는 본문을 읽지 못해도 보류 없음으로 두고, merge(refuseSpecHold)는 멈춘다
export function mergeHold(state: StepState, body: string | null = prBody(state)): string | null {
  const spec = state.pr?.branch ? specTargets(state.repoDir).get(state.p.branch)?.hold : null
  return spec ?? (body === null ? null : prHold(body))
}

export function refuseSpecHold(state: StepState): void {
  const body = prBody(state)
  if (body === null) stop(`${state.p.n} PR 본문을 읽지 못해 머지 보류 줄을 확인할 수 없다`)
  const hold = mergeHold(state, body)
  if (hold === null) return
  out(`GATE-HOLD ${hold}`)
  stop(`${state.p.n} 머지 보류: ${hold}`)
}
