// 설정 키 검사표(core/config-schema.ts)의 키 목록, 키별 값 판정, 짝 규칙, 구조 문제, 경로 판정을 본다.
// 읽는 쪽과 어긋나지 않는지는 config-schema-readers.spec.ts 가 본다.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { ADR_KEYS, BOARD_KEYS, CLEANUP_KEYS, CONTRACTS_KEYS, DOCKER_KEYS, HEAVY_KEYS, HOOKS_KEYS, INBOX_KEYS, MIGRATIONS_KEYS, PIPELINE_KEYS, QUEUE_KEYS, REVIEW_KEYS, ROUTING_KEYS, SECTIONS } from '../scripts/core/config.ts'
import type { Section } from '../scripts/core/config.ts'
import { KEYS, PAIRS, RESTART_KEYS, TIMER_MAX_SEC, knownPath, problems } from '../scripts/core/config-schema.ts'
import type { Problem } from '../scripts/core/config-schema.ts'
import { FINISH_KEYS } from '../scripts/core/finish-options.ts'
import { SAMPLES } from './fixtures/config-samples.ts'

const READER_KEYS: Record<Section, readonly string[]> = {
  finish: FINISH_KEYS,
  cleanup: CLEANUP_KEYS,
  queue: QUEUE_KEYS,
  hooks: HOOKS_KEYS,
  pipeline: PIPELINE_KEYS,
  heavy: HEAVY_KEYS,
  migrations: MIGRATIONS_KEYS,
  adr: ADR_KEYS,
  contracts: CONTRACTS_KEYS,
  board: BOARD_KEYS,
  review: REVIEW_KEYS,
  docker: DOCKER_KEYS,
  routing: ROUTING_KEYS,
  inbox: INBOX_KEYS,
}

const under = (problem: Problem, section: string, key: string) => problem.path === `${section}.${key}` || problem.path.startsWith(`${section}.${key}.`) || problem.path.startsWith(`${section}.${key}[`)
const valueProblems = (section: string, key: string, value: unknown) =>
  problems({ [section]: { [key]: value } }).filter((problem) => under(problem, section, key) && (problem.kind === 'value' || problem.kind === 'unknown'))

describe('키 목록 대조', () => {
  test('검사표의 절은 SECTIONS 와 같다', () => {
    assert.deepEqual(Object.keys(KEYS).sort(), [...SECTIONS].sort())
  })

  for (const name of SECTIONS) {
    test(`${name} 절의 키가 지금 키 목록과 같다`, () => {
      assert.deepEqual(Object.keys(KEYS[name]).sort(), [...READER_KEYS[name]].sort())
    })
  }

  test('표본 표가 모든 키를 담고 모르는 키는 담지 않는다', () => {
    for (const name of SECTIONS) assert.deepEqual(Object.keys(SAMPLES[name] ?? {}).sort(), Object.keys(KEYS[name]).sort(), name)
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...SECTIONS].sort())
  })
})

describe('키별 표본', () => {
  for (const [section, keys] of Object.entries(SAMPLES)) {
    for (const [key, sample] of Object.entries(keys)) {
      test(`${section}.${key}`, () => {
        assert.ok(sample.good.length > 0 && sample.bad.length > 0)
        for (const value of sample.good) assert.deepEqual(valueProblems(section, key, value), [], `good ${JSON.stringify(value)}`)
        for (const value of sample.bad) {
          const found = valueProblems(section, key, value).filter((problem) => problem.kind === 'value')
          assert.ok(found.length >= 1, `bad ${JSON.stringify(value)} 가 거절되지 않았다`)
        }
      })
    }
  }

  test('경계 값: 타이머 상한, 0, 빈 목록', () => {
    assert.equal(TIMER_MAX_SEC, 2147483)
    assert.deepEqual(valueProblems('pipeline', 'tick_sec', 2147483), [])
    assert.equal(valueProblems('pipeline', 'tick_sec', 2147484).length, 1)
    assert.deepEqual(valueProblems('finish', 'worker_done_timeout', 0), [])
    assert.equal(valueProblems('finish', 'merge_timeout', 0).length, 1)
    assert.deepEqual(valueProblems('finish', 'run', null), [])
    assert.equal(valueProblems('finish', 'specs_dir', null).length, 1)
    assert.deepEqual(valueProblems('queue', 'required', 'A,,B'), [])
    assert.equal(valueProblems('inbox', 'enabled', 'false').length, 1)
  })

  test('모르는 리뷰 조건은 queue.auto_review.require 경로로 낸다', () => {
    const found = problems({ queue: { auto_review: { pass: 'a', block: 'b', require: ['thread-resolved'] } } })
    assert.equal(found.length, 1)
    assert.equal(found[0].path, 'queue.auto_review.require')
    assert.match(found[0].reason, /^모르는 조건이 있다: thread-resolved\. 쓸 수 있는 조건: verdict-on-head, /)
  })

  test('zod 가 낸 이유는 한국어이고 영어 기본 문구가 없다', () => {
    const found = problems({ pipeline: { tick_sec: -1, enabled: 'x' }, hooks: { timeouts: { tick: 'x' } }, queue: { poll_min_sec: 1.5 } })
    assert.ok(found.length >= 4)
    for (const problem of found) assert.doesNotMatch(problem.reason, /Invalid|Too small|expected/i, problem.reason)
    assert.ok(found.some((problem) => /너무 작습니다/.test(problem.reason)))
  })

  test('hooks.timeouts 의 모르는 이벤트 이름은 키마다 unknown 문제 하나다', () => {
    const found = problems({ hooks: { timeouts: { foo: 1, bar: 2, tick: 3 } } })
    assert.deepEqual(found.map((problem) => [problem.path, problem.kind]), [['hooks.timeouts.foo', 'unknown'], ['hooks.timeouts.bar', 'unknown']])
  })
})

describe('짝 규칙', () => {
  const rules: { name: string; section: Section; bad: Record<string, unknown>; good: Record<string, unknown>; path: string }[] = [
    { name: 'contracts 한쪽만', section: 'contracts', bad: { merge_command: 'make' }, good: { merge_command: 'make', paths: 'a' }, path: 'contracts.merge_command' },
    { name: 'finish 배포 한쪽만', section: 'finish', bad: { deploy_workflow: 'deploy.yml' }, good: { deploy_workflow: 'deploy.yml', deploy_branch: 'main' }, path: 'finish.deploy_workflow' },
    { name: 'finish complete 와 intermediate', section: 'finish', bad: { complete: true, intermediate: true }, good: { complete: true, intermediate: false }, path: 'finish.complete' },
    { name: 'queue overlap 과 require_up_to_date', section: 'queue', bad: { up_to_date_when: 'overlap' }, good: { up_to_date_when: 'overlap', require_up_to_date: true }, path: 'queue.up_to_date_when' },
    { name: 'queue shared_paths 는 overlap 일 때만', section: 'queue', bad: { shared_paths: '^a/' }, good: { shared_paths: '^a/', up_to_date_when: 'overlap', require_up_to_date: true }, path: 'queue.shared_paths' },
    { name: 'queue update_docs_on_overlap 에 docs_glob', section: 'queue', bad: { update_docs_on_overlap: true }, good: { update_docs_on_overlap: true, docs_glob: 'docs/**' }, path: 'queue.update_docs_on_overlap' },
    { name: 'queue poll_min_sec 가 poll_max_sec 이하', section: 'queue', bad: { poll_min_sec: 400 }, good: { poll_min_sec: 10, poll_max_sec: 20 }, path: 'queue.poll_min_sec' },
  ]
  test('일곱 규칙이 모두 PAIRS 에 있다', () => {
    assert.equal(Object.values(PAIRS).flat().length, 7)
    assert.equal(rules.length, 7)
  })
  for (const rule of rules) {
    test(rule.name, () => {
      const bad = problems({ [rule.section]: rule.bad })
      assert.deepEqual(bad.map((problem) => [problem.path, problem.kind]), [[rule.path, 'pair']], JSON.stringify(bad))
      assert.deepEqual(problems({ [rule.section]: rule.good }), [])
    })
  }

  test('같은 절의 오타 키나 다른 키의 틀린 값이 있어도 짝 규칙 문제가 나온다', () => {
    const found = problems({ queue: { poll_min_sec: 400, poll_max_sec: 300, poll_min_secs: 1, method: 'fast' } })
    assert.deepEqual(found.map((problem) => `${problem.kind} ${problem.path}`).sort(), ['pair queue.poll_min_sec', 'unknown queue.poll_min_secs', 'value queue.method'])
  })

  test('규칙의 키가 자기 검사에서 틀렸으면 그 규칙은 건너뛴다', () => {
    const found = problems({ queue: { poll_min_sec: 'x', poll_max_sec: 3 } })
    assert.deepEqual(found.map((problem) => `${problem.kind} ${problem.path}`), ['value queue.poll_min_sec'])
  })
})

describe('구조와 옛 칸', () => {
  test('최상위가 배열이면 config.json 문제 하나', () => {
    assert.deepEqual(problems([]), [{ path: 'config.json', reason: '최상위는 객체여야 한다', kind: 'structure' }])
  })

  test('모르는 절', () => {
    const found = problems({ queu: {} })
    assert.equal(found.length, 1)
    assert.equal(found[0].path, 'queu')
    assert.equal(found[0].kind, 'unknown')
    assert.match(found[0].reason, /^모르는 절이다\. finish, cleanup, .* 중 하나다$/)
  })

  test('객체가 아닌 절', () => {
    assert.deepEqual(problems({ queue: [] }), [{ path: 'queue', reason: '절은 객체여야 한다', kind: 'structure' }])
  })

  test('옛 칸은 removed 문제 하나이고 모르는 키로도 세지 않는다', () => {
    const found = problems({ queue: { before: 'x' } })
    assert.equal(found.length, 1)
    assert.deepEqual([found[0].path, found[0].kind], ['queue.before', 'removed'])
    assert.match(found[0].reason, /orch doctor migrate-hooks --apply/)
  })

  test('문제가 없는 설정과 빈 설정은 문제가 없다', () => {
    assert.deepEqual(problems({}), [])
    assert.deepEqual(problems({ queue: { method: 'squash' }, pipeline: { tick_sec: 60 } }), [])
  })

  test('모든 키와 규칙이 서로 독립으로 돈다', () => {
    const found = problems({ queue: { method: 'x', poll_min_sec: 0 }, pipeline: { tick_sec: 0 }, queu: {} })
    assert.deepEqual(found.map((problem) => problem.path).sort(), ['pipeline.tick_sec', 'queu', 'queue.method', 'queue.poll_min_sec'])
  })
})

describe('knownPath', () => {
  const cases: [string, 'known' | 'unknown' | 'removed'][] = [
    ['queue.auto_review.pass', 'known'],
    ['queue.auto_review.prass', 'unknown'],
    ['hooks.timeouts.after-queue', 'known'],
    ['hooks.timeouts.foo', 'unknown'],
    ['hooks.timeouts.__proto__', 'unknown'],
    ['queue.required.0', 'unknown'],
    ['migrations.dirs.anything', 'known'],
    ['queue.before', 'removed'],
    ['queu.x', 'unknown'],
    ['queue', 'known'],
    ['queue.method', 'known'],
    ['queue.method.x', 'unknown'],
    ['pipeline.stall_ticks.error', 'known'],
    ['pipeline.stall_ticks.other', 'unknown'],
    ['inbox.dooray.channel', 'known'],
    ['finish.complete_cmd', 'removed'],
    ['adr.dirs.core', 'known'],
    ['nothing', 'unknown'],
  ]
  for (const [path, expected] of cases) test(`${path} → ${expected}`, () => assert.equal(knownPath(path.split('.')), expected))
})

test('루프를 다시 띄워야 반영되는 키', () => {
  assert.deepEqual([...RESTART_KEYS], ['board.task', 'pipeline.tick_sec', 'finish.run', 'finish.specs_dir'])
})

test('config-schema.ts 를 가져오는 파일은 doctor 와 config 명령뿐이다(정적 import 와 동적 import 모두)', () => {
  const scripts = join(dirname(fileURLToPath(import.meta.url)), '../scripts')
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.ts$/.test(entry.name) ? [join(dir, entry.name)] : []))
  // from '…', import('…'), new URL('…', import.meta.url) 의 경로 문자열에 config-schema 가 든 파일
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bnew\s+URL\s*\(\s*)(['"`])[^'"`\n]*config-schema(?:\.ts)?\1/
  const importers = walk(scripts)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(scripts, file).split(sep).join('/'))
    .sort()
  // config/orch-config.ts 는 다음 PR 이 만든다
  assert.deepEqual(
    importers.filter((file) => file !== 'config/orch-config.ts'),
    ['doctor/orch-doctor.ts'],
  )
})
