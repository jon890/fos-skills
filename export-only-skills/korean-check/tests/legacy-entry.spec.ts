// 옛 이름 진입 korean-style-check.py, check-readability.py 의 경계 테스트(스펙 REQ6, DECISION3, DECISION18).
// 사용자 훅이 ~/.claude/scripts/ 의 링크로 이 둘을 --hook 으로 부른다. 새 명령과 같은 결과를 내고 훅 모드는 새 명령을 알린다.
// 일반 모드는 stdout 과 종료 코드가 새 명령과 같다. 훅 모드는 발견이 있을 때 additionalContext 맨 앞에 안내 한 줄이 붙고, 발견이 없으면 출력이 없다.
// Node 가 낮으면 훅은 건너뛰었다는 안내를 내고 0, 일반 모드는 stderr 와 127 이다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SCRIPTS_DIR, cleanEnv, run, tempDir, write } from './helpers.ts'

const NAMES = ['korean-style-check', 'check-readability'] as const
const entry = (name: string) => join(SCRIPTS_DIR, `${name}.py`)
const target = (name: string) => realpathSync(join(SCRIPTS_DIR, `${name}.ts`))
const notice = (name: string) => `이 훅 경로는 다음 major 에 없어진다. 새 명령: node ${target(name)} --hook`
const hookInput = (file_path: string) => JSON.stringify({ tool_input: { file_path } })

// process.versions.node 를 낮춘 것처럼 보이게 하는 --require 모듈. 단순 대입은 무시되어 defineProperty 로 덮는다
function lowNodeShim(version: string): string {
  return write(join(tempDir(), 'low-node.cjs'), `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} })\n`)
}

for (const name of NAMES) {
  describe(`${name}.py`, () => {
    const direct = (args: string[], input?: string) => run([process.execPath, target(name)], { args, input })
    const legacy = (args: string[], input?: string, command = [entry(name)]) => run(command, { args, input })
    const bad = () => write(join(tempDir(), 'a.md'), name === 'korean-style-check' ? '# 장애를 트리아지한다\n' : '고쳤다 — 빠졌다.\n')
    const good = () => write(join(tempDir(), 'b.md'), '문제가 없는 문장이다.\n')

    test('node shebang 이고 실행 권한이 있다', () => {
      assert.equal(readFileSync(entry(name), 'utf8').split('\n')[0], '#!/usr/bin/env node')
      accessSync(entry(name), constants.X_OK)
    })

    test('일반 모드의 stdout 과 종료 코드가 새 명령과 같다', () => {
      for (const path of [bad(), good()]) {
        const a = legacy([path])
        const b = direct([path])
        assert.deepEqual([a.code, a.stdout, a.stderr], [b.code, b.stdout, b.stderr])
      }
      const usage = [legacy([]), direct([])]
      assert.deepEqual(usage.map((r) => r.code), [2, 2])
      const missing = join(tempDir(), '없다.md')
      assert.deepEqual([legacy([missing]).code, legacy([missing]).stderr], [direct([missing]).code, direct([missing]).stderr])
    })

    test('훅 모드는 발견이 있을 때 안내 한 줄을 additionalContext 맨 앞에 붙인다', () => {
      const path = bad()
      const a = legacy(['--hook'], hookInput(path))
      const b = direct(['--hook'], hookInput(path))
      assert.equal(a.code, 0)
      const fresh = JSON.parse(b.stdout).hookSpecificOutput.additionalContext as string
      assert.equal(a.stdout, `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": ${JSON.stringify(`${notice(name)}\n${fresh}`)}}}\n`)
    })

    test('훅 모드는 발견이 없으면 출력이 없다', () => {
      const a = legacy(['--hook'], hookInput(good()))
      assert.deepEqual([a.code, a.stdout, a.stderr], [0, '', ''])
    })

    test('훅 모드는 깨진 입력에도 0 이고 출력이 없다', () => {
      for (const input of ['', '{', '{}']) assert.deepEqual([legacy(['--hook'], input).code, legacy(['--hook'], input).stdout], [0, ''])
    })

    test('링크로 불러도 실체 옆의 새 명령을 찾는다', () => {
      const link = join(tempDir(), `${name}.py`)
      symlinkSync(realpathSync(entry(name)), link)
      const path = bad()
      const a = spawnSync(link, ['--hook'], { env: cleanEnv(), input: hookInput(path), encoding: 'utf8' })
      assert.equal(a.status, 0)
      assert.ok(JSON.parse(a.stdout).hookSpecificOutput.additionalContext.startsWith(notice(name)))
      assert.equal(spawnSync(link, [path], { env: cleanEnv(), encoding: 'utf8' }).stdout, direct([path]).stdout)
    })

    test('Node 가 낮으면 훅은 발견과 상관없이 건너뛰기 안내를 내고 0 이다', () => {
      const shim = lowNodeShim('22.9.0')
      for (const file of [bad(), good()]) {
        const done = legacy(['--hook'], hookInput(file), [process.execPath, '--require', shim, entry(name)])
        assert.equal(done.code, 0)
        assert.equal(done.stdout, '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "Node 24 이상이 필요해 한국어 검사를 건너뛰었다"}}\n')
      }
    })

    test('Node 가 낮으면 일반 모드는 stderr 에 안내하고 127 이다', () => {
      const done = legacy([good()], undefined, [process.execPath, '--require', lowNodeShim('23.11.0'), entry(name)])
      assert.deepEqual([done.code, done.stdout, done.stderr], [127, '', `${name}.py: Node 24 이상이 필요해 한국어 검사를 건너뛰었다\n`])
    })

    test('최소 버전과 같은 Node 는 새 명령으로 간다', () => {
      const done = legacy([good()], undefined, [process.execPath, '--require', lowNodeShim('24.0.0'), entry(name)])
      assert.equal(done.code, direct([good()]).code)
    })
  })
}
