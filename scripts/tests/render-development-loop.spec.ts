// README 의 Mermaid 원본을 SVG 로 다시 그리는 명령(scripts/render-development-loop)의 명령 경계 테스트.
// 가짜 mmdc 가 받은 인자와 입력 파일 내용을 기록하고 -o 파일을 만든다.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', 'scripts/render-development-loop.ts']
const FILES = ['scripts/render-development-loop.ts', 'modules/kit/args.ts', 'modules/kit/py.ts']
// ──

const README = '# 제목\n\n```mermaid\nflowchart TD\n    A --> B\n```\n\n뒤 문단\n\n```mermaid\nflowchart LR\n    X\n```\n'

const FAKE_MMDC = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const input = argv[argv.indexOf('-i') + 1]
fs.appendFileSync(__filename + '.log', JSON.stringify({ argv, input: fs.readFileSync(input, 'utf8') }) + '\\n')
fs.writeFileSync(argv[argv.indexOf('-o') + 1], '<svg/>')
`

function write(root: string, path: string, text: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function fixture(t: { after(fn: () => void): void }, readme = README) {
  const root = tempDir('render-loop-', t)
  copyFromRepo(root, FILES)
  write(root, 'README.md', readme)
  write(root, 'docs/diagrams/development-loop.config.json', '{}\n')
  const mmdc = join(root, 'bin', 'mmdc')
  write(root, 'bin/mmdc', FAKE_MMDC)
  chmodSync(mmdc, 0o755)
  const calls = () =>
    existsSync(`${mmdc}.log`)
      ? readFileSync(`${mmdc}.log`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; input: string })
      : []
  return { root, mmdc, calls }
}

function render(root: string, args: string[]) {
  // cwd 를 저장소 밖에 두어 명령이 자기 위치로 저장소를 찾는지 본다
  return runCommand([...COMMAND.slice(0, -1), join(root, COMMAND.at(-1)!), ...args], { cwd: dirname(root) })
}

describe('render-development-loop 명령', () => {
  test('첫 Mermaid 원본을 mmdc 에 넘기고 SVG 경로를 낸다', (t) => {
    const f = fixture(t)
    const done = render(f.root, ['--mmdc', f.mmdc])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, 'docs/images/development-loop.svg\n')
    assert.ok(existsSync(join(f.root, 'docs/images/development-loop.svg')))
    const [call, ...rest] = f.calls()
    assert.equal(rest.length, 0)
    assert.equal(call.input, 'flowchart TD\n    A --> B\n')
    const i = call.argv[1]
    assert.deepEqual(call.argv, [
      '-i', i,
      '-c', join(f.root, 'docs/diagrams/development-loop.config.json'),
      '-b', 'white', '--size', '1400',
      '-o', join(f.root, 'docs/images/development-loop.svg'),
    ])
    assert.ok(i.endsWith('/development-loop.mmd'))
  })

  test('--preview 와 --puppeteer-config 는 두 번째 호출과 -p 절대 경로로 넘긴다', (t) => {
    const f = fixture(t)
    write(f.root, 'p.json', '{}')
    mkdirSync(join(f.root, 'out'))
    const done = runCommand([...COMMAND, '--mmdc', f.mmdc, '--puppeteer-config', 'p.json', '--preview', 'out/loop.png'], { cwd: f.root })
    assert.equal(done.code, 0, done.stderr)
    const calls = f.calls()
    assert.equal(calls.length, 2)
    for (const call of calls) assert.deepEqual(call.argv.slice(8, 10), ['-p', join(f.root, 'p.json')])
    assert.equal(calls[0].argv.at(-1), join(f.root, 'docs/images/development-loop.svg'))
    assert.equal(calls[1].argv.at(-1), join(f.root, 'out/loop.png'))
  })

  test('긴 옵션의 고유 접두를 받는다', (t) => {
    const f = fixture(t)
    const done = render(f.root, [`--mm=${f.mmdc}`])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(f.calls().length, 1)
  })

  test('README 에 Mermaid 원본이 없으면 2 이고 mmdc 를 부르지 않는다', (t) => {
    const f = fixture(t, '# 제목\n\n본문\n')
    const done = render(f.root, ['--mmdc', f.mmdc])
    assert.equal(done.code, 2)
    assert.match(done.stderr, /README 에 Mermaid 원본이 없다/)
    assert.equal(f.calls().length, 0)
  })

  test('모르는 옵션은 2 다', (t) => {
    const f = fixture(t)
    assert.equal(render(f.root, ['--nope']).code, 2)
    assert.equal(render(f.root, ['--mmdc']).code, 2)
  })

  test('mmdc 가 실패하면 1 이다', (t) => {
    const f = fixture(t)
    write(f.root, 'bin/mmdc', '#!/usr/bin/env node\nprocess.exit(3)\n')
    assert.equal(render(f.root, ['--mmdc', f.mmdc]).code, 1)
  })
})
