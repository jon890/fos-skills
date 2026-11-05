// lib/output.ts 의 짧은 출력 판정과 줄 규칙을 본다. 신호는 import 할 때 읽으므로 자식 node 로 돌린다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const OUTPUT = fileURLToPath(new URL('../scripts/lib/output.ts', import.meta.url))

// body 는 output.ts 를 o 로 가져온 뒤 도는 코드다. args 는 그 자식의 process.argv.slice(2) 다(-e 는 스크립트 경로 자리가 없어 하나를 채운다)
function runWith(body: string, env: Record<string, string | undefined>, args: string[] = []): { stdout: string; code: number | null; stderr: string } {
  const code = `const o = await import(${JSON.stringify(OUTPUT)});\n${body}`
  const merged: NodeJS.ProcessEnv = { ...process.env }
  delete merged.ORCH_OUTPUT
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k]
  else merged[k] = v
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code, '--', 'script.ts', ...args], { env: merged, encoding: 'utf8' })
  return { stdout: done.stdout, code: done.status, stderr: done.stderr }
}

const RULES = "[[/^옮김 (\\S+)$/, (m) => `MOVED ${m[1]}`], [/^버림$/, () => null]]"

describe('emit', () => {
  test('짧은 출력이면 규칙 결과와 판정 줄만 내고 설명 줄은 버린다', () => {
    const r = runWith(`o.emit('옮김 a.md\\nLOOP-ALIVE 1 run=r\\n안내: 설명이다\\n버림', ${RULES})`, { ORCH_OUTPUT: 'short' })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, 'MOVED a.md\nLOOP-ALIVE 1 run=r\n')
  })

  test('신호가 없으면 받은 글을 그대로 낸다', () => {
    const r = runWith(`o.emit('옮김 a.md\\n안내: 설명이다', ${RULES})`, {})
    assert.equal(r.stdout, '옮김 a.md\n안내: 설명이다\n')
  })

  test('fix 를 켜면 남긴 판정 줄 바로 뒤의 고칠 줄만 남기고 안내 줄과 버린 줄 뒤의 들여쓰기는 버린다', () => {
    const text = 'LOOP-STALE /r 1 4.0\\n  안내: 설명\\n  orch loop start\\n설명 줄\\n  orch 다른 명령\\nCLI-MISSING /x\\n  고칠 명령: orch doctor install-cli'
    const r = runWith(`o.emit('${text}', [], { fix: true })`, { ORCH_OUTPUT: 'short' })
    assert.equal(r.stdout, 'LOOP-STALE /r 1 4.0\n  orch loop start\nCLI-MISSING /x\n  고칠 명령: orch doctor install-cli\n')
  })

  test('fix 가 없으면 들여 쓴 줄은 판정 줄 뒤여도 버린다', () => {
    const r = runWith(`o.emit('FINISH-MISSING #1 b\\n  worktree 를 지울 것 b')`, { ORCH_OUTPUT: 'short' })
    assert.equal(r.stdout, 'FINISH-MISSING #1 b\n')
  })

  test('남길 줄이 없으면 아무것도 쓰지 않는다', () => {
    assert.equal(runWith(`o.emit('설명뿐이다')`, { ORCH_OUTPUT: 'short' }).stdout, '')
  })
})

describe('short 와 신호', () => {
  test('--json, --help, -h 를 첫 -- 앞에 주면 짧은 출력이 아니다', () => {
    for (const flag of ['--json', '--help', '-h']) {
      assert.equal(runWith('console.log(o.short())', { ORCH_OUTPUT: 'short' }, [flag]).stdout.trim(), 'false', flag)
    }
    assert.equal(runWith('console.log(o.short())', { ORCH_OUTPUT: 'short' }, ['--', '--json']).stdout.trim(), 'true')
    assert.equal(runWith('console.log(o.short())', {}, []).stdout.trim(), 'false')
  })

  test('import 한 뒤 환경에서 ORCH_OUTPUT 을 지우고 shortEnv 는 짧을 때만 신호를 낸다', () => {
    const body = 'console.log(JSON.stringify([process.env.ORCH_OUTPUT ?? null, o.shortEnv()]))'
    assert.equal(runWith(body, { ORCH_OUTPUT: 'short' }).stdout.trim(), '[null,{"ORCH_OUTPUT":"short"}]')
    assert.equal(runWith(body, {}).stdout.trim(), '[null,{}]')
    assert.equal(runWith(body, { ORCH_OUTPUT: 'short' }, ['--json']).stdout.trim(), '[null,{}]')
  })

  test('판정 줄은 대문자 낱말로 시작하는 줄이다', () => {
    const body = "console.log(['LAST_DELIVERY d', 'QUEUE-DONE', 'answer: x', '#12 CONFLICTING', 'LOOP-ALIVE', 'Ok 1'].map((l) => o.isVerdict(l)).join(' '))"
    assert.equal(runWith(body, {}).stdout.trim(), 'true true false false true false')
  })

  test('oneLine 은 줄바꿈을 공백 하나로 바꾸고 글자 수로 자른다', () => {
    assert.equal(runWith("console.log(o.oneLine('가나\\n  다라\\r\\n마', 4))", {}).stdout.trim(), '가나 다')
  })
})
