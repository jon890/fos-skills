// 설정 키 검사표(core/config-schema.ts)가 받는 값(good 표본)을 그 키를 읽는 코드도 받는지 본다.
// 기준: 「그 키를 읽는 모든 곳이 오류 없이 뜻대로 쓰는 값」(docs/features/orch-config-cli/design.md 「키별 검사 기준」).
// 한 방향만 본다. 읽는 쪽이 받는데 검사표가 거절하는 값(0 이하의 대기 시간, 타이머 상한 초과)은 설계가 일부러 막은 것이다.
// 어긋나면 읽는 코드가 아니라 검사표를 좁힌다(스펙 DECISION11).
//
// 읽는 곳
//   queue 키        lib/queue-defaults.ts 의 queueDefaults 와 queue/steps/options.ts 의 parseArgs(검증 포함), lib/gh.ts 의 requiredNames
//   queue·pipeline  core/refresh.ts 의 refreshSettings(refresh_slots 를 1 로 두고 부른다)
//   pipeline 시간   loop/steps/context.ts 의 context, lib/movement.ts 의 movementSettings
//   ready_slots     queue/ci-ready.ts 를 가짜 gh 로 돌린다(readySlots 는 내보내지 않는다)
//   finish 시간 키  queue/finish-pr.ts 를 가짜 gh(PR 이 닫힘)로 돌린다(parse 는 내보내지 않는다). 설정 오류·사용법 오류(종료 코드 2)가 없어야 한다

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { refreshSettings } from '../scripts/core/refresh.ts'
import { loadConfig } from '../scripts/lib/config.ts'
import type { Config } from '../scripts/lib/config.ts'
import { requiredNames } from '../scripts/lib/gh.ts'
import { movementSettings } from '../scripts/lib/movement.ts'
import { queueDefaults } from '../scripts/lib/queue-defaults.ts'
import { context } from '../scripts/loop/steps/context.ts'
import { parseArgs } from '../scripts/queue/steps/options.ts'
import { SAMPLES } from './fixtures/config-samples.ts'

const FINISH_PR = fileURLToPath(new URL('../scripts/queue/finish-pr.ts', import.meta.url))
const CI_READY = fileURLToPath(new URL('../scripts/queue/ci-ready.ts', import.meta.url))

// PR 이 닫혔다고 답하는 가짜 gh. 설정을 읽고 나면 FINISH-FAIL(종료 코드 1)로 바로 끝난다. 다른 호출은 실패한다
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ state: 'CLOSED' }) + '\\n')
  process.exit(0)
}
process.exit(1)
`

const saved = { ORCH_DIR: process.env.ORCH_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }
let tmp: string
let n = 0

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'config-readers-')))
  // 임시 저장소는 git 밖 폴더라 주 checkout 이 그 폴더 자신이다. 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
  process.env.GIT_CEILING_DIRECTORIES = tmp
  delete process.env.ORCH_DIR
  writeFileSync(join(tmp, 'gh'), FAKE_GH)
  chmodSync(join(tmp, 'gh'), 0o755)
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

function repoWith(config: Config, gitRepo = false): string {
  n += 1
  const repo = join(tmp, `repo-${n}`)
  mkdirSync(join(repo, '.orch'), { recursive: true })
  // finish-pr 는 --repo 가 git 작업 트리여야 한다
  if (gitRepo) assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).status, 0)
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify(config))
  return repo
}

// 읽는 곳이 거절하면 키, 값, 읽는 곳을 메시지에 담아 실패로 만든다
function accepts(reader: string, key: string, value: unknown, run: () => unknown): void {
  try {
    run()
  } catch (e) {
    assert.fail(`${key} = ${JSON.stringify(value)} 를 ${reader} 가 거절했다: ${(e as Error).message}`)
  }
}

function good(section: string, key: string): unknown[] {
  return SAMPLES[section][key].good
}

// 이 키의 good 값이 설정에서 따로 설 수 있게 짝 규칙을 채운 queue 절
function queueBody(key: string, value: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { [key]: value }
  if (key === 'up_to_date_when' || key === 'shared_paths' || key === 'unit_groups') {
    body.up_to_date_when = 'overlap'
    body.require_up_to_date = true
  }
  if (key === 'update_docs_on_overlap') body.docs_glob = 'docs/**'
  if (key === 'poll_min_sec') body.poll_max_sec = 2147483
  if (key === 'poll_max_sec') body.poll_min_sec = 1
  return body
}

const QUEUE_READ_BY_COMMAND = Object.keys(SAMPLES.queue).filter((key) => key !== 'auto_merge' && key !== 'auto_review')

describe('queue 키: 머지 큐 옵션과 사용법 검사', () => {
  for (const key of QUEUE_READ_BY_COMMAND) {
    test(`queue.${key}`, () => {
      for (const value of good('queue', key)) {
        const config = { queue: queueBody(key, value) } as Config
        accepts('queueDefaults 와 머지 큐 옵션 검사(parseArgs)', `queue.${key}`, value, () => parseArgs([...queueDefaults('config.json', [], config), '77']))
      }
    })
  }

  test('queue.required 는 필수 체크 이름 판정(requiredNames)도 받는다', () => {
    for (const value of good('queue', 'required')) {
      const repo = repoWith({ queue: { required: value } } as Config)
      accepts('requiredNames', 'queue.required', value, () => {
        const found = requiredNames(repo, 'github.com', 'owner/repo', 'main')
        assert.equal(found.ok, true)
      })
    }
  })
})

describe('최신화 설정(refreshSettings)', () => {
  for (const key of ['docs_glob', 'shared_paths', 'unit_groups', 'sweep_args', 'up_to_date_when', 'unit_prefix', 'require_up_to_date']) {
    test(`queue.${key}`, () => {
      for (const value of good('queue', key)) {
        const config = { queue: queueBody(key, value), pipeline: { refresh_slots: 1 } } as Config
        accepts('refreshSettings', `queue.${key}`, value, () => refreshSettings(config))
      }
    })
  }

  test('pipeline.refresh_slots 와 refresh_worker_paths', () => {
    for (const value of good('pipeline', 'refresh_slots')) accepts('refreshSettings', 'pipeline.refresh_slots', value, () => refreshSettings({ pipeline: { refresh_slots: value } } as Config))
    for (const value of good('pipeline', 'refresh_worker_paths')) {
      accepts('refreshSettings', 'pipeline.refresh_worker_paths', value, () => refreshSettings({ pipeline: { refresh_slots: 1, refresh_worker_paths: value } } as Config))
    }
  })
})

describe('pipeline 키: 루프 설정(context)과 움직임 설정', () => {
  for (const key of ['tick_sec', 'digest_sec', 'stall_ticks']) {
    test(`pipeline.${key}`, () => {
      for (const value of good('pipeline', key)) {
        const repo = repoWith({ pipeline: { [key]: value } } as Config)
        accepts('context', `pipeline.${key}`, value, () => context(repo, undefined, undefined))
      }
    })
  }

  for (const key of ['idle_min', 'idle_exited']) {
    test(`pipeline.${key}`, () => {
      for (const value of good('pipeline', key)) {
        const repo = repoWith({ pipeline: { [key]: value } } as Config)
        accepts('movementSettings', `pipeline.${key}`, value, () => movementSettings(repo))
      }
    })
  }
})

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH: join(tmp, 'gh'), GIT_CEILING_DIRECTORIES: tmp, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
  delete env.ORCH_DIR
  delete env.GH_HOST
  return env
}

function runScript(script: string, args: string[]) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env: childEnv(), encoding: 'utf8', timeout: 60_000 })
  return { code: done.status, out: done.stdout, err: done.stderr, both: `종료 코드 ${done.status}\n--- stdout\n${done.stdout}\n--- stderr\n${done.stderr}` }
}

describe('ci-ready 의 pipeline.ready_slots', () => {
  test('good 값은 설정 오류 없이 지나간다(그 뒤 조회는 가짜 gh 에서 실패한다)', () => {
    for (const value of good('pipeline', 'ready_slots')) {
      const repo = repoWith({ pipeline: { ready_slots: value } } as Config)
      const done = runScript(CI_READY, ['--repo', repo, '--dry-run', '1'])
      assert.doesNotMatch(done.err, /ready_slots/, `pipeline.ready_slots = ${JSON.stringify(value)} 를 ci-ready 가 거절했다\n${done.both}`)
    }
  })

  test('대조군: 0 은 ci-ready 가 설정 오류(종료 코드 2)로 거절한다', () => {
    const repo = repoWith({ pipeline: { ready_slots: 0 } } as Config)
    const done = runScript(CI_READY, ['--repo', repo, '--dry-run', '1'])
    assert.equal(done.code, 2, done.both)
    assert.match(done.err, /pipeline\.ready_slots/)
  })
})

describe('finish-pr 의 시간 키', () => {
  const keys = ['merge_timeout', 'deploy_timeout', 'poll_interval', 'worker_done_timeout']
  for (const key of keys) {
    test(`finish.${key}`, () => {
      for (const value of good('finish', key)) {
        const repo = repoWith({ finish: { [key]: value } } as Config, true)
        const done = runScript(FINISH_PR, ['77', '--repo', repo])
        assert.equal(done.code, 1, `finish.${key} = ${JSON.stringify(value)} 를 finish-pr 가 거절했다(설정 오류·사용법 오류)\n${done.both}`)
        assert.match(done.out, /FINISH-FAIL/, done.both)
      }
    })
  }

  test('글자 "30" 인 finish.merge_timeout 으로도 마무리 명령이 설정 오류·사용법 오류 없이 지금처럼 돈다', () => {
    const repo = repoWith({ finish: { merge_timeout: '30' } } as Config, true)
    const done = runScript(FINISH_PR, ['77', '--repo', repo])
    assert.equal(done.code, 1, done.both)
    assert.match(done.out, /^FINISH-FAIL/m, done.both)
    assert.match(done.out + done.err, /머지 없이 닫혔다/)
  })

  test('대조군: 수가 아닌 글자는 사용법 오류(종료 코드 2)다', () => {
    const repo = repoWith({ finish: { merge_timeout: 'abc' } } as Config, true)
    const done = runScript(FINISH_PR, ['77', '--repo', repo])
    assert.equal(done.code, 2, done.both)
    assert.match(done.err, /--merge-timeout 은 수다/)
  })
})

test('임시 저장소의 설정 파일을 읽는 길이 맞다', () => {
  assert.deepEqual(loadConfig(repoWith({ queue: { method: 'squash' } } as Config)), { queue: { method: 'squash' } })
})
