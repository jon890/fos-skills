// 루프의 단계 구현이 진입 파일로 다시 합쳐지거나, 단계 순서가 머리 주석과 어긋나거나, import 방향이 거꾸로 되는 것을 막는다.
// 동작은 orch-loop*.spec.ts 와 고정 입력 기록(golden.spec.ts), Run 둘의 순서 기록(loop-order.spec.ts)이 본다.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const loop = fileURLToPath(new URL('../scripts/loop/', import.meta.url))
const entry = readFileSync(join(loop, 'orch-loop.ts'), 'utf8')
// 단계가 아닌 공통 파일. 단계가 주고받는 값, 오류 기록, 로그와 worker 찾기를 둔다
const COMMON = ['context.ts', 'errors.ts', 'shared.ts']
const stepFiles = readdirSync(join(loop, 'steps')).filter((name) => !COMMON.includes(name)).sort()

test('tick 은 머리 주석 「틱」 에 적은 순서대로 단계 파일을 모두 한 번씩 부른다', async () => {
  // 머리 주석의 순서: `// 틱:` 절의 번호 줄에 적힌 steps/<파일>.ts
  const rows = entry.split('\n')
  const start = rows.findIndex((row) => row.startsWith('// 틱:'))
  assert.notEqual(start, -1, '머리 주석에 「틱」 절이 없다')
  const documented: string[] = []
  for (const row of rows.slice(start + 1)) {
    if (!/^\/\/ {5}\d/.test(row)) break
    for (const m of row.matchAll(/steps\/([\w-]+\.ts)/g)) documented.push(m[1])
  }
  // 단계 함수가 어느 파일의 것인지
  const owner = new Map<string, string>()
  for (const file of stepFiles) {
    const module = await import(new URL(`../scripts/loop/steps/${file}`, import.meta.url).href)
    const steps = Object.keys(module).filter((name) => typeof module[name] === 'function' && new RegExp(`await ${name}\\(ctx, state\\)`).test(entry))
    assert.equal(steps.length, 1, `${file} 의 단계 함수는 하나여야 한다: ${steps.join(', ')}`)
    owner.set(steps[0], file)
  }
  const called = [...entry.matchAll(/collect\(state, await (\w+)\(ctx, state\)\)/g)].map((m) => owner.get(m[1]) ?? m[1])
  assert.deepEqual(called, documented)
  assert.deepEqual([...called].sort(), stepFiles)
})

test('진입 파일은 단계 호출과 인자 해석만 갖고 구현 함수를 갖지 않는다', () => {
  const defined = [...entry.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1])
  assert.deepEqual(defined, ['tick', 'collect', 'main', 'executeMain', 'reportError'])
})

test('lifecycle 은 공통 파일만, 단계 파일은 lifecycle 을 import 하지 않고 아무도 진입 파일을 import 하지 않는다', async () => {
  const imports = (text: string) => [...text.matchAll(/^import [^'\n]*'([^']+)'/gm)].map((m) => m[1])
  const lifecycle = readFileSync(join(loop, 'lifecycle.ts'), 'utf8')
  assert.deepEqual(imports(lifecycle).filter((from) => from.startsWith('./')).sort(), COMMON.map((name) => `./steps/${name}`).sort())
  for (const file of [...stepFiles, ...COMMON]) {
    const from = imports(readFileSync(join(loop, 'steps', file), 'utf8'))
    assert.deepEqual(from.filter((path) => /lifecycle|orch-loop/.test(path)), [], file)
  }
  assert.deepEqual(imports(lifecycle).filter((path) => path.includes('orch-loop')), [])
  const api = await import(new URL('../scripts/loop/lifecycle.ts', import.meta.url).href)
  for (const name of ['start', 'stop', 'status', 'foreground']) assert.equal(typeof api[name], 'function', name)
})

test('자동 머지의 기본 스레드 명령이 가리키는 스크립트가 있다', () => {
  // 명령 글자는 loop 폴더에서 시작하는 경로를 그대로 잇는다(steps/auto-merge.ts 의 LOOP_DIR)
  const text = readFileSync(join(loop, 'steps', 'auto-merge.ts'), 'utf8')
  const found = /\$\{LOOP_DIR\}\/([^'`\s]+)/.exec(text)
  assert.ok(found, 'LOOP_DIR 로 잇는 경로가 없다')
  assert.ok(existsSync(resolve(loop, found[1])), found[1])
})

test('옮겨 간 절을 옛 이름으로 가리키는 주석이 남아 있지 않다', () => {
  // 정리의 머리 주석은 cleanup/steps/ 로, 「대기 확인」 은 「미답변 질문 확인」 으로 바뀌었다
  const files = [join(loop, 'orch-loop.ts'), join(loop, 'lifecycle.ts'), ...readdirSync(join(loop, 'steps')).map((name) => join(loop, 'steps', name)), resolve(loop, '..', 'lib', 'review.ts')]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const old of ['cleanup-sweep 머리 주석', 'cleanup-sweep 의 「', '「대기 확인」']) assert.ok(!text.includes(old), `${file}: ${old}`)
  }
})
