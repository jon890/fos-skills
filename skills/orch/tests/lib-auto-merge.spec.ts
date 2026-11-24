// lib/auto-merge.ts 의 자동 머지 판정을 본다. 판정 함수는 입력만 받으므로 가짜 프로세스 없이 함수만 부른다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  autoMergeConfig,
  beforeCommand,
  boardHold,
  compareVersion,
  judgeReview,
  judgeMigrations,
  maxByModule,
  migrationOf,
  queueOrder,
  reservedFor,
  prHold,
  specHold,
  sweepArgs,
} from '../scripts/lib/auto-merge.ts'
import { ConfigError } from '../scripts/lib/config.ts'
import type { Migration, QueueItem, ReviewConfig, ReviewNote } from '../scripts/lib/auto-merge.ts'
import type { Config } from '../scripts/lib/config.ts'

const DIRS = { api: 'db/api', web: 'db/web' }

function mig(module: string, label: string): Migration {
  return { module, version: label.slice(1).split(/[._]/).map(Number), label, path: `db/${module}/${label}__x.sql` }
}

describe('autoMergeConfig', () => {
  test('빈 설정은 꺼진 자동 머지와 기본값이다', () => {
    assert.deepEqual(autoMergeConfig({}), { enabled: false, review: null, ignoredReviewKeys: [], dirs: {}, watch: {}, before: null, blockedAfterSec: 3600 })
  })

  test('값을 읽고 dirs 끝의 / 를 뗀다', () => {
    const got = autoMergeConfig({
      queue: { auto_merge: true, auto_review: { review_checks: ['claude-review', 'claude-review'] } },
      migrations: { dirs: { api: 'db/api/' }, watch: { api: ['src/main/java/db/migration/'] }, before: { '*': 'backup {module}' }, blocked_after_sec: 60 },
    })
    assert.equal(got.enabled, true)
    assert.deepEqual(got.dirs, { api: 'db/api' })
    assert.deepEqual(got.watch, { api: ['src/main/java/db/migration'] })
    assert.deepEqual(got.before, { '*': 'backup {module}' })
    assert.equal(got.blockedAfterSec, 60)
    assert.deepEqual(got.review, { checks: ['claude-review'] })
  })

  const bad: [string, Config][] = [
    ['queue.auto_merge 가 문자열', { queue: { auto_merge: 'yes' } }],
    ['queue.auto_review 가 문자열', { queue: { auto_review: 'claude-review' } }],
    ['queue.auto_review 에 모르는 키', { queue: { auto_review: { review_checks: ['x'], hold: 'x' } } }],
    ['queue.auto_review.review_checks 가 문자열', { queue: { auto_review: { review_checks: 'claude-review' } } }],
    ['queue.auto_review.review_checks 가 빈 목록', { queue: { auto_review: { review_checks: [] } } }],
    ['queue.auto_review.review_checks 에 빈 문자열', { queue: { auto_review: { review_checks: ['x', ' '] } } }],
    ['migrations.blocked_after_sec 가 0', { migrations: { blocked_after_sec: 0 } }],
    ['migrations.dirs 의 값이 빈 문자열', { migrations: { dirs: { api: '' } } }],
    ['migrations.watch 의 값이 문자열', { migrations: { watch: { api: 'src/main/java/db/migration' } } }],
    ['migrations.watch 의 경로가 빈 문자열', { migrations: { watch: { api: [''] } } }],
    ['migrations.before 의 값이 숫자', { migrations: { before: { api: 1 } } }],
    ['migrations 절의 모르는 키', { migrations: { dir: {} } }],
  ]
  for (const [name, config] of bad) {
    test(`${name} 은 ConfigError 다`, () => {
      assert.throws(() => autoMergeConfig(config), ConfigError)
    })
  }

  // 사용자 결정 2026-11-24: 리뷰 댓글 문구로 판정하지 않는다. 옛 키는 설정 오류로 막지 않고 읽지 않는다
  test('옛 문구 판정 키는 읽지 않고 ignoredReviewKeys 에 둔다. 남는 리뷰 설정이 없으면 review 는 null 이다', () => {
    const old = autoMergeConfig({ queue: { auto_review: { pass: 'ok', block: 'no', require: ['nope'], feature_head: false, fixed_after_block: true, fallback: { check: 'x' } } } })
    assert.equal(old.review, null)
    assert.deepEqual(old.ignoredReviewKeys, ['block', 'fallback', 'feature_head', 'fixed_after_block', 'pass', 'require'])
    const mixed = autoMergeConfig({ queue: { auto_review: { pass: 'ok', review_checks: ['claude-review'] } } })
    assert.deepEqual(mixed.review, { checks: ['claude-review'] })
    assert.deepEqual(mixed.ignoredReviewKeys, ['pass'])
  })
})

describe('specHold', () => {
  test('굵은 목록 줄의 이유를 낸다', () => {
    assert.equal(specHold('# 제목\n\n- **머지 보류:** #12 real 배포 뒤\n- 브랜치: `feat/x`'), '#12 real 배포 뒤')
  })

  test('이유가 비면 이유 없음이다', () => {
    assert.equal(specHold('머지 보류:'), '이유 없음')
  })

  test('줄 가운데의 머지 보류 문장은 보류 줄이 아니다', () => {
    assert.equal(specHold('이 PR 은 머지 보류: 없이 간다'), null)
    assert.equal(specHold(''), null)
  })
})

describe('prHold', () => {
  test('본문 가운데 줄 머리의 보류 줄에서 이유를 낸다', () => {
    assert.equal(prHold('## 요약\n\n- 머지 보류: #12 real 배포 뒤\n\n## 결정'), '#12 real 배포 뒤')
    assert.equal(prHold('- **머지 보류:** 배포 뒤'), '배포 뒤')
  })

  test('보류 줄이 없거나 줄 가운데에만 있으면 null 이다', () => {
    assert.equal(prHold('## 요약\n보류 없음'), null)
    assert.equal(prHold('이 PR 은 머지 보류: 없이 간다'), null)
    assert.equal(prHold(''), null)
  })
})

describe('boardHold', () => {
  test('끝나지 않은 details 줄이 머지 보류로 시작하면 그 줄이다', () => {
    assert.equal(boardHold({ id: 'a', details: [{ text: '머지 보류: 배포 뒤', done: false }] }), '머지 보류: 배포 뒤')
  })

  test('끝난 줄은 보지 않는다', () => {
    assert.equal(boardHold({ id: 'a', details: [{ text: '머지 보류: 배포 뒤', done: true }] }), null)
  })

  test('옛 문자열 next 는 줄마다 끝나지 않은 줄이고 번호가 앞에 붙어도 된다', () => {
    assert.equal(boardHold({ id: 'a', next: '1. 구현\n2. 머지 보류 까지 대기' }), '2. 머지 보류 까지 대기')
  })

  test('목록 안의 옛 문자열 줄도 끝나지 않은 줄이다', () => {
    assert.equal(boardHold({ id: 'a', next: ['머지 보류 해제 대기'] }), '머지 보류 해제 대기')
  })

  test('next 와 details 가 없으면 null 이다', () => {
    assert.equal(boardHold({ id: 'a' }), null)
  })
})

describe('migrationOf', () => {
  test('모듈 폴더 아래 버전 마이그레이션을 읽는다', () => {
    assert.deepEqual(migrationOf('db/api/V12__add.sql', { api: 'db/api/' }), {
      module: 'api',
      version: [12],
      label: 'V12',
      path: 'db/api/V12__add.sql',
    })
  })

  test('점과 밑줄로 나눈 버전을 숫자 목록으로 읽는다', () => {
    assert.deepEqual(migrationOf('db/api/V1_2__a.sql', DIRS)?.version, [1, 2])
    assert.deepEqual(migrationOf('db/api/V1.10__a.sql', DIRS)?.label, 'V1.10')
  })

  test('반복 마이그레이션, dirs 밖, 폴더 이름만 같은 경로는 null 이다', () => {
    assert.equal(migrationOf('db/api/R__view.sql', { api: 'db/api/' }), null)
    assert.equal(migrationOf('db/web/V1__x.sql', { api: 'db/api/' }), null)
    assert.equal(migrationOf('db/apix/V1__x.sql', { api: 'db/api' }), null)
    assert.equal(migrationOf('db/api/U1__undo.sql', { api: 'db/api' }), null)
  })

  test('같은 모듈의 감시 폴더 여러 곳을 하나의 번호 공간으로 읽는다', () => {
    assert.deepEqual(migrationOf('src/main/java/db/migration/V13__add.java', { api: ['db/api', 'src/main/java/db/migration'] }), {
      module: 'api', version: [13], label: 'V13', path: 'src/main/java/db/migration/V13__add.java',
    })
  })
})

describe('compareVersion', () => {
  test('자리마다 숫자로 비교하고 짧은 쪽 뒤는 0 이다', () => {
    assert.ok(compareVersion([1, 2], [1, 10]) < 0, '[1,2] 는 [1,10] 보다 낮아야 한다')
    assert.equal(compareVersion([2], [2, 0]), 0)
    assert.ok(compareVersion([3], [2, 9]) > 0, '[3] 은 [2,9] 보다 높아야 한다')
  })
})

describe('maxByModule', () => {
  test('모듈마다 가장 높은 버전을 고르고 마이그레이션이 아닌 파일은 뺀다', () => {
    const got = maxByModule(['db/api/V2__a.sql', 'db/api/V10__b.sql', 'db/api/R__v.sql', 'db/web/V1__c.sql', 'README.md'], DIRS)
    assert.deepEqual(
      [...got].map(([module, m]) => [module, m.label]),
      [
        ['api', 'V10'],
        ['web', 'V1'],
      ],
    )
  })

  test('빈 목록은 빈 맵이다', () => {
    assert.equal(maxByModule([], DIRS).size, 0)
  })
})

describe('judgeMigrations', () => {
  const baseMax = new Map([['api', mig('api', 'V12')]])

  test('base 최고 이하의 번호는 clash 다', () => {
    assert.deepEqual(judgeMigrations(30, [mig('api', 'V11')], baseMax, []), {
      clashes: [{ module: 'api', label: 'V11', reason: 'base 최고 V12 이하' }],
      lower: [],
    })
  })

  test('다른 열린 PR 과 같은 번호는 clash 다', () => {
    const got = judgeMigrations(30, [mig('api', 'V13')], baseMax, [{ pr: 31, migrations: [mig('api', 'V13')] }])
    assert.deepEqual(got.clashes, [{ module: 'api', label: 'V13', reason: '#31 과 같은 번호' }])
  })

  test('같은 모듈에 더 낮은 번호를 더한 다른 열린 PR 은 lower 다', () => {
    const got = judgeMigrations(30, [mig('api', 'V14')], baseMax, [{ pr: 32, migrations: [mig('api', 'V13')] }])
    assert.deepEqual(got, { clashes: [], lower: [{ pr: 32, branch: null, module: 'api', label: 'V13', mine: 'V14' }] })
  })

  test('같은 PR 번호와 다른 모듈, base 이하의 번호는 다른 PR 판정에서 뺀다', () => {
    const others = [
      { pr: 30, migrations: [mig('api', 'V13')] },
      { pr: 33, migrations: [mig('web', 'V13'), mig('api', 'V11')] },
    ]
    assert.deepEqual(judgeMigrations(30, [mig('api', 'V14')], baseMax, others), { clashes: [], lower: [] })
  })

  test('같은 모듈을 여러 번 더하면 각각 본다', () => {
    const got = judgeMigrations(30, [mig('api', 'V12'), mig('api', 'V15')], baseMax, [{ pr: 34, migrations: [mig('api', 'V14')] }])
    assert.deepEqual(got, {
      clashes: [{ module: 'api', label: 'V12', reason: 'base 최고 V12 이하' }],
      lower: [{ pr: 34, branch: null, module: 'api', label: 'V14', mine: 'V15' }],
    })
  })

  const base2 = new Map([['api', mig('api', 'V2')]])

  test('base 최고와 이 PR 사이의 다른 브랜치 예약은 pr 이 null 인 lower 다', () => {
    const got = judgeMigrations(30, [mig('api', 'V4')], base2, [], [{ branch: 'feat/x', migrations: [mig('api', 'V3')] }])
    assert.deepEqual(got, { clashes: [], lower: [{ pr: null, branch: 'feat/x', module: 'api', label: 'V3', mine: 'V4' }] })
  })

  test('이 PR 과 같은 번호의 예약은 그 브랜치 이름의 clash 다', () => {
    const got = judgeMigrations(30, [mig('api', 'V4')], base2, [], [{ branch: 'feat/x', migrations: [mig('api', 'V4')] }])
    assert.deepEqual(got, { clashes: [{ module: 'api', label: 'V4', reason: 'feat/x 의 예약과 같은 번호' }], lower: [] })
  })

  test('base 최고 이하의 예약은 lower 가 아니고, base 이하 clash 가 예약 clash 보다 먼저다', () => {
    const reserved = [{ branch: 'feat/x', migrations: [mig('api', 'V2'), mig('api', 'V1')] }]
    assert.deepEqual(judgeMigrations(30, [mig('api', 'V2'), mig('api', 'V5')], base2, [], reserved), {
      clashes: [{ module: 'api', label: 'V2', reason: 'base 최고 V2 이하' }],
      lower: [],
    })
  })
})

describe('reservedFor', () => {
  const reserved = [
    { branch: 'feat-a', migrations: [mig('api', 'V3')] },
    { branch: 'feat-b', migrations: [mig('api', 'V4'), mig('web', 'V4')] },
    { branch: 'feat-c', migrations: [mig('api', 'V5')] },
  ]

  test('대상 PR 자기 브랜치의 예약과, 그 브랜치의 열린 PR 이 같은 (모듈, 번호)를 더한 예약은 뺀다', () => {
    const open = new Map([
      ['feat-b', [mig('api', 'V4')]],
      ['feat-c', [mig('api', 'V6')]],
    ])
    assert.deepEqual(reservedFor('feat-a', reserved, open), [
      { branch: 'feat-b', migrations: [mig('web', 'V4')] },
      { branch: 'feat-c', migrations: [mig('api', 'V5')] },
    ])
  })

  test('예약이 없으면 빈 목록이다', () => {
    assert.deepEqual(reservedFor('feat-a', [], new Map()), [])
  })
})

describe('beforeCommand', () => {
  test('* 규칙의 {module} 을 바꾸고 정렬한 모듈 순서로 잇는다', () => {
    assert.deepEqual(beforeCommand(['web', 'api'], { '*': 'backup {module}' }), { ok: true, command: 'backup api && backup web' })
  })

  test('모듈 규칙이 * 보다 먼저다', () => {
    assert.deepEqual(beforeCommand(['api', 'web'], { api: 'dump api', '*': 'backup {module}' }), { ok: true, command: 'dump api && backup web' })
  })

  test('규칙이 없는 모듈이 있으면 그 모듈을 낸다', () => {
    assert.deepEqual(beforeCommand(['web'], { api: 'b' }), { ok: false, module: 'web' })
  })

  test('before 가 null 이거나 모듈이 없으면 명령이 없다', () => {
    assert.deepEqual(beforeCommand(['api'], null), { ok: true, command: null })
    assert.deepEqual(beforeCommand([], { '*': 'b' }), { ok: true, command: null })
  })
})

describe('queueOrder', () => {
  const item = (pr: number, minute: number, ...migrations: Migration[]): QueueItem => ({
    pr,
    readyAt: `2026-01-01T00:0${minute}:00Z`,
    migrations,
  })

  test('같은 모듈 PR 이 앉은 자리만 번호 순으로 바꾸고 묶는다', () => {
    const got = queueOrder([item(3, 1, mig('api', 'V14')), item(5, 2), item(4, 3, mig('api', 'V13'))])
    assert.deepEqual(got, { order: [4, 5, 3], chains: [[4, 3]] })
  })

  test('뒤 모듈의 재배치가 앞 모듈의 순서를 깨면 오름차순인 앞부분만 남긴다', () => {
    const got = queueOrder([item(1, 1, mig('api', 'V5'), mig('web', 'V2')), item(2, 2, mig('api', 'V6')), item(3, 3, mig('web', 'V1'))])
    assert.deepEqual(got, { order: [3, 2], chains: [] })
  })

  test('모듈 둘에 걸친 PR 은 두 묶음을 합친다', () => {
    const got = queueOrder([item(1, 1, mig('api', 'V5')), item(2, 2, mig('api', 'V6'), mig('web', 'V2')), item(3, 3, mig('web', 'V3')), item(4, 4)])
    assert.deepEqual(got, { order: [1, 2, 3, 4], chains: [[1, 2, 3]] })
  })

  test('준비 시각이 같으면 PR 번호 순이고 빈 목록은 빈 순서다', () => {
    assert.deepEqual(queueOrder([item(9, 1), item(7, 1)]), { order: [7, 9], chains: [] })
    assert.deepEqual(queueOrder([]), { order: [], chains: [] })
  })
})

describe('sweepArgs', () => {
  test('--run 다음 값을 큐의 Run 으로 바꾼다', () => {
    assert.deepEqual(sweepArgs(['--run', 'old', '--kill-holders'], 'run_x'), ['--run', 'run_x', '--kill-holders'])
  })

  test('--run 이 없으면 끝에 더한다', () => {
    assert.deepEqual(sweepArgs(['--kill-holders'], 'run_x'), ['--kill-holders', '--run', 'run_x'])
    assert.deepEqual(sweepArgs([], 'run_x'), ['--run', 'run_x'])
  })

  test('문자열 목록이 아니면 null 이다', () => {
    assert.equal(sweepArgs(undefined, 'run_x'), null)
    assert.equal(sweepArgs('--run x', 'run_x'), null)
    assert.equal(sweepArgs([1], 'run_x'), null)
  })
})

describe('judgeReview', () => {
  const receipt = (bot: string, commit: string): ReviewNote => ({ body: '', at: '2026-11-24T00:00:00Z', commit, receiptBot: bot })
  const config: ReviewConfig = { checks: ['claude-review'] }

  test('지금 HEAD 의 봇 영수증이 있으면 통과하고 근거를 낸다', () => {
    assert.deepEqual(judgeReview({ receipts: [receipt('codex', 'a'.repeat(40))], passedChecks: [] }, config),
      { ok: true, basis: ['봇 영수증 codex(커밋 aaaaaaaa, 2026-11-24T00:00:00Z)'] })
  })

  test('리뷰 체크가 success 면 통과한다. 설정에 없는 체크 이름은 세지 않는다', () => {
    assert.deepEqual(judgeReview({ receipts: [], passedChecks: ['claude-review'] }, config), { ok: true, basis: ['리뷰 체크 claude-review success'] })
    assert.deepEqual(judgeReview({ receipts: [], passedChecks: ['other'] }, config), { ok: false, wait: '리뷰 대기', missing: true })
  })

  test('영수증도 리뷰 체크 성공도 없으면 리뷰 대기이고 missing 이다. 리뷰 댓글 문구는 보지 않는다', () => {
    assert.deepEqual(judgeReview({ receipts: [], passedChecks: [] }, config), { ok: false, wait: '리뷰 대기', missing: true })
  })
})
