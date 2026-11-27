import assert from 'node:assert/strict'
import { test } from 'node:test'
import { featureMergePlan, featureStageText, isFeatureItem, nextFeatureStage, parseFeatureStages } from '../scripts/core/feature-stages.ts'
import { featureFolderOf, featureStageLine } from '../scripts/lib/spec.ts'

test('지시서의 기능 단계는 순서와 구현 차수를 검사한다', () => {
  for (const invalid of ['', 'unknown', 'spec implementation', 'verify implementation', 'implementation 0/2',
    'implementation 2/1', 'implementation 1/2 verify docs-consolidate', 'implementation 1/9007199254740992']) {
    assert.equal(parseFeatureStages(invalid), null, invalid)
  }
  assert.deepEqual(parseFeatureStages('implementation 3/3 verify docs-consolidate')?.map(featureStageText),
    ['implementation 3/3', 'verify', 'docs-consolidate'])
  assert.deepEqual(nextFeatureStage(parseFeatureStages('implementation 2/3 verify')!), { name: 'implementation', part: 3, total: 3 })
  assert.deepEqual(nextFeatureStage(parseFeatureStages('implementation 3/3 verify')!), { name: 'docs-consolidate' })
  assert.equal(nextFeatureStage(parseFeatureStages('docs-consolidate')!), null)
  assert.deepEqual(featureStageLine('# 기능\n기능 단계: spec\n## 할 일\n기능 단계: verify'), { text: 'spec', line: 2 })
  assert.equal(featureStageLine('## 할 일\n기능 단계: verify'), null)
  assert.equal(featureFolderOf('## 할 일\n루프를 쓴다(스펙: /outside/a/spec.md)', '/repo'), null)
})

test('스펙 PR 에서 기능 폴더 하나를 찾고 다른 단계는 그대로 둔다', () => {
  const item = { id: 'a', details: ['1. 기능 spec', '2. 수동 확인'],
    workers: [{ worktree: 'wt', pr: 77, 'feature-steps': '1' }] }
  const steps = item.details.map((text, i) => ({ number: i + 1, done: false, text }))
  assert.equal(isFeatureItem(item), true)
  assert.equal(featureMergePlan(item, steps, '78', []), null)
  assert.deepEqual(featureMergePlan(item, steps, '77', ['docs/features/a/spec.md']), {
    done: [1], status: 'doing', lastStage: false, add: '[ask] 기능 technical-design',
    feature: 'docs/features/a', featureUnknown: false,
  })
  assert.equal(featureMergePlan(item, steps, '77', ['docs/features/a/spec.md', 'docs/features/b/spec.md'])?.featureUnknown, true)
})
