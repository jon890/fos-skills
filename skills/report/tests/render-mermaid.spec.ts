import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { runCommand } from '../../../modules/testkit/command.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'

const COMMAND = [process.execPath, join(import.meta.dirname, '..', 'scripts', 'render-mermaid.ts')]
const code = (source: string) => `<pre><code class='language-mermaid'>${source}</code></pre>`
const wrap = (content: string) => `<html><body><figure class="diagram">${content}<figcaption>서비스에 요청을 보낸다.</figcaption></figure></body></html>`

test('가짜 렌더러로 성공한 블록만 바꾸고 재실행해도 유지한다', (t) => {
  const dir = tempDir('render-mermaid-', t)
  const file = join(dir, 'report.html')
  const chrome = join(dir, 'chrome')
  writeFileSync(chrome, '', { mode: 0o755 })
  writeFileSync(join(dir, 'npx'), `#!${process.execPath}
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const arg = (name) => args[args.indexOf(name) + 1]
assert.match(args[1], /^@mermaid-js\\/mermaid-cli@/)
assert.equal(process.env.PUPPETEER_SKIP_DOWNLOAD, 'true')
assert.equal(JSON.parse(readFileSync(arg('--puppeteerConfigFile'), 'utf8')).executablePath, process.env.REPORT_CHROME_PATH)
assert.equal(JSON.parse(readFileSync(arg('--configFile'), 'utf8')).look, 'handDrawn')
const source = readFileSync(arg('--input'), 'utf8')
if (source === 'invalid') {
  console.error('가짜 렌더러 실패')
  process.exit(1)
}
if (source === 'external') {
  writeFileSync(arg('--output'), '<svg><image href="https://example.com/image.png"/></svg>')
  process.exit(0)
}
assert.equal(source, 'flowchart LR\\nA --> B')
writeFileSync(arg('--output'), '<svg id="' + arg('--svgId') + '"><defs><g id="dot"/></defs><use href="#dot" fill="url(#dot)"/></svg>')
`, { mode: 0o755 })
  const ignored = `<!-- ${code('invalid')} -->`
  const source = code('flowchart LR\nA --&gt; B')
  const original = wrap(ignored + source + code('invalid') + source + code('external'))
  writeFileSync(file, original)
  const run = () => runCommand([...COMMAND, file], {
    env: { ...process.env, REPORT_CHROME_PATH: chrome, PATH: dir + delimiter + process.env.PATH },
  })

  const done = run()
  assert.equal(done.code, 1, done.stderr)
  assert.match(done.stderr, /classDef/)
  assert.match(done.stderr, /가짜 렌더러 실패/)
  assert.match(done.stderr, /밖의 자원/)
  const html = readFileSync(file, 'utf8')
  const ids = [...html.matchAll(/id="([^"]+-dot)"/g)].map((match) => match[1])
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
  for (const id of ids) assert.ok(html.includes(`href="#${id}" fill="url(#${id})"`))
  assert.ok(html.includes(ignored))
  assert.ok(html.includes(code('invalid')))
  assert.ok(html.includes(code('external')))
  assert.ok(html.includes('<figcaption>서비스에 요청을 보낸다.</figcaption>'))
  assert.equal(run().code, 1)
  assert.equal(readFileSync(file, 'utf8'), html)
})

test('Chrome 이 없으면 원문을 그대로 두고 이유를 알린다', (t) => {
  const dir = tempDir('render-mermaid-', t)
  const file = join(dir, 'report.html')
  const html = wrap(code('flowchart LR'))
  writeFileSync(file, html)
  const done = runCommand([...COMMAND, file], {
    env: { ...process.env, REPORT_CHROME_PATH: join(dir, 'missing-chrome') },
  })
  assert.equal(done.code, 1)
  assert.match(done.stderr, /설치된 Chrome 을 찾지 못해/)
  assert.equal(readFileSync(file, 'utf8'), html)
})
