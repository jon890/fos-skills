// lib/milestones.ts 의 단계 정의 읽기, 기본 단계, 설정 판정, 사건마다 끝낼 보드 명령을 본다. 설정 파일은 임시 폴더에 쓴다.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { ConfigError } from '../scripts/lib/config.ts'
import {
  advanceCommands,
  boardSettings,
  DEFAULT_STEPS,
  doneStep,
  mergedCommands,
  milestoneLines,
  parseSteps,
  specSteps,
  stagesOf,
  stagesText,
} from '../scripts/lib/milestones.ts'

const saved = { ORCH_DIR: process.env.ORCH_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }
let tmp = ''
let n = 0
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-milestones-')))
  // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
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

// config.json 을 둔 새 저장소 폴더
function repo(config: unknown): string {
  n += 1
  const dir = join(tmp, `repo-${n}`)
  mkdirSync(join(dir, '.orch'), { recursive: true })
  if (config !== undefined) writeFileSync(join(dir, '.orch', 'config.json'), JSON.stringify(config))
  return dir
}

const steps = (...rows: [number, boolean][]) => rows.map(([number, done]) => ({ number, done, text: `${number}. 단계` }))

describe('단계 정의', () => {
  test('꼬리표는 사건이 끝내는 단계, 꼬리표 없는 줄은 수동 단계다', () => {
    assert.deepEqual(parseSteps(['[pr] 구현과 PR', 'QA 확인', '[MERGE] 기준 브랜치 머지']), [
      { kind: 'pr', text: '구현과 PR' },
      { kind: null, text: 'QA 확인' },
      { kind: 'merge', text: '기준 브랜치 머지' },
    ])
  })

  test('모르는 꼬리표, 같은 꼬리표 둘, 빈 본문은 Error 다', () => {
    assert.throws(() => parseSteps(['[qa] 확인']), /꼬리표는/)
    assert.throws(() => parseSteps(['[pr] 하나', '[pr] 둘']), /\[pr\] 가 둘이다/)
    assert.throws(() => parseSteps(['[pr] ']), /본문이 비었다/)
  })

  test('지시서의 보드 단계 절은 번호 줄만 읽고 다음 절에서 멈춘다', () => {
    const text = '# 일\n\n## 보드 단계\n1. [pr] 구현\n   설명 줄\n2) [merge] 머지\n\n## 할 일\n1. 구현 세부\n'
    assert.deepEqual(specSteps(text), [
      { kind: 'pr', text: '구현' },
      { kind: 'merge', text: '머지' },
    ])
    assert.equal(specSteps('# 일\n\n## 할 일\n1. 구현\n'), null)
    assert.equal(specSteps('# 일\n\n## 보드 단계\n번호 없는 줄\n'), null)
  })

  test('기본 단계는 PR 과 머지 두 줄이다', () => {
    assert.deepEqual(DEFAULT_STEPS, [
      { kind: 'pr', text: 'PR' },
      { kind: 'merge', text: '머지' },
    ])
  })

  test('단계 줄과 stages 를 시작 번호부터 만들고 stages 칸을 읽는다', () => {
    const made = milestoneLines(parseSteps(['[pr] PR', '확인', '[release] 출시']), 4)
    assert.deepEqual(made.details, ['4. PR', '5. 확인', '6. 출시'])
    assert.equal(stagesText(made.stages), 'pr=4,release=6')
    assert.deepEqual(stagesOf({ stages: 'pr=4, release=6' }), { pr: 4, release: 6 })
    assert.equal(stagesOf({ stages: '' }), null)
    assert.equal(stagesOf({ stages: 'qa=1' }), null)
    assert.equal(stagesOf({}), null)
  })
})

describe('boardSettings', () => {
  test('설정이 없으면 단계도 done 지점도 배포도 없다', () => {
    assert.deepEqual(boardSettings(repo(undefined)), { steps: null, doneAfter: null, deploy: null, taskLine: null })
  })

  test('board 절과 finish 의 배포 설정을 읽는다', () => {
    const got = boardSettings(repo({ board: { steps: ['[pr] PR'], done_after: 'deploy' }, finish: { deploy_workflow: 'd.yml', deploy_branch: 'stage' } }))
    assert.deepEqual(got, { steps: [{ kind: 'pr', text: 'PR' }], doneAfter: 'deploy', deploy: { workflow: 'd.yml', branch: 'stage' }, taskLine: null })
  })

  test('board.task_line 을 m, u 플래그 정규식으로 읽는다', () => {
    const { taskLine } = boardSettings(repo({ board: { task_line: '^이슈: (?<number>#\\d+)' } }))
    assert.equal(taskLine?.flags, 'mu')
    assert.equal(taskLine?.exec('머리\n이슈: #12\n')?.groups?.number, '#12')
  })

  test('틀린 값과 모르는 키는 ConfigError 다', () => {
    for (const board of [{ steps: [] }, { steps: 'PR' }, { steps: ['[qa] x'] }, { done_after: 'pr' }, { done_after: 'later' }, { colour: 'red' }, { task_line: '' }, { task_line: '(' }, { task_line: '이슈: #\\d+' }]) {
      assert.throws(() => boardSettings(repo({ board })), ConfigError, JSON.stringify(board))
    }
  })
})

describe('사건마다 끝낼 단계', () => {
  const stages = { pr: 1, merge: 2, deploy: 3, release: 4 }

  test('done 지점은 done_after(기본 merge)의 단계이고 항목에 없으면 가장 늦은 사건 단계다', () => {
    assert.equal(doneStep(stages, null), 2)
    assert.equal(doneStep(stages, 'release'), 4)
    assert.equal(doneStep(stages, 'deploy'), 3)
    assert.equal(doneStep({ pr: 1, merge: 2 }, 'release'), 2)
    assert.equal(doneStep({ pr: 1, release: 3 }, null), 3)
    assert.equal(doneStep({}, null), null)
  })

  test('PR 이 열리면 pr 단계만 끝낸다', () => {
    const got = advanceCommands('a', steps([1, false], [2, false], [3, false], [4, false]), stages, 'pr', { last: false, doneAfter: null })
    assert.deepEqual(got, { cmds: [['step', 'a', '1']], done: false })
  })

  test('마지막 PR 의 배포는 앞 단계까지 끝내고 done 지점 전이면 doing 으로 둔다', () => {
    const got = advanceCommands('a', steps([1, true], [2, false], [3, false], [4, false]), stages, 'deploy', { last: true, doneAfter: 'release' })
    assert.deepEqual(got, { cmds: [['step', 'a', '2'], ['step', 'a', '3']], done: false })
  })

  test('마지막 PR 이 done 지점에 닿으면 그 번호까지의 수동 단계도 끝내고 done 으로 바꾼다', () => {
    const custom = { pr: 1, merge: 3 }
    const got = advanceCommands('a', steps([1, true], [2, false], [3, false], [4, false]), custom, 'merge', { last: true, doneAfter: null })
    assert.deepEqual(got, { cmds: [['step', 'a', '2'], ['step', 'a', '3'], ['set', 'a', 'done', '--worktree', '']], done: true })
  })

  test('중간 PR 은 deploy 까지만 끝내고 done 으로 가지 않는다', () => {
    const got = advanceCommands('a', steps([1, false], [2, false], [3, false], [4, false]), stages, 'release', { last: false, doneAfter: null })
    assert.deepEqual(got, { cmds: [['step', 'a', '1'], ['step', 'a', '2'], ['step', 'a', '3']], done: false })
  })

  test('중간 PR 의 머지는 남은 일 줄을 두고 pr 칸을 비우고 merged-pr 에 쌓는다', () => {
    const item = { id: 'a', details: [{ text: '1. 구현과 PR', done: false }, { text: '2. 머지', done: false }], 'merged-pr': 5 }
    const got = mergedCommands(item, steps([1, false], [2, false]), { pr: 1, merge: 2 }, '7', 'merge', { last: false, doneAfter: null, note: '남은 일: PR #8' })
    assert.deepEqual(got.cmds, [
      ['set', 'a', '--detail', '1. 구현과 PR', '--detail', '2. 머지', '--detail', '남은 일: PR #8'],
      ['step', 'a', '1'],
      ['step', 'a', '2'],
      ['set', 'a', '--pr', '', '--merged-pr', '5, 7'],
    ])
    assert.equal(got.done, false)
  })

  test('마지막 PR 의 머지는 남은 일 줄을 지우고 pr 칸을 두고 merged-pr 에도 적는다', () => {
    const item = { id: 'a', details: [{ text: '1. 구현과 PR', done: true }, { text: '2. 머지', done: false }, '남은 일: PR #7'] }
    const got = mergedCommands(item, steps([1, true], [2, false]), { pr: 1, merge: 2 }, '8', 'merge', { last: true, doneAfter: null, note: null })
    assert.deepEqual(got.cmds, [
      ['set', 'a', '--detail', '✓ 1. 구현과 PR', '--detail', '2. 머지'],
      ['step', 'a', '2'],
      ['set', 'a', 'done', '--worktree', ''],
      ['set', 'a', '--merged-pr', '8'],
    ])
    assert.equal(got.done, true)
  })
})
