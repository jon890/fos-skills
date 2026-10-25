// 옛 .py 경로를 같은 이름의 .ts 로 넘기는 shim(ts_shim.py)을 가짜 node 로 본다.

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url)).replace(/\/$/, '')
const SHIM = join(SCRIPTS, 'launch-worker.py')
const TARGET = join(SCRIPTS, 'launch-worker.ts')
const NO_NODE = 'node 24 이상이 PATH 에 필요하다'
const FLAG = '--disable-warning=ExperimentalWarning'

let bin: string
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'ts-shim-'))
})
afterEach(() => rmSync(bin, { recursive: true, force: true }))

// --version 에 version 을 내고, 그 밖에는 받은 인자를 한 줄씩 낸 뒤 7 로 끝나는 가짜 node 를 bin 에 둔다.
function fakeNode(version: string): void {
  const node = join(bin, 'node')
  writeFileSync(
    node,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nfor a in "$@"; do printf "%s\\n" "$a"; done\nexit 7\n`,
  )
  chmodSync(node, 0o755)
}

function withFakeNode(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
}

// python3 은 PATH 를 바꾸기 전에 절대경로로 찾는다.
function py(args: string[], env: NodeJS.ProcessEnv) {
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
  return spawnSync(python, args, { encoding: 'utf8', env })
}

function nodeTooOld(text: string): boolean {
  const done = py(
    ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import ts_shim; print(ts_shim.node_too_old(sys.argv[2]))', SCRIPTS, text],
    process.env,
  )
  assert.equal(done.status, 0, done.stderr)
  return done.stdout.trim() === 'True'
}

describe('node_too_old', () => {
  test('24.0 부터는 통과한다', () => {
    for (const text of ['v24.0.0', 'v26.1.0', 'v24.0.0\n']) assert.equal(nodeTooOld(text), false, text)
  })

  test('낮거나 읽지 못하는 버전은 낮음이다', () => {
    for (const text of ['v23.11.1', 'v22.23.4', 'garbage', '']) assert.equal(nodeTooOld(text), true, JSON.stringify(text))
  })
})

describe('exec', () => {
  test('낮은 node 는 exec 전에 NODE-TOO-OLD 로 127 이다', () => {
    fakeNode('v22.23.4')
    const done = py([SHIM, '--help'], withFakeNode())
    assert.equal(done.status, 127, done.stdout + done.stderr)
    assert.ok(done.stdout.startsWith('NODE-TOO-OLD v22.23.4'), done.stdout)
    assert.ok(!done.stdout.includes('--help'), done.stdout)
  })

  test('새 node 는 .ts 파일과 인자를 받고 종료 코드는 node 의 것이다', () => {
    fakeNode('v24.0.0')
    const done = py([SHIM, '--help'], withFakeNode())
    assert.equal(done.status, 7, done.stderr)
    assert.deepEqual(done.stdout.split('\n').filter(Boolean), [FLAG, TARGET, '--help'])
    assert.ok(done.stderr.includes(`DEPRECATED python3 launch-worker.py → node ${FLAG} ${TARGET}`), done.stderr)
  })

  test('doctor 진입점은 낮은 node 를 막고 DEPRECATED 줄을 내지 않는다', () => {
    fakeNode('v22.23.4')
    const done = py([join(SCRIPTS, 'orch-doctor.py'), '--skip-version', '--skip-questions'], withFakeNode())
    assert.equal(done.status, 127, done.stdout + done.stderr)
    assert.ok(done.stdout.startsWith('NODE-TOO-OLD v22.23.4'), done.stdout)
    assert.ok(!done.stderr.includes('DEPRECATED'), done.stderr)
  })

  test('worker-ask 진입점은 DEPRECATED 줄을 내지 않는다', () => {
    // worker 는 답의 첫 줄 answer: 를 읽는다. stderr 를 합쳐 읽어도 그 앞에 DEPRECATED 줄이 끼지 않아야 한다
    fakeNode('v24.0.0')
    const done = py([join(SCRIPTS, 'worker-ask.py'), '--help'], withFakeNode())
    assert.equal(done.status, 7, done.stderr)
    assert.deepEqual(done.stdout.split('\n').filter(Boolean), [FLAG, join(SCRIPTS, 'worker-ask.ts'), '--help'])
    assert.ok(!done.stderr.includes('DEPRECATED'), done.stderr)
  })

  test('exec 가 권한 오류로 실패해도 예외 없이 127 이다', () => {
    const script = [
      'import io, subprocess, sys',
      'from unittest import mock',
      'sys.path.insert(0, sys.argv[1])',
      'import ts_shim',
      'version = subprocess.CompletedProcess(["node", "--version"], 0, stdout="v24.0.0\\n", stderr="")',
      'with mock.patch.object(ts_shim.subprocess, "run", return_value=version), \\',
      '        mock.patch.object(ts_shim.os, "execvp", side_effect=PermissionError(13, "Permission denied")):',
      '    ts_shim.exec_ts(sys.argv[2], deprecated=False)',
    ].join('\n')
    const done = py(['-c', script, SCRIPTS, SHIM], process.env)
    assert.equal(done.status, 127, done.stdout + done.stderr)
    assert.ok(done.stderr.includes(NO_NODE), done.stderr)
  })

  test('node 가 PATH 에 없으면 127 이다', () => {
    const done = py([SHIM], { ...process.env, PATH: bin })
    assert.equal(done.status, 127, done.stdout + done.stderr)
    assert.ok(done.stderr.includes(NO_NODE), done.stderr)
  })

  test('shim 을 import 만 해서는 node 로 넘기지 않는다', () => {
    fakeNode('v24.0.0')
    const script = [
      'import importlib.util, sys',
      'sys.path.insert(0, sys.argv[2])',
      'import ts_shim',
      'spec = importlib.util.spec_from_file_location("launch_worker_shim", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'assert module.ts_shim is ts_shim',
      'print("IMPORTED")',
    ].join('\n')
    const done = py(['-c', script, SHIM, SCRIPTS], withFakeNode())
    assert.equal(done.status, 0, done.stdout + done.stderr)
    assert.equal(done.stdout.trim(), 'IMPORTED')
  })
})
