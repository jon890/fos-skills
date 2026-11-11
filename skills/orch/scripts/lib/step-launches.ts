// 자동 진행 단계의 띄운 기록은 지우지 않고 한 줄씩 덧붙인다.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensure, pathOf } from './paths.ts'

export function stepLaunches(repo: string, item: string, step: string): Array<{ dispatch: string; branch: string | null }> {
  let text: string
  try { text = readFileSync(join(pathOf('state', repo), 'step-launches.jsonl'), 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  return text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line)
      return row?.item === item && row.step === step && typeof row.dispatch === 'string' && row.dispatch ?
        [{ dispatch: row.dispatch, branch: typeof row.branch === 'string' ? row.branch : null }] : []
    } catch { return [] }
  })
}

export function appendStepLaunch(repo: string, row: { item: string; number: number; step: string; dispatch: string; branch: string | null }): void {
  const file = join(ensure('state', repo), 'step-launches.jsonl')
  let separator = ''
  try {
    const text = readFileSync(file, 'utf8')
    if (text && !text.endsWith('\n')) separator = '\n'
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  appendFileSync(file, `${separator}${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8')
}
