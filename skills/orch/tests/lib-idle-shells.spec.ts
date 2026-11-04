// lib/idle-shells.ts 의 idleShellVerdict 와 loginShell 을 순수 입력으로 본다. Orca, ps 는 부르지 않는다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { idleShellVerdict, loginShell } from '../scripts/lib/idle-shells.ts'
import type { Holder, ShellTerminal } from '../scripts/lib/idle-shells.ts'

const PATH = '/w/repo/worktrees/feat'
const shell = (handle: string, extra: ShellTerminal = {}): ShellTerminal => ({ handle, worktreePath: PATH, title: 'Terminal 1', ...extra })
const zsh = (pid: string, hasChildren = false): Holder => ({ pid, command: '-zsh', hasChildren })

describe('loginShell', () => {
  test('argv[0] 이 - 로 시작하는 셸만 로그인 셸이다', () => {
    assert.equal(loginShell('-zsh'), true)
    assert.equal(loginShell('-/bin/zsh'), true)
    assert.equal(loginShell('  -bash --foo'), true)
    assert.equal(loginShell('zsh'), false)
    assert.equal(loginShell('-node'), false)
    assert.equal(loginShell('node server.js'), false)
  })
})

describe('idleShellVerdict', () => {
  test('자식 없는 로그인 셸만 쥐었으면 그 경로의 터미널을 모두 닫는다', () => {
    const terminals = [shell('t1'), shell('t2'), { handle: 'other', worktreePath: '/w/elsewhere' }]
    assert.deepEqual(idleShellVerdict({ path: PATH, terminals, holders: [zsh('1'), zsh('2')] }), { close: ['t1', 't2'] })
  })

  // 머리 주석의 판정 순서대로 남길 이유를 낸다
  const keeps: { name: string; terminals: ShellTerminal[]; holders: Holder[]; claimed?: Set<unknown>; want: string }[] = [
    { name: '그 경로의 터미널이 없다', terminals: [{ handle: 'x', worktreePath: '/w/elsewhere' }], holders: [zsh('1')], want: '그 경로에 Orca 터미널이 없다' },
    { name: '에이전트 터미널이 있다', terminals: [shell('t1', { agentIdentity: { agent: 'claude' } })], holders: [zsh('1')], want: '에이전트 터미널 t1' },
    { name: '살아 있는 worker 터미널이다', terminals: [shell('t1')], holders: [zsh('1')], claimed: new Set(['t1']), want: 'worker 터미널 t1' },
    { name: '쥔 프로세스가 없다', terminals: [shell('t1')], holders: [], want: '그 경로를 쓰는 프로세스가 없다' },
    { name: '자식이 있는 셸', terminals: [shell('t1')], holders: [zsh('1', true)], want: '자식이 있는 셸 1' },
    { name: '셸이 아닌 프로세스', terminals: [shell('t1')], holders: [{ pid: '9', command: '/usr/bin/node server.js', hasChildren: false }], want: '셸이 아닌 프로세스 9 node' },
    { name: '셸 수가 터미널 수보다 적다', terminals: [shell('t1'), shell('t2')], holders: [zsh('1')], want: '셸 수가 터미널 수보다 적다(작업 폴더를 옮긴 터미널이 있다)' },
  ]
  for (const item of keeps) {
    test(`남긴다: ${item.name}`, () => {
      assert.deepEqual(idleShellVerdict({ path: PATH, terminals: item.terminals, holders: item.holders, claimed: item.claimed }), { keep: item.want })
    })
  }

  test('에이전트 판정이 worker 판정보다 먼저다', () => {
    const verdict = idleShellVerdict({ path: PATH, terminals: [shell('t1', { agentIdentity: 'codex' })], holders: [zsh('1')], claimed: new Set(['t1']) })
    assert.deepEqual(verdict, { keep: '에이전트 터미널 t1' })
  })
})
