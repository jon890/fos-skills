// 지침 표와 지시서의 선택 계약. lint 와 launch 차례 0 이 같은 판정을 쓴다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import { launchHistory } from './launch-history.ts'
import { readLaunch } from './launched.ts'
import { experimentOf, selectionsOf, type Candidate } from './spec.ts'

// agent-selection.md 의 `## 모델` 제목과 그 아래 첫 하위 제목 사이의 표에서 행 id 와 모델 칸을 읽는다.
// 하위 절의 표(비교 근거, 가격 등)의 첫 칸이 행 id 로 통과하지 않게 좁힌다
export function modelRows(table: string): Map<string, string[]> {
  const lines = table.split('\n')
  const start = lines.indexOf('## 모델')
  if (start === -1) return new Map()
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,6} /.test(line))
  return new Map([...(end === -1 ? rest : rest.slice(0, end)).join('\n').matchAll(/^\| `([a-z][a-z0-9-]*)` \|[^|]*\|([^|]*)\|/gm)].map(m => [
    m[1], [...m[2].matchAll(/`((?:gpt|claude)-[^`]+)`|Claude ([A-Za-z]+) (\d+(?:\.\d+)+)/g)]
      .map(model => model[1] ?? `claude-${model[2].toLowerCase()}-${model[3].replaceAll('.', '-')}`),
  ]))
}

export function modelRowIds(table: string): string[] { return [...modelRows(table).keys()] }

export function selectionVerdict(text: string, repo: string, options: { launch?: boolean; table?: string; retry?: boolean; continuation?: boolean } = {}): string[] {
  const choices = selectionsOf(text)
  if (!choices.length) return ['`worker 선택:` 줄이 없다']
  const selection = choices[0]
  const errors = choices.length > 1 ? ['`worker 선택:` 줄은 하나만 둔다'] : []
  errors.push(...selection.problems.filter(p => !(options.continuation && p === '행')).map(p => `${p} 가 빠졌거나 형식이 틀렸다`))
  let table: string
  try { table = readFileSync(options.table ?? join(bundleRoot(), 'references', 'agent-selection.md'), 'utf8') }
  catch { return [...errors, '모델 표를 읽지 못했다'] }
  const rows = modelRows(table)
  const ids = [...rows.keys()]
  if (!ids.length) errors.push('모델 표를 읽지 못했다')
  else if (selection.row && !ids.includes(selection.row)) {
    // 모델 이름(claude-haiku-5-5, gpt-6-luna)을 행 id 로 쓴 실수가 잦다. 쓸 수 있는 id 목록과 함께 알린다
    const modelName = selection.row === selection.model || /^(claude|gpt|codex|gemini|o\d)-/.test(selection.row)
    errors.push(`행 id 가 모델 표에 없다: ${selection.row}. 모델 표의 행 id: ${ids.join(', ')}${modelName ? '. 행에는 작업 종류 id 를 쓴다' : ''}`)
  }
  const experiment = experimentOf(text)
  const candidates = rows.get(selection.row ?? '')
  if (options.launch && candidates && selection.row !== 'review') {
    if (!candidates.length) errors.push(`행 ${selection.row} 의 후보 목록을 읽지 못했다`)
    else if (!candidates.includes(selection.model ?? '') && !selection.outsideReason) {
      const line = text.split('\n')[selection.no - 1]
      const trial = selection.model === 'claude-fable-5-2' ? 'Fable' : selection.model === 'gpt-6.1-terra' && candidates.includes('claude-sonnet-5-5') ? 'Terra' : null
      if (!trial || !new RegExp(`(?:^|\\s)${trial} 실험 [1-5]/5(?=\\s|[.]|$)`).test(line)) {
        errors.push(`행 ${selection.row} 의 후보: ${candidates.join(', ')}. 후보 밖이면 \`worker 선택:\` 줄에 \`후보 밖: <이유>\` 를 적는다`)
      }
    }
  }
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
        if (!prior || (history && !model) || (model && (!/^claude-opus-/.test(model) || effort !== 'medium'))) errors.push(`high 근거 dispatch 가 Opus medium 이 아니다: ${reason.id}`)
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
