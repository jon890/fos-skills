import { sameFamily } from '../scripts/lib/model-generation.ts'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { candidateOverrideOf, modelPolicies, modelRowIds, selectionVerdict } from '../scripts/lib/selection.ts'
import { readLaunch, recordLaunch } from '../scripts/lib/launched.ts'

let repo: string
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'selection-')) })
afterEach(() => { rmSync(repo, { recursive: true, force: true }) })
const source = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
const sol = 'worker 선택: `codex` `gpt-6.1-sol` effort `low`. 행: impl-planned. 이유: 계획서가 수정 위치를 정했다.'

test('모든 행의 worker 가 스펙의 행과 worker 표와 같다', () => {
  const spec = readFileSync(join(import.meta.dirname, '../../../docs/features/orch-single-worker/spec.md'), 'utf8')
  const expected = new Map([...spec.matchAll(/^\| `([^`]+)` \|[^|]*\| `([^`]+)` `([^`]+)` (`[^`]+`|기본 effort) \|/gm)]
    .map(m => [m[1], [{ agent: m[2], model: m[3], effort: m[4] === '기본 effort' ? '기본' : m[4].replaceAll('`', '') }]]))
  const policies = modelPolicies(source)
  assert.ok(expected.size > 0)
  for (const [id, policy] of policies) {
    if (id === 'review') {
      assert.deepEqual(policy.workers, [{ agent: 'codex', model: 'gpt-6.2-sol', effort: 'medium' }, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }])
    } else {
      // 스펙의 표는 행을 정할 때의 세대를 적는다. 모델 표는 같은 계열의 새 세대로 바뀔 수 있다(lib/model-generation.ts)
      const want = expected.get(id)
      assert.equal(policy.workers.length, want?.length, id)
      policy.workers.forEach((w, i) => {
        assert.deepEqual([w.agent, w.effort], [want![i].agent, want![i].effort], id)
        assert.ok(sameFamily(w.model, want![i].model), `${id}: ${w.model} / ${want![i].model}`)
      })
    }
    for (const worker of policy.workers) {
      const text = `worker 선택: \`${worker.agent}\` \`${worker.model}\` effort \`${worker.effort}\`. 행: ${id}. 이유: 해당 작업.`
      assert.deepEqual(selectionVerdict(text, repo), [], id)
      assert.equal(candidateOverrideOf(`${text} 후보 밖: 복사한 이유.`), null)
    }
  }
  assert.deepEqual([...policies.keys()].filter(id => id !== 'review').sort(), [...expected.keys()].sort())
})

test('에이전트·모델·effort 가 하나만 달라도 lint 와 launch 모두 이유를 요구한다', () => {
  for (const text of [sol.replace('`codex`', '`claude`'), sol.replace('gpt-6.1-sol', 'gpt-6.1-terra'), sol.replace('`low`', '`medium`'), sol.replace('impl-planned', 'impl-explore'), sol.replace('`low`', '`기본`')]) {
    for (const launch of [false, true]) {
      assert.match(selectionVerdict(text, repo, { launch }).join(), /후보 밖: <이유>/)
      assert.deepEqual(selectionVerdict(`${text} 후보 밖: 한도 Codex.`, repo, { launch }), [])
    }
    assert.ok(candidateOverrideOf(`${text} 후보 밖: 한도 Codex.`))
  }
})

test('기본 effort 는 명시한 단계와 다르고 낮은 effort 도 예외다', () => {
  for (const id of ['simple-apply', 'hard-design', 'impl-hard']) {
    const worker = modelPolicies(source).get(id)!.workers[0]
    const text = `worker 선택: \`${worker.agent}\` \`${worker.model}\` effort \`기본\`. 행: ${id}. 이유: 작업 내용.`
    assert.deepEqual(selectionVerdict(text, repo), [])
    assert.match(selectionVerdict(text.replace('`기본`', '`medium`'), repo).join(), /후보 밖/)
  }
  assert.match(selectionVerdict(sol.replace('impl-planned', 'impl-explore'), repo).join(), /후보 밖/)
})

test('Opus 높은 effort 와 ultra 도 후보 밖 이유 하나로 허용한다', () => {
  for (const effort of ['high', 'xhigh', 'max', 'ultra']) {
    const text = `worker 선택: \`claude\` \`claude-opus-5-5\` effort \`${effort}\`. 행: hard-design. 이유: 사용자 지정.`
    assert.match(selectionVerdict(text, repo).join(), /후보 밖/)
    assert.deepEqual(selectionVerdict(`${text} 후보 밖: 한도 claude.`, repo), [])
    assert.equal(candidateOverrideOf(`${text} 후보 밖: 한도 claude.`)?.effort, effort)
  }
})

test('예외 기록은 실제 선택 전체와 이유, 다른 effort 의 행 값을 남긴다', () => {
  assert.deepEqual(candidateOverrideOf(`${sol.replace('`low`', '`medium`')} 후보 밖: 재현에 필요.`), {
    row: 'impl-planned', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', effortLimit: 'low', reason: '재현에 필요',
  })
  assert.equal(candidateOverrideOf(`${sol} 후보 밖: 복사한 이유.`), null)
  for (const reason of ['', ' .', ' 이유: 정상 이유.']) {
    assert.match(selectionVerdict(`${sol.replace('`codex`', '`claude`')} 후보 밖:${reason}`, repo).join(), /후보 밖/)
  }
  assert.match(selectionVerdict(`${sol.replace('gpt-6.1-sol', 'other')}\n후보 밖: 별도 이유`, repo).join(), /후보 밖/)
})

test('정리용 기록을 다시 읽어도 후보 밖 이유와 worker 가 보존된다', () => {
  const candidateOverride = candidateOverrideOf(`${sol.replace('`low`', '`medium`')} 후보 밖: 한도 Codex.`)!
  const main_guard = { version: 1 as const, main: 'run_main', caller_repo: repo, target_repo: repo }
  recordLaunch(repo, { dispatch: 'ctx_override', terminal: null, worktree: repo, run: null, effective: { candidateOverride }, main_guard, not_main: '테스트 예외' })
  const saved = readLaunch(repo, 'ctx_override')!
  assert.deepEqual(saved.effective?.candidateOverride, candidateOverride)
  assert.deepEqual(saved.main_guard, main_guard)
  assert.equal(saved.not_main, '테스트 예외')
})

test('비교 칸과 experiment 는 새 지시서에서 금지하고 확인된 이어하기에서만 허용한다', () => {
  for (const text of [sol.replace('이유:', '비교: Sonnet. 이유:'), `${sol}\nexperiment: broken`, `${sol}\n- **experiment:** old`]) {
    assert.match(selectionVerdict(text, repo).join(), /쓰지 않는다/)
    assert.deepEqual(selectionVerdict(text, repo, { continuation: true }), [])
    assert.match(selectionVerdict(text, repo, { retry: true }).join(), /쓰지 않는다/)
  }
})

test('코드 블록·인용의 예시와 이유 문장 속 비교 낱말은 금지 항목이 아니다', () => {
  for (const fence of ['```markdown', '~~~markdown']) {
    const close = fence.startsWith('`') ? '```' : '~~~'
    const text = [fence, `${sol} 비교: Sonnet.`, 'experiment: example', close, sol].join('\n')
    assert.deepEqual(selectionVerdict(text, repo), [])
    assert.deepEqual(selectionVerdict(text.replaceAll('\n', '\r\n'), repo), [])
    assert.deepEqual(selectionVerdict(text.replaceAll('\n', '\u2028'), repo), [])
    assert.equal(candidateOverrideOf(`${text} 후보 밖: 복사한 이유.`), null)
  }
  assert.deepEqual(selectionVerdict(`${sol}\n> experiment: quoted\n> worker 선택: 예시 비교: Sonnet.`, repo), [])
  assert.deepEqual(selectionVerdict(sol.replace('이유: 계획서가 수정 위치를 정했다.', '이유: 문장의 비교: 낱말을 정리한다.'), repo), [])
  assert.deepEqual(selectionVerdict(sol.replace('이유: 계획서가 수정 위치를 정했다.', '이유: 첫 문장이다. 비교: 두 번째 문장이다.'), repo), [])
  assert.deepEqual(selectionVerdict(`${sol.replace('`low`', '`high`')} 후보 밖: 이유의 비교: 예시를 고친다.`, repo), [])
  assert.match(selectionVerdict(sol.replace('이유:', '비교: Sonnet. 이유:'), repo).join(), /쓰지 않는다/)
  assert.match(selectionVerdict(sol.replace('impl-planned.', 'impl-planned 비교: Sonnet.'), repo).join(), /쓰지 않는다/)
  assert.equal(candidateOverrideOf(`${sol.replace('`low`', '`high`')} 후보 밖: 첫 문장이다. 비교: 두 번째 문장이다.`)?.reason, '첫 문장이다. 비교: 두 번째 문장이다')
})

test('누락·중복·알 수 없는 행·읽지 못한 표는 예외 이유로도 통과하지 않는다', () => {
  assert.match(selectionVerdict('', repo).join(), /줄이 없다/)
  assert.match(selectionVerdict(`${sol}\n${sol}`, repo).join(), /하나만/)
  for (const text of [sol.replace('행: impl-planned.', ''), sol.replace('impl-planned', 'unknown'), sol.replace('이유: 계획서가 수정 위치를 정했다.', '이유: .')]) assert.ok(selectionVerdict(`${text} 후보 밖: 지정.`, repo).length)
  assert.match(selectionVerdict(sol, repo, { table: join(repo, 'missing') }).join(), /표를 읽지 못했다/)
  const model = selectionVerdict(sol.replace('impl-planned', 'gpt-6.1-sol'), repo).join()
  assert.ok(model.includes(modelRowIds(source).join(', ')))
  assert.match(model, /행에는 작업 종류 id/)
})

test('표의 값 변경은 검사에 반영되고 빈 값·중복 후보는 읽지 못한 행으로 거절한다', () => {
  const file = join(repo, 'table.md')
  const table = '## 모델\n| `impl-planned` | 구현 | `codex` | `gpt-6.1-sol` | `medium` |\n### 다음 절\n| `ignored` | 설명 | `x` | `y` | `low` |'
  writeFileSync(file, table)
  assert.deepEqual(modelRowIds(table), ['impl-planned'])
  assert.deepEqual(selectionVerdict(sol.replace('`low`', '`medium`'), repo, { table: file }), [])
  for (const broken of [table.replace('`medium`', ''), table.replace('`codex`', '`codex` / `claude`')]) {
    writeFileSync(file, broken)
    assert.match(selectionVerdict(`${sol} 후보 밖: 지정.`, repo, { table: file }).join(), /worker 를 읽지 못했다/)
  }
})
