// 루프와 수동 큐가 같은 지시서에서 보류를 읽는다. 같은 브랜치는 앞 Run 의 첫 지시서가 정한다.
import { isAbsolute, join } from 'node:path'
import { specHold } from '../../lib/auto-merge.ts'
import { loadConfig } from '../../lib/config.ts'
import { specFiles } from '../../lib/last-pr.ts'
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
    for (const spec of specFiles(isAbsolute(specsDir) ? specsDir : join(repo, specsDir))) {
      for (const branch of branchesOf(spec.text)) {
        if (!targets.has(branch)) targets.set(branch, { run, text: spec.text, hold: specHold(spec.text) })
      }
    }
  }
  return targets
}

export function mergeHold(state: StepState): string | null {
  return specTargets(state.repoDir).get(state.p.branch)?.hold ?? null
}

export function refuseSpecHold(state: StepState): void {
  const hold = mergeHold(state)
  if (hold === null) return
  out(`GATE-HOLD ${hold}`)
  stop(`${state.p.n} 지시서 보류: ${hold}`)
}
