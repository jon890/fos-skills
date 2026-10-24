import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ConfigError, DEPRECATED_KEYS, HEAVY_KEYS, HOOKS_KEYS, loadConfig, PIPELINE_KEYS, QUEUE_KEYS, section } from '../scripts/lib/config.ts'
import type { Section } from '../scripts/lib/config.ts'

const OVERLAY = fileURLToPath(new URL('../references/overlay.md', import.meta.url))
const SECTIONS: readonly Section[] = ['finish', 'cleanup', 'queue', 'hooks', 'pipeline', 'heavy']
const saved = { ORCH_DIR: process.env.ORCH_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }

let tmp: string
let repo: string
let n = 0

// 테스트마다 다른 파일에 써서 서로 겹치지 않게 한다.
function file(body: string): string {
  n += 1
  const target = join(tmp, `config-${n}.json`)
  writeFileSync(target, body)
  return target
}

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-config-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  // repo 는 git 밖 폴더라 주 checkout 이 repo 자신이다. 임시 폴더 위에 git 저장소가 있어도 올라가 찾지 않게 막는다.
  process.env.GIT_CEILING_DIRECTORIES = tmp
  delete process.env.ORCH_DIR
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('loadConfig', () => {
  test('지금 절과 새 절을 읽는다', () => {
    const body = {
      finish: { run: 'run_1', specs_dir: 'specs' },
      cleanup: { queue_days: 2 },
      queue: { required: ['test'] },
      hooks: { timeouts: { 'before-merge': 900 } },
      pipeline: { enabled: true, ready_slots: 2 },
      heavy: { exclusive: ['docker build'] },
    }
    assert.deepEqual(loadConfig(repo, { file: file(JSON.stringify(body)) }), body)
  })

  test('file 을 주지 않으면 <orch 루트>/config.json 을 읽는다', () => {
    mkdirSync(join(repo, '.orch'), { recursive: true })
    writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ queue: { method: 'squash' } }))
    try {
      assert.deepEqual(loadConfig(repo), { queue: { method: 'squash' } })
    } finally {
      rmSync(join(repo, '.orch'), { recursive: true, force: true })
    }
  })

  test('파일이 없으면 빈 객체다', () => {
    assert.deepEqual(loadConfig(repo), {})
    assert.deepEqual(loadConfig(repo, { file: join(tmp, 'missing.json') }), {})
  })

  test('빈 객체 파일은 빈 객체다', () => {
    assert.deepEqual(loadConfig(repo, { file: file('{}') }), {})
  })

  test('깨진 JSON 은 ConfigError 다', () => {
    const target = file('{"finish": ')
    assert.throws(() => loadConfig(repo, { file: target }), (e: unknown) => e instanceof ConfigError && e.message.includes(target))
  })

  test('최상위가 객체가 아니면 ConfigError 다', () => {
    assert.throws(() => loadConfig(repo, { file: file('[]') }), ConfigError)
  })

  test('모르는 최상위 절은 ConfigError 다', () => {
    assert.throws(
      () => loadConfig(repo, { file: file(JSON.stringify({ queu: { method: 'squash' } })) }),
      (e: unknown) => e instanceof ConfigError && /모르는 절.*queu/.test(e.message),
    )
  })

  test('절이 객체가 아니면 ConfigError 다', () => {
    assert.throws(
      () => loadConfig(repo, { file: file(JSON.stringify({ finish: ['run'] })) }),
      (e: unknown) => e instanceof ConfigError && e.message.includes('"finish" 절은 객체여야 한다'),
    )
  })
})

describe('section', () => {
  test('아는 키만 있으면 그 절을 낸다', () => {
    const config = loadConfig(repo, { file: file(JSON.stringify({ cleanup: { trash: '/t', queue_days: 1 } })) })
    assert.deepEqual(section(config, 'cleanup', ['trash', 'queue_days', 'folder_days']), { trash: '/t', queue_days: 1 })
  })

  test('절이 없으면 빈 객체다', () => {
    assert.deepEqual(section({}, 'pipeline', ['enabled']), {})
  })

  test('hooks.timeouts 는 HOOKS_KEYS 로 통과한다', () => {
    const config = loadConfig(repo, { file: file(JSON.stringify({ hooks: { timeouts: { 'after-deploy': 60 } } })) })
    assert.deepEqual(section(config, 'hooks', HOOKS_KEYS), { timeouts: { 'after-deploy': 60 } })
  })

  test('pipeline 절은 PIPELINE_KEYS 로 enabled 와 authors 가 함께 통과하고 모르는 키(authorz)는 ConfigError 다', () => {
    const config = loadConfig(repo, { file: file(JSON.stringify({ pipeline: { enabled: true, authors: ['octo'] } })) })
    assert.deepEqual(section(config, 'pipeline', PIPELINE_KEYS), { enabled: true, authors: ['octo'] })
    const typo = loadConfig(repo, { file: file(JSON.stringify({ pipeline: { enabled: true, authorz: ['octo'] } })) })
    assert.throws(() => section(typo, 'pipeline', PIPELINE_KEYS), (e: unknown) => e instanceof ConfigError && /pipeline 절에 모르는 키가 있다: authorz$/.test(e.message))
  })

  test('heavy 절은 HEAVY_KEYS 로 네 키가 함께 통과하고 모르는 키(exclusiv)는 ConfigError 다', () => {
    const body = { exclusive: ['local-ci'], normal: ['scenario'], light: ['^git(\\s|$)'], wait_idle: ['image-build'] }
    const config = loadConfig(repo, { file: file(JSON.stringify({ heavy: body })) })
    assert.deepEqual(section(config, 'heavy', HEAVY_KEYS), body)
    const typo = loadConfig(repo, { file: file(JSON.stringify({ heavy: { exclusiv: ['local-ci'] } })) })
    assert.throws(() => section(typo, 'heavy', HEAVY_KEYS), (e: unknown) => e instanceof ConfigError && /heavy 절에 모르는 키가 있다: exclusiv$/.test(e.message))
  })

  test('모르는 키는 ConfigError 이고 그 키 이름을 알린다', () => {
    const config = loadConfig(repo, { file: file(JSON.stringify({ hooks: { timeout: {} }, finish: { run: 'r', bogus: 1 } })) })
    assert.throws(() => section(config, 'hooks', HOOKS_KEYS), (e: unknown) => e instanceof ConfigError && /hooks 절에 모르는 키.*timeout/.test(e.message))
    assert.throws(() => section(config, 'finish', ['run']), (e: unknown) => e instanceof ConfigError && /finish 절에 모르는 키가 있다: bogus$/.test(e.message))
  })
})

describe('DEPRECATED_KEYS', () => {
  test('항목마다 아는 절, 밑줄 키 이름, 핸들러 이벤트 이름을 갖는다', () => {
    assert.ok(DEPRECATED_KEYS.length > 0)
    for (const entry of DEPRECATED_KEYS) {
      assert.ok(SECTIONS.includes(entry.section), `모르는 절: ${entry.section}`)
      assert.match(entry.key, /^[a-z]+(?:_[a-z]+)*$/, `키 이름이 밑줄 꼴이 아니다: ${entry.key}`)
      assert.match(entry.event, /^[a-z]+(?:-[a-z]+)*$/, `이벤트 이름이 하이픈 꼴이 아니다: ${entry.event}`)
    }
  })
})

describe('QUEUE_KEYS', () => {
  test('overlay.md 「마무리 설정 파일」 표의 queue 행 둘째 열의 키 집합과 같다', () => {
    const text = readFileSync(OVERLAY, 'utf8')
    const start = text.indexOf('## 마무리 설정 파일')
    assert.ok(start >= 0, 'overlay.md 에 「마무리 설정 파일」 절이 없다')
    const body = text.slice(start + 1)
    const end = body.search(/^## /m)
    const documented = new Set<string>()
    for (const line of (end >= 0 ? body.slice(0, end) : body).split('\n')) {
      const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim())
      if (cells[1] !== '`queue`') continue
      for (const match of cells[2].matchAll(/`([a-z_]+)`/g)) documented.add(match[1])
    }
    assert.ok(documented.size > 0, 'queue 행을 찾지 못했다')
    assert.deepEqual([...QUEUE_KEYS].sort(), [...documented].sort())
  })

  test('queue 절은 QUEUE_KEYS 로 required, method, docs_glob 이 함께 통과하고 모르는 키(requird)는 ConfigError 다', () => {
    const config = loadConfig(repo, { file: file(JSON.stringify({ queue: { required: ['test'], method: 'squash', docs_glob: 'docs/**' } })) })
    assert.deepEqual(section(config, 'queue', QUEUE_KEYS), { required: ['test'], method: 'squash', docs_glob: 'docs/**' })
    const typo = loadConfig(repo, { file: file(JSON.stringify({ queue: { requird: 'test' } })) })
    assert.throws(() => section(typo, 'queue', QUEUE_KEYS), (e: unknown) => e instanceof ConfigError && /queue 절에 모르는 키가 있다: requird$/.test(e.message))
  })
})
