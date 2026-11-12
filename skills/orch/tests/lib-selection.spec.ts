import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { candidateOverrideOf, modelPolicies, modelRowIds, modelRows, selectionVerdict } from '../scripts/lib/selection.ts'
import { experimentOf, selectionsOf } from '../scripts/lib/spec.ts'
import { launchHistory, latestTerminal, recordHistory, type LaunchHistory } from '../scripts/lib/launch-history.ts'
import { forgetLaunch, readLaunch, recordLaunch } from '../scripts/lib/launched.ts'

let repo: string
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'selection-')); process.env.ORCH_DIR = join(repo, 'orch') })
afterEach(() => { delete process.env.ORCH_DIR; rmSync(repo, { recursive: true, force: true }) })
const opus = (effort = 'high', reason = '') => `worker 선택: \`claude\` \`claude-opus-5-5\` effort \`${effort}\`. 행: hard-design. ${reason} 비교: sol. 이유: 계약 설계.`
const sol = 'worker 선택: `codex` `gpt-6.1-sol` effort `low`. 행: impl-planned. 비교: Sonnet. 이유: 닫힌 결정.'
const experiment = 'experiment: trial-a. 후보: `claude` `claude-opus-5-5` effort `high` / `codex` `gpt-6.1-sol` effort `low`.'
const row = (extra: Partial<LaunchHistory> = {}): LaunchHistory => ({ dispatch: 'ctx_old', task: 'task_a', terminal: 'term_a', worktree: repo, branch: 'feat/a', run: 'run_a', at: '2026-11-05T00:00:00Z', title: '계약 설계', row: 'hard-design', agent: 'claude', model: 'claude-opus-5-5', effort: 'medium', retry_of: null, ...extra })

test('파서는 행, 근거, 실험을 읽고 후보 꼴과 중복 줄을 검사한다', () => {
  assert.deepEqual(selectionsOf(opus('high', 'high 근거: medium 실패 ctx_old.'))[0].highReason, { kind: 'dispatch', id: 'ctx_old' })
  assert.deepEqual(selectionsOf(opus('high', 'high 근거: 사용자 지정 2026-11-05.'))[0].highReason, { kind: 'user', date: '2026-11-05' })
  assert.equal(experimentOf(experiment)?.candidates.length, 2)
  for (const text of ['experiment: bad', `${experiment}\n${experiment}`, 'experiment: a. 후보: `x` `y` effort `z`.']) assert.ok(experimentOf(text)!.problems.length)
  assert.match(selectionVerdict(`${sol}\n${experiment.replace('`codex`', '`other`')}`, repo).join(), /후보 밖/)
})

test('문서의 행을 읽고 누락, 알 수 없는 행과 읽을 수 없는 표를 거부한다', () => {
  assert.deepEqual(selectionVerdict(sol, repo), [])
  assert.match(selectionVerdict(sol.replace('행: impl-planned.', ''), repo).join(), /행/)
  assert.match(selectionVerdict(sol.replace('impl-planned', 'unknown'), repo).join(), /모델 표에 없다/)
  assert.match(selectionVerdict(sol, repo, { table: join(repo, 'missing') }).join(), /표를 읽지 못했다/)
  const table = join(repo, 'table.md'); writeFileSync(table, '## 모델\n\n| `new-row` | 설명 | `gpt-6.1-sol` | effort |')
  assert.deepEqual(selectionVerdict(sol.replace('impl-planned', 'new-row'), repo, { table }), [])
})

test('후보 목록은 모델 칸에서만 읽고 괄호 조건과 effort 칸을 섞지 않는다', () => {
  const table = '## 모델\n| `example` | 설명 | `gpt-6.1-sol`(조건), Claude Sonnet 5.5 | Claude Opus 5.5 |\n### 다음 절\n| `other` | 설명 | `gpt-6-astra` |'
  assert.deepEqual([...modelRows(table)], [['example', ['gpt-6.1-sol', 'claude-sonnet-5-5']]])
  const source = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
  for (const [row, models] of modelRows(source)) {
    if (row !== 'review') assert.ok(models.length > 0, `${row} 후보 추출 실패`)
  }
})

test('실제 모델 표의 행별 후보가 승인한 선택 규칙과 같다', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
  assert.deepEqual(Object.fromEntries(modelRows(source)), {
    'impl-planned': ['gpt-6.1-sol', 'claude-sonnet-5-5'],
    'small-fix': ['claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6-luna'],
    'simple-apply': ['claude-haiku-5-5', 'gpt-6-luna'],
    'impl-explore': ['gpt-6.1-sol', 'claude-sonnet-5-5', 'claude-fable-5-2'],
    'hard-design': ['claude-opus-5-5', 'gpt-6.1-sol'],
    visual: ['gpt-6.1-terra'],
    review: [],
    'security-review': ['claude-sonnet-5-5', 'claude-opus-5-5'],
  })
})

test('후보 밖 이유는 선택 줄에서만 읽고 빈 이유 뒤의 다른 필드를 이유로 삼지 않는다', () => {
  const text = sol.replace('비교:', '후보 밖: 비교:')
  assert.match(selectionVerdict(text, repo, { launch: true }).join(), /후보 밖 이유/)
  assert.equal(selectionsOf(`${sol} 후보 밖: 도구 버전 5.5 비교 작업.`)[0].outsideReason, '도구 버전 5.5 비교 작업')
  assert.match(selectionVerdict(`${sol.replace('gpt-6.1-sol', 'gpt-6-astra')}\n후보 밖: 사용자 지정`, repo, { launch: true }).join(), /행 impl-planned 의 후보:/)
})

test('Terra 실험 표시는 Sonnet 이 후보인 행과 유효한 회차에만 후보 예외를 준다', () => {
  const terra = sol.replace('gpt-6.1-sol', 'gpt-6.1-terra')
  for (const marker of ['', 'Terra 실험 0/5', 'Terra 실험 6/5', 'Terra 실험 1/50', 'Terra 실험 1/5x', 'Fable 실험 1/5']) {
    assert.match(selectionVerdict(`${terra} ${marker}`, repo, { launch: true }).join(), /행 impl-planned 의 후보:/)
  }
  for (const marker of ['Terra 실험 1/5', 'Terra 실험 5/5(두 번째 시도)', 'Terra 실험 2/5, 비교)', 'Terra 실험 3/5, 비교 작업.', 'Terra 실험 4/5를 쓴다.']) {
    assert.deepEqual(selectionVerdict(`${terra} ${marker}`, repo, { launch: true }), [], marker)
  }
  const wrongRow = terra.replace('impl-planned', 'simple-apply')
  assert.match(selectionVerdict(`${wrongRow} Terra 실험 1/5`, repo, { launch: true }).join(), /행 simple-apply 의 후보:/)
  const generic = 'experiment: other. 후보: `codex` `gpt-6-astra` effort `medium` / `claude` `claude-sonnet-5-5` effort `medium`.'
  assert.match(selectionVerdict(`${sol.replace('gpt-6.1-sol', 'gpt-6-astra')}\n${generic}`, repo, { launch: true }).join(), /행 impl-planned 의 후보:/)
})

test('Fable 은 impl-explore 행의 후보이고 실험 표시 없이 통과하며 다른 행에서는 후보 밖이다', () => {
  const fable = (row: string, marker = '') => `worker 선택: \`claude\` \`claude-fable-5-2\` effort \`high\`. 행: ${row}. 비교: sol. 이유: 큰 구조 정리. ${marker}`
  assert.deepEqual(selectionVerdict(fable('impl-explore'), repo, { launch: true }), [])
  // 실험이 끝난 뒤에도 표시가 남은 옛 지시서는 표시와 관계없이 행의 후보로 판정한다
  assert.deepEqual(selectionVerdict(fable('impl-explore', 'Fable 실험 1/5'), repo, { launch: true }), [])
  for (const row of ['impl-planned', 'hard-design', 'small-fix']) {
    for (const marker of ['', 'Fable 실험 2/5']) assert.match(selectionVerdict(fable(row, marker), repo, { launch: true }).join(), new RegExp(`행 ${row} 의 후보:`))
  }
  assert.deepEqual(selectionVerdict(fable('hard-design', '후보 밖: 사용자 지정 2026-11-12.'), repo, { launch: true }), [])
})

test('Opus 높은 effort 는 유효 근거를 요구하고 다른 모델과 medium 은 통과한다', () => {
  for (const effort of ['high', 'xhigh', 'max']) assert.match(selectionVerdict(opus(effort), repo).join(), /high 근거/)
  assert.deepEqual(selectionVerdict(opus('medium'), repo), [])
  assert.deepEqual(selectionVerdict(opus().replace('claude-opus-', 'claude-sonnet-'), repo), [])
  assert.deepEqual(selectionVerdict(opus('high', 'high 근거: 사용자 지정 2026-11-05.'), repo), [])
  assert.match(selectionVerdict(opus('high', 'high 근거: 사용자 지정 2026-02-30.'), repo).join(), /날짜/)
  assert.match(selectionVerdict(opus('high', 'high 근거: 다른 이유.'), repo).join(), /high 근거/)
})

test('근거 dispatch 는 effective 우선, 옛 기록은 모델이 없을 때 호환된다', () => {
  const text = opus('high', 'high 근거: medium 실패 ctx_old.')
  assert.match(selectionVerdict(text, repo).join(), /Opus medium/)
  recordLaunch(repo, row({ model: null, effort: null }))
  assert.deepEqual(selectionVerdict(text, repo), [])
  recordLaunch(repo, row({ model: 'claude-sonnet-5-5' }))
  assert.match(selectionVerdict(text, repo).join(), /Opus medium/)
  recordHistory(repo, row({ model: 'claude-sonnet-5-5', effort: 'high', effective: { model: 'claude-opus-5-5', effort: 'medium' } }))
  assert.deepEqual(selectionVerdict(text, repo), [])
  forgetLaunch(repo, 'ctx_old')
  assert.equal(readLaunch(repo, 'ctx_old'), null)
  assert.equal(launchHistory(repo).length, 1)
  assert.deepEqual(selectionVerdict(text, repo), [])
})

test('실험은 띄울 때만 최소 배정과 동률 순서를 검사하며 재시도는 세지 않는다', () => {
  assert.deepEqual(selectionVerdict(`${sol}\n${experiment}`, repo), [])
  assert.match(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }).join(), /다음 experiment 후보: claude/)
  assert.deepEqual(selectionVerdict(`${opus('high', '후보 밖: 실험 비교.')}\n${experiment}`, repo, { launch: true }), [])
  recordHistory(repo, row({ experiment: 'trial-a', effort: 'high', retry_of: 'ctx_first' }))
  assert.match(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }).join(), /다음 experiment/)
  recordHistory(repo, row({ dispatch: 'ctx_new', experiment: 'trial-a', effort: 'high', at: '2026-11-06T00:00:00Z' }))
  assert.deepEqual(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }), [])
  assert.deepEqual(selectionVerdict(`${opus('high', '후보 밖: 실험 비교.')}\n${experiment}`, repo, { launch: true, retry: true }), [])
  assert.equal(latestTerminal(repo, 'term_a')?.dispatch, 'ctx_new')
})

test('근거의 실제 모델이나 effort 가 다르면 거부한다', () => {
  for (const [index, extra] of [
    { model: 'claude-sonnet-5-5', effort: 'medium' },
    { model: 'claude-opus-5-5', effort: 'high' },
    { effective: { model: 'claude-opus-5-5', effort: 'high' } },
  ].entries()) {
    const dispatch = `ctx_wrong_${index}`
    recordHistory(repo, row({ ...extra, dispatch }))
    assert.match(selectionVerdict(opus('high', `high 근거: medium 실패 ${dispatch}.`), repo).join(), /Opus medium/)
  }
})

test('실험의 기본 effort 는 옵션을 주지 않은 이력으로 집계한다', () => {
  const experiment = 'experiment: default-effort. 후보: `claude` `haiku` effort `기본` / `codex` `gpt-6.1-sol` effort `low`.'
  recordHistory(repo, row({ model: 'haiku', effort: null, experiment: 'default-effort' }))
  assert.deepEqual(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }), [])
})

test('새 영구 이력의 모델 null 은 모델 없는 옛 Launch 와 구별해 근거로 거부한다', () => {
  recordHistory(repo, row({ model: null, effort: null }))
  assert.match(selectionVerdict(opus('high', 'high 근거: medium 실패 ctx_old.'), repo).join(), /Opus medium/)
})

test('손상된 JSON 과 잘못된 필드 줄은 경고하고 정상 이력의 근거와 배정은 유지한다', () => {
  recordHistory(repo, row({ experiment: 'trial-a', effort: 'high' }))
  recordHistory(repo, row({ dispatch: 'ctx_medium', effort: 'medium' }))
  appendFileSync(join(repo, 'orch/state/launch-history.jsonl'), '{"dispatch":\n{"dispatch":"ctx_bad","at":"bad"}\n{"dispatch":')
  const warnings: string[] = []
  const mocked = mock.method(process.stderr, 'write', (chunk: unknown) => { warnings.push(String(chunk)); return true })
  try {
    assert.deepEqual(launchHistory(repo).map(row => row.dispatch), ['ctx_old', 'ctx_medium'])
    assert.deepEqual(selectionVerdict(opus('high', 'high 근거: medium 실패 ctx_medium.'), repo), [])
    assert.deepEqual(selectionVerdict(`${sol}\n${experiment}`, repo, { launch: true }), [])
    recordHistory(repo, row({ dispatch: 'ctx_new' }))
    assert.deepEqual(launchHistory(repo).map(row => row.dispatch), ['ctx_old', 'ctx_medium', 'ctx_new'])
    assert.match(warnings.join(''), /LAUNCH-HISTORY-SKIP/)
  } finally { mocked.mock.restore() }
})

test('행 id 는 모델 절의 표에서만 읽는다', () => {
  const table = '## 모델\n| `impl-planned` | 설명 | `gpt-6.1-sol` | low |\n### 비교 근거\n| `gpt-6-astra` | 가격 |'
  assert.deepEqual(modelRowIds(table), ['impl-planned'])
  const spec = '행: low'
  assert.match(selectionVerdict(`worker 선택: \`codex\` \`gpt-6.1-sol\` effort \`low\`. ${spec}`, tmpdir()).join(), /행 id 가 모델 표에 없다: low/)
})

test('행 id 가 모델 표에 없으면 표의 행 id 목록을 함께 내고, 모델 이름이면 작업 종류 id 를 쓰라고 덧붙인다', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
  const ids = modelRowIds(text).join(', ')
  const verdict = (row: string) => selectionVerdict(`worker 선택: \`claude\` \`claude-haiku-5-5\` effort \`low\`. 행: ${row}`, tmpdir()).join('\n')
  const model = verdict('claude-haiku-5-5')
  assert.match(model, new RegExp(`행 id 가 모델 표에 없다: claude-haiku-5-5\\. 모델 표의 행 id: ${ids}\\. 행에는 작업 종류 id 를 쓴다`))
  const plain = verdict('typo')
  assert.ok(plain.includes(`모델 표의 행 id: ${ids}`), plain)
  assert.doesNotMatch(plain, /작업 종류 id 를 쓴다/)
})

test('모든 후보의 effort 상한을 모델 표에서 읽고 표의 값이 바뀌면 검사도 바뀐다', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
  const policies = modelPolicies(source)
  for (const [row, policy] of policies) {
    if (row === 'review') continue
    for (const model of policy.models) assert.ok(policy.limits.has(model), `${row}: ${model} 상한 누락`)
  }
  assert.deepEqual([...policies.get('impl-planned')!.limits.values()], ['low', 'high'])
  assert.deepEqual([...policies.get('impl-explore')!.limits.values()], ['medium', 'high', 'high'])
  const table = join(repo, 'limits.md')
  writeFileSync(table, source.replace('sol `low`, Sonnet', 'sol `medium`, Sonnet'))
  assert.deepEqual(selectionVerdict(sol.replace('`low`', '`medium`'), repo, { launch: true, table }), [])
  writeFileSync(table, source.replace('sol `low`, Sonnet', 'sol 지정 없음, Sonnet'))
  assert.match(selectionVerdict(sol, repo, { launch: true, table }).join(), /effort 상한을 읽지 못했다/)
})

test('행별 상한과 낮은 effort, high 근거와 리뷰 예외를 지킨다', () => {
  assert.deepEqual(selectionVerdict(sol, repo, { launch: true }), [])
  for (const effort of ['medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.match(selectionVerdict(sol.replace('`low`', `\`${effort}\``), repo, { launch: true }).join(), /effort 상한: low/)
  }
  const explore = sol.replace('impl-planned', 'impl-explore').replace('`low`', '`medium`')
  assert.deepEqual(selectionVerdict(explore, repo, { launch: true }), [])
  assert.match(selectionVerdict(explore.replace('`medium`', '`high`'), repo, { launch: true }).join(), /effort 상한: medium/)
  assert.deepEqual(selectionVerdict(explore.replace('`medium`', '`high`') + ' 후보 밖: 복잡한 재현.', repo, { launch: true }), [])
  assert.deepEqual(selectionVerdict(sol.replace('impl-planned', 'hard-design').replace('`low`', '`high`'), repo, { launch: true }), [])
  assert.deepEqual(selectionVerdict(sol.replace('impl-planned', 'review').replace('`low`', '`high`'), repo, { launch: true }), [])
  assert.deepEqual(selectionVerdict(opus('high', 'high 근거: 사용자 지정 2026-11-12.'), repo, { launch: true }), [])
})


test('기본값이나 알 수 없는 effort 로 상한 검사를 건너뛰지 않는다', () => {
  for (const effort of ['기본', 'unknown']) {
    assert.match(selectionVerdict(sol.replace('`low`', `\`${effort}\``), repo, { launch: true }).join(), /명시한 effort/)
  }
  const haiku = 'worker 선택: `claude` `claude-haiku-5-5` effort `기본`. 행: small-fix. 비교: luna. 이유: 문구 수정.'
  assert.deepEqual(selectionVerdict(haiku, repo, { launch: true }), [])
  assert.match(selectionVerdict(haiku.replace('`기본`', '`high`'), repo, { launch: true }).join(), /effort 상한: medium/)
})


test('effort 예외 기록에는 요청값과 상한을 남기고 정상 선택에는 남기지 않는다', () => {
  const reason = '후보 밖: 복잡한 재현.'
  assert.equal(candidateOverrideOf(`${sol} ${reason}`), null)
  assert.deepEqual(candidateOverrideOf(`${sol.replace('`low`', '`high`')} ${reason}`), {
    row: 'impl-planned', model: 'gpt-6.1-sol', reason: '복잡한 재현', effort: 'high', effortLimit: 'low',
  })
  assert.equal(candidateOverrideOf(`${sol.replace('impl-planned', 'review').replace('`low`', '`high`')} ${reason}`), null)
})


test('visual 의 시작 effort 는 상한이 아니므로 medium 과 high 도 허용한다', () => {
  for (const effort of ['low', 'medium', 'high']) {
    const text = `worker 선택: \`codex\` \`gpt-6.1-terra\` effort \`${effort}\`. 행: visual. 비교: sol. 이유: 화면 확인.`
    assert.deepEqual(selectionVerdict(text, repo, { launch: true }), [])
    assert.equal(candidateOverrideOf(`${text} 후보 밖: 이전 선택에서 복사.`), null)
  }
})


test('검증된 이어하기만 상한 검사를 생략하고 재시도 표지만으로는 생략하지 않는다', () => {
  const text = sol.replace('`low`', '`medium`')
  assert.deepEqual(selectionVerdict(text, repo, { launch: true, continuation: true }), [])
  assert.match(selectionVerdict(text, repo, { launch: true, retry: true }).join(), /effort 상한: low/)
})


test('표에 명시한 모델 기본값은 허용하고 상한이 더 낮은 행에서는 거부한다', () => {
  for (const [model, row] of [['claude-sonnet-5-5', 'impl-planned'], ['claude-fable-5-2', 'impl-explore'], ['claude-haiku-5-5', 'simple-apply']]) {
    const text = `worker 선택: \`claude\` \`${model}\` effort \`기본\`. 행: ${row}. 비교: sol. 이유: 기본값 확인.`
    assert.deepEqual(selectionVerdict(text, repo, { launch: true }), [])
    if (model === 'claude-sonnet-5-5') {
      assert.match(selectionVerdict(text.replace(row, 'small-fix'), repo, { launch: true }).join(), /effort 상한: medium/)
    }
  }
  const source = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
  const table = join(repo, 'defaults.md')
  writeFileSync(table, source.replaceAll('Sonnet `high`(기본)', 'Sonnet `low`(기본)'))
  const text = 'worker 선택: `claude` `claude-sonnet-5-5` effort `기본`. 행: small-fix. 비교: sol. 이유: 기본값 확인.'
  assert.deepEqual(selectionVerdict(text, repo, { launch: true, table }), [])
})
