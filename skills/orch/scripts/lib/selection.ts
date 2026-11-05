// 지침 표와 지시서의 선택 계약. lint 와 launch 차례 0 이 같은 판정을 쓴다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import { launchHistory } from './launch-history.ts'
import { readLaunch } from './launched.ts'
import { experimentOf, selectionsOf, type Candidate } from './spec.ts'

export function selectionVerdict(text: string, repo: string, options: { launch?: boolean; table?: string; retry?: boolean } = {}): string[] {
  const choices = selectionsOf(text)
  if (!choices.length) return ['`worker 선택:` 줄이 없다']
  const selection = choices[0]
  const errors = choices.length > 1 ? ['`worker 선택:` 줄은 하나만 둔다'] : []
  errors.push(...selection.problems.map(p => `${p} 가 빠졌거나 형식이 틀렸다`))
  let table: string
  try { table = readFileSync(options.table ?? join(bundleRoot(), 'references', 'agent-selection.md'), 'utf8') }
  catch { return [...errors, '모델 표를 읽지 못했다'] }
  const ids = [...table.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gm)].map(m => m[1])
  if (!ids.length) errors.push('모델 표를 읽지 못했다')
  else if (selection.row && !ids.includes(selection.row)) errors.push(`행 id 가 모델 표에 없다: ${selection.row}`)
  const experiment = experimentOf(text)
  const effortOf = (value: string | null | undefined) => value === '기본' ? null : value ?? null
  const same = (a: Partial<Candidate>, b: Partial<Candidate>) =>
    a.agent === b.agent && a.model === b.model && effortOf(a.effort) === effortOf(b.effort)
  if (experiment) {
    errors.push(...experiment.problems)
    if (!experiment.candidates.some(c => same(c, selection))) errors.push('worker 선택이 experiment 후보 밖이다')
  }
  try {
    if (/^claude-opus-/.test(selection.model ?? '') && ['high', 'xhigh', 'max'].includes(selection.effort ?? '') && !experiment) {
      const reason = selection.highReason
      if (!reason) errors.push('Opus high 이상은 high 근거가 필요하다')
      else if (reason.kind === 'user') {
        const date = new Date(`${reason.date}T00:00:00Z`)
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== reason.date) errors.push('high 근거 날짜가 틀렸다')
      } else {
        const history = launchHistory(repo).find(row => row.dispatch === reason.id)
        const prior = history ?? readLaunch(repo, reason.id)
        const model = prior?.effective?.model ?? prior?.model
        const effort = prior?.effective?.effort ?? prior?.effort
        if (!prior || (model && (!/^claude-opus-/.test(model) || effort !== 'medium'))) errors.push(`high 근거 dispatch 가 Opus medium 이 아니다: ${reason.id}`)
      }
    }
    if (options.launch && experiment && !experiment.problems.length && !options.retry) {
      const history = launchHistory(repo).filter(row => row.experiment === experiment.name && !row.retry_of)
      const counts = experiment.candidates.map(c => history.filter(row => same(row, c)).length)
      const next = experiment.candidates[counts.indexOf(Math.min(...counts))]
      if (!same(next, selection)) errors.push(`다음 experiment 후보: ${next.agent} ${next.model} effort ${next.effort}`)
    }
  } catch (e) { errors.push(`띄우기 이력을 읽지 못했다: ${(e as Error).message}`) }
  return errors
}
