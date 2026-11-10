// 머지 큐 옵션과 사용법 검사.

import { readFileSync } from 'node:fs'
import { groupMap } from '../../lib/overlap.ts'
import { QUEUE_VALUE_OPTIONS } from '../../lib/queue-options.ts'
import type { Options, StepContext } from './model.ts'
import { Usage } from './model.ts'
import { isDigits, splitNames } from './runtime.ts'

// 머리 주석이 사용법을 소유한다. 사용법 오류에 메시지가 없으면(인자 없음, -h) 그것을 찍는다
export function usageText(stepContext: StepContext): string {
  const lines: string[] = []
  for (const line of readFileSync(stepContext.script, 'utf8').split('\n')) {
    if (!line.startsWith('//')) break
    lines.push(line.replace(/^\/\/ ?/, ''))
  }
  return lines.join('\n')
}
export function parseArgs(argv: string[]): Options {
  const o: Options = {
    repo: '.',
    method: 'merge',
    threadsCmd: '',
    checkTimeout: '60',
    missingTimeout: '5',
    required: [],
    allowFail: [],
    upToDate: false,
    upToDateWhen: 'always',
    sharedPaths: '',
    unitPrefix: 'modules/',
    unitGroups: [],
    keepBranch: false,
    sweep: true,
    sweepArgs: [],
    overlap: false,
    verifyWhen: 'overlap',
    docsGlob: '',
    updateDocs: false,
    continueOnHold: true,
    pollMinSec: '60',
    pollMaxSec: '300',
    ciExpectedSec: '',
    skippedMissing: false,
    copyDir: '',
    lastOfTask: [],
    chains: [],
    items: [],
  }
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') throw new Usage('')
    if (QUEUE_VALUE_OPTIONS.includes(arg)) {
      const value = i + 1 < argv.length ? argv[i + 1] : ''
      if (!value) throw new Usage(`${arg} 에 값이 없다`)
      i += 2
      if (arg === '--repo') o.repo = value
      else if (arg === '--method') o.method = value
      else if (arg === '--threads-cmd') o.threadsCmd = value
      else if (arg === '--check-timeout') o.checkTimeout = value
      else if (arg === '--missing-timeout') o.missingTimeout = value
      else if (arg === '--required') o.required.push(...splitNames(value))
      else if (arg === '--required-check') o.required.push(value)
      else if (arg === '--allow-fail') o.allowFail.push(...splitNames(value))
      else if (arg === '--allow-fail-check') o.allowFail.push(value)
      else if (arg === '--up-to-date-when') o.upToDateWhen = value
      else if (arg === '--shared-paths') o.sharedPaths = value
      else if (arg === '--unit-prefix') o.unitPrefix = value
      else if (arg === '--unit-group') o.unitGroups.push(value)
      else if (arg === '--verify-merged-when') o.verifyWhen = value
      else if (arg === '--docs-glob') o.docsGlob = o.docsGlob ? `${o.docsGlob},${value}` : value
      else if (arg === '--copy-dir') o.copyDir = value
      else if (arg === '--sweep-arg') o.sweepArgs.push(value)
      else if (arg === '--last-of-task') o.lastOfTask.push(value)
      else if (arg === '--chain') o.chains.push(value.split(','))
      else if (arg === '--poll-min-sec') o.pollMinSec = value
      else if (arg === '--poll-max-sec') o.pollMaxSec = value
      else if (arg === '--ci-expected-sec') o.ciExpectedSec = value
      continue
    }
    if (arg === '--require-up-to-date') o.upToDate = true
    else if (arg === '--keep-branch') o.keepBranch = true
    else if (arg === '--continue-on-hold') o.continueOnHold = true
    else if (arg === '--stop-on-hold') o.continueOnHold = false
    else if (arg === '--skipped-is-missing') o.skippedMissing = true
    else if (arg === '--stop-on-overlap') o.overlap = true
    else if (arg === '--update-docs-on-overlap') o.updateDocs = o.overlap = true
    else if (arg === '--no-sweep') o.sweep = false
    else if (arg.startsWith('-')) throw new Usage(`모르는 옵션: ${arg}`)
    else o.items.push(arg)
    i += 1
  }
  return validate(o)
}
export function validate(o: Options): Options {
  if (o.items.length === 0) throw new Usage('')
  if (!['merge', 'squash', 'rebase'].includes(o.method)) throw new Usage('--method 는 merge, squash, rebase 중 하나다')
  if (!isDigits(o.checkTimeout)) throw new Usage('--check-timeout 은 분 단위 정수다')
  if (!isDigits(o.missingTimeout)) throw new Usage('--missing-timeout 은 분 단위 정수다')
  for (const [name, value] of [['--poll-min-sec', o.pollMinSec], ['--poll-max-sec', o.pollMaxSec], ['--ci-expected-sec', o.ciExpectedSec || '1']]) {
    if (!isDigits(value) || Number(value) < 1) throw new Usage(`${name} 는 1 이상의 정수(초)다`)
  }
  if (Number(o.pollMinSec) > Number(o.pollMaxSec)) throw new Usage('--poll-min-sec 는 --poll-max-sec 보다 클 수 없다')
  if (!['overlap', 'code', 'always'].includes(o.verifyWhen)) throw new Usage('--verify-merged-when 은 overlap, code, always 중 하나다')
  if (!['always', 'overlap'].includes(o.upToDateWhen)) throw new Usage('--up-to-date-when 은 always, overlap 중 하나다')
  if (o.upToDateWhen === 'overlap') {
    if (!o.upToDate) throw new Usage('--up-to-date-when overlap 은 --require-up-to-date 와 함께 쓴다')
  } else if (o.sharedPaths || o.unitGroups.length > 0) {
    throw new Usage('--shared-paths 와 --unit-group 은 --up-to-date-when overlap 과 함께 쓴다')
  }
  // 핸들러 파일이 있어야 하는 옵션은 preflight 가 본다
  if (o.updateDocs && !o.docsGlob) throw new Usage('--update-docs-on-overlap 은 --docs-glob 이 필요하다')
  if (o.required.some((name) => /["\\]/.test(name))) throw new Usage('--required 에 따옴표나 역슬래시를 넣을 수 없다')
  if (o.allowFail.some((name) => /["\\]/.test(name))) throw new Usage('--allow-fail 에 따옴표나 역슬래시를 넣을 수 없다')
  for (const name of o.allowFail) {
    if (o.required.includes(name)) {
      throw new Usage(`--allow-fail 의 ${name} 는 --required 에도 있다. 필수 체크의 실패는 허용할 수 없다`)
    }
  }
  try {
    groupMap(o.unitGroups.map((group) => group.split(',')))
  } catch (e) {
    throw new Usage(`--unit-group: ${(e as Error).message}`)
  }
  for (const item of o.items) {
    if (!isDigits(item.split(':')[0])) throw new Usage(`PR 번호가 아니다: ${item}`)
  }
  const queued = o.items.map((item) => item.split(':')[0])
  for (const n of o.lastOfTask) {
    if (!queued.includes(n)) throw new Usage(`--last-of-task ${n} 는 큐에 없는 PR 이다`)
  }
  const chained = new Set<string>()
  for (const chain of o.chains) {
    const label = chain.join(',')
    if (chain.length < 2 || !chain.every(isDigits)) throw new Usage(`--chain ${label} 은 PR 번호 둘 이상을 쉼표로 잇는다`)
    for (const n of chain) {
      if (!queued.includes(n)) throw new Usage(`--chain ${label} 의 ${n} 는 큐에 없는 PR 이다`)
      if (chained.has(n)) throw new Usage(`--chain ${label} 의 ${n} 는 다른 묶음에도 있다`)
      chained.add(n)
    }
    const order = chain.map((n) => queued.indexOf(n))
    if (order.some((at, i) => i > 0 && at <= order[i - 1])) throw new Usage(`--chain ${label} 은 큐의 순서와 같게 적는다`)
  }
  return o
}
