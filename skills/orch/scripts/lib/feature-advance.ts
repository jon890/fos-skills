import { linesRev } from '../../../../modules/work-board/item.ts'
import { featureMergePlan, isFeatureItem } from '../core/feature-stages.ts'
import { prNumbers, type BoardItem, type BoardStep } from '../core/board.ts'
import { boardWorkerRows } from '../core/board-workers.ts'
import { ghJson } from './gh.ts'
import { mainCheckout } from './git.ts'

export function featureAdvance(repo: string, item: BoardItem, steps: BoardStep[], source: string | { report: string }) {
  const pr = typeof source === 'string' ? source : null
  if (!isFeatureItem(item) || (pr && prNumbers(item['merged-pr']).has(pr))) return null
  const plan = featureMergePlan(item, steps, source, [])
  if (!plan) return null
  const files = pr && plan.featureUnknown ? ghJson<{ files?: { path: string; additions?: number }[] }>(
    ['pr', 'view', pr, '--json', 'files'], { cwd: repo },
  ) : null
  const resolved = files?.ok && Array.isArray(files.data.files)
    ? featureMergePlan(item, steps, source, files.data.files.filter((file) => file.additions !== 0).map((file) => file.path))! : plan
  const args = ['feature-advance', item.id, ...(typeof source === 'string' ? ['--pr', source] : ['--report', source.report]), '--done', resolved.done.join(','), '--status', resolved.status,
    ...(resolved.add ? ['--add', resolved.add] : []), ...(resolved.lastStage ? ['--final'] : []),
    ...(resolved.feature ? ['--feature', resolved.feature, '--feature-repo', mainCheckout(repo)] : []),
    '--if-rev', linesRev(item)]
  return { ...resolved, args }
}

export function hasFeaturePr(item: Record<string, unknown>, pr: string): boolean {
  return isFeatureItem(item) && boardWorkerRows(item).some((row) => String(row.pr) === pr && row['feature-steps'] && !row['feature-report'])
}
