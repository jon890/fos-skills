// 명령 표(lib/commands.ts)가 새 꼴과 옛 꼴을 같은 스크립트와 인자로 푸는지 본다. 스크립트를 실행하지 않는다.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMMANDS, GROUPS, form, isGroup, orchWord, resolveLegacy, resolveNew, scriptPath, type Command } from '../scripts/lib/commands.ts'

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))

function argvOf(c: Command, extra: string[] = []): string[] {
  return [c.group, ...(c.verb ? c.verb.split(' ') : []), ...extra]
}

function ok(argv: string[]): { command: Command; args: string[] } {
  const r = resolveNew(argv)
  assert.ok(!('error' in r), `${argv.join(' ')}: ${'error' in r ? r.error : ''}`)
  return r as { command: Command; args: string[] }
}

function fails(argv: string[]): string {
  const r = resolveNew(argv)
  assert.ok('error' in r, `${argv.join(' ')} 는 거부해야 한다`)
  return (r as { error: string }).error
}

describe('표의 행', () => {
  test('모든 행의 스크립트가 있다', () => {
    for (const c of COMMANDS) {
      assert.ok(existsSync(join(SCRIPTS, c.script)), `${form(c)} → ${c.script}`)
    }
  })

  test('묶음 이름은 옛 스크립트 이름과 겹치지 않는다', () => {
    const scripts = readdirSync(SCRIPTS).filter((f) => /\.(ts|py)$/.test(f)).map((f) => f.replace(/\.(ts|py)$/, ''))
    for (const g of GROUPS) assert.ok(!scripts.includes(g), g)
  })

  test('새 꼴은 한 행으로만 풀린다', () => {
    const forms = COMMANDS.map(form)
    assert.equal(new Set(forms).size, forms.length)
    for (const c of COMMANDS) assert.equal(ok(argvOf(c)).command, c, form(c))
  })

  test('옛 이름과 모드 플래그가 같은 행을 가리키고 같은 인자로 돈다', () => {
    for (const c of COMMANDS) {
      if (!c.legacy) continue
      const positional = c.positional ? ['value-1'] : []
      const { args } = ok(argvOf(c, [...positional, '--x', 'y']))
      // 옛 꼴은 같은 인자를 그대로 받는다. 새 꼴이 만든 인자로 옛 꼴을 부르면 같은 행의 안내가 나와야 한다
      const legacy = resolveLegacy(c.legacy.name, args)
      assert.ok(legacy, form(c))
      assert.equal(legacy.command, c, `${c.legacy.name} ${args.join(' ')} → ${legacy.hint}`)
      assert.equal(legacy.hint, form(c))
    }
  })

  test('옛 이름은 .ts 를 붙여도 같고, 표에 없는 이름은 안내가 없다', () => {
    assert.equal(resolveLegacy('wait-important.ts', ['--run', 'r'])?.hint, 'orch wait')
    assert.equal(resolveLegacy('orch-loop', ['--start', '--repo', 'x'])?.hint, 'orch loop start')
    assert.equal(resolveLegacy('orch-loop', ['--tick']), null)
    assert.equal(resolveLegacy('ts_shim', []), null)
  })

  test('isGroup 은 묶음만 참이다', () => {
    assert.ok(isGroup('wait'))
    assert.ok(!isGroup('wait-important'))
    assert.ok(!isGroup(undefined))
  })
})

describe('인자 바꾸기', () => {
  test('동작이 모드 플래그와 위치 인자로 바뀐다', () => {
    assert.deepEqual(ok(['loop', 'start']).args, ['--start'])
    assert.deepEqual(ok(['loop', 'run', '--once']).args, ['--foreground', '--once'])
    assert.deepEqual(ok(['wait', 'ack-lost', 'd1', 'd2', '--run', 'R']).args, ['--ack-lost', 'd1', '--ack-lost', 'd2', '--run', 'R'])
    assert.deepEqual(ok(['worker', 'screen', 't1']).args, ['--state', '--terminal', 't1'])
    assert.deepEqual(ok(['worker', 'check', 'w', '--spec', 's']).args, ['--check', 'w', '--spec', 's'])
    assert.deepEqual(ok(['worker', 'worktree', '/r', '--name', 'n']).args, ['--repo', '/r', '--name', 'n'])
    assert.deepEqual(ok(['queue', 'reserve', 'prune']).args, ['--prune'])
    assert.deepEqual(ok(['queue', 'reserve', '--module', 'm']).args, ['--module', 'm'])
    assert.deepEqual(ok(['study', 'add', '--slug', 's']).args, ['add', '--slug', 's'])
    assert.deepEqual(ok(['paths', 'specs']).args, ['specs'])
    assert.deepEqual(ok(['wait', '--ack', 'd1']).args, ['--ack', 'd1'])
    assert.deepEqual(ok(['slot', 'heavy', '--', 'make', '--x']).args, ['--', 'make', '--x'])
  })

  test('`--` 뒤는 위치 인자로 바꾸지 않는다', () => {
    assert.deepEqual(ok(['wait', 'ack-lost', '--', 'x']).args, ['--', 'x'])
  })
})

describe('금지 플래그', () => {
  test('동작으로 바뀐 옛 모드 플래그는 새 꼴에서 받지 않는다', () => {
    for (const argv of [['loop', '--start'], ['loop', 'status', '--stop'], ['loop', 'start', '--tick'], ['worker', 'nudge', '--state'], ['wait', '--ack-lost', 'd'], ['doctor', 'migrate', '--hooks'], ['queue', 'reserve', '--prune']]) {
      assert.match(fails(argv), /받지 않는다|동작/, argv.join(' '))
    }
  })

  test('줄여 쓴 금지 플래그도 거부하고, 옵션과 같은 이름은 통과한다', () => {
    fails(['wait', '--ack-l', 'd'])
    fails(['worker', 'nudge', '--sta'])
    ok(['wait', '--ack', 'd1'])
    ok(['wait', '--ack=d1'])
    ok(['wait', 'ack-lost', 'd1'])
    ok(['worker', 'screen', 't1'])
    ok(['worker', 'check', 'w', '--spec', 's'])
    ok(['queue', 'reserve', 'prune'])
  })

  test('`--` 뒤의 금지 플래그는 다른 명령의 것이라 보지 않는다', () => {
    ok(['slot', 'heavy', '--', 'x', '--start'])
  })

  test('모르는 동작과 동작 없는 묶음은 쓸 수 있는 동작을 알린다', () => {
    assert.match(fails(['loop']), /쓸 수 있는 동작: .*start/)
    assert.match(fails(['loop', 'nope']), /모르는 동작이다: nope/)
  })
})

test('scriptPath 는 옛 이름과 파일 이름을 그 폴더의 경로로 푼다', () => {
  assert.equal(scriptPath(SCRIPTS, 'wait-important'), join(SCRIPTS, 'wait-important.ts'))
  assert.equal(scriptPath(SCRIPTS, 'wait-important.ts'), join(SCRIPTS, 'wait-important.ts'))
  assert.equal(scriptPath(SCRIPTS, 'nope'), null)
})

test('orchWord 는 PATH 의 첫 orch 가 표지 있는 실행기면 orch, 아니면 진입점 경로다', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'orch-word-'))
  try {
    const entry = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))
    const marked = join(tmp, 'marked')
    const other = join(tmp, 'other')
    for (const [dir, body] of [[marked, '#!/usr/bin/env node\n// fos-skills orch launcher\n'], [other, '#!/bin/sh\n']]) {
      mkdirSync(dir)
      writeFileSync(join(dir, 'orch'), body)
      chmodSync(join(dir, 'orch'), 0o755)
    }
    assert.equal(orchWord([marked, '/usr/bin'].join(delimiter)), 'orch')
    // 앞에 다른 orch 가 있으면 그것이 불리므로 실행기가 아니다
    assert.equal(orchWord([other, marked].join(delimiter)), entry)
    assert.equal(orchWord([join(tmp, 'none'), '/usr/bin'].join(delimiter)), entry)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
