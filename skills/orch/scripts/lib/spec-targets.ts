// 지시서의 브랜치마다 Run 과 머지 보류 줄. 루프, 관문, 머지 큐가 같은 지시서에서 보류를 읽는다. 같은 브랜치는 앞 Run 의 첫 지시서가 정한다.
import { isAbsolute, join } from 'node:path'
import { specHold } from './auto-merge.ts'
import { loadConfig } from './config.ts'
import { readSpecFiles } from './last-pr.ts'
import { mainCheckout } from './git.ts'
import { registeredRuns } from './loop.ts'
import { pathOf } from './paths.ts'
import { branchesOf } from './spec.ts'

type SpecRun = { run: string | null; specsDir: string | null }
type SpecTarget = { run: string; text: string; hold: string | null }

export function specTargets(repo: string, runs?: SpecRun[]): { targets: Map<string, SpecTarget>; unreadable: string[] } {
  const sources = runs ?? registeredRuns(repo).map((r) => ({ run: r.run, specsDir: r.specs_dir }))
  // 루프에 등록하지 않고 직접 gate/merge 를 부르는 경우에도 기본/설정 지시서를 본다.
  if (runs === undefined) {
    const configured = loadConfig(repo).finish?.specs_dir
    for (const dir of [pathOf('specs', repo), typeof configured === 'string' ? configured : null]) {
      if (dir) sources.push({ run: 'manual', specsDir: dir })
    }
  }
  const targets = new Map<string, SpecTarget>()
  const unreadable = new Set<string>()
  for (const { run, specsDir } of sources) {
    if (!run || !specsDir) continue
    const dir = isAbsolute(specsDir) ? specsDir : join(mainCheckout(repo), specsDir)
    const listed = readSpecFiles(dir)
    for (const path of listed.unreadable) unreadable.add(path)
    for (const spec of listed.files) {
      for (const branch of branchesOf(spec.text)) {
        if (!targets.has(branch)) targets.set(branch, { run, text: spec.text, hold: specHold(spec.text) })
      }
    }
  }
  return { targets, unreadable: [...unreadable] }
}

export function specReadError(unreadable: string[]): string {
  return `지시서를 읽지 못해 머지 보류를 확인할 수 없다: ${unreadable.map((path) => JSON.stringify(path)).join(', ')}`
}
