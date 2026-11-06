// content-preview 의 style-check 명령 경계 테스트. korean-check 의 check.ts 를 찾는 순서와 인자·종료 코드 전달을 본다.
// 가짜 check.ts 를 형제 디렉터리, KOREAN_CHECK, 개인 스킬 폴더에 둔다. 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { copyScripts, run, tempDir, write } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const command = (scripts: string) => [process.execPath, join(scripts, 'style-check.ts')]
// ──

function layout(t: { after(fn: () => void): void }) {
  const root = tempDir('style-check-', t)
  const scripts = copyScripts(root)
  const home = join(root, 'home')
  const sibling = join(root, 'skills', 'korean-check', 'scripts', 'check.ts')
  const personal = join(home, '.claude', 'skills', 'korean-check', 'scripts', 'check.ts')
  const custom = join(root, 'custom', 'scripts', 'check.ts')
  const env = { ...process.env, HOME: home } as NodeJS.ProcessEnv
  delete env.KOREAN_CHECK
  delete env.FAKE_RC
  delete env.FAKE_CAT
  const exec = (args: string[], extra: NodeJS.ProcessEnv = {}, input?: string) => run([...command(scripts), ...args], { cwd: root, env: { ...env, ...extra }, input })
  // 가짜 check.ts 는 불린 경로와 받은 인자를 `경로:[인자][인자]` 로 stdout 에 낸다. node 로 실행하므로 실행 권한은 필요 없다
  const fake = (path: string) =>
    write(
      path,
      `import { readFileSync } from 'node:fs'
process.stdout.write(import.meta.filename + ':' + process.argv.slice(2).map((a) => '[' + a + ']').join('') + '\\n')
if (process.env.FAKE_CAT) process.stdout.write(readFileSync(0, 'utf8'))
process.exitCode = Number(process.env.FAKE_RC ?? 0)
`,
    )
  const said = (path: string, ...args: string[]) => `${path}:${args.map((a) => `[${a}]`).join('')}\n`
  return { root, sibling, personal, custom, exec, fake, said }
}

describe('style-check', () => {
  test('인자가 없으면 2', (t) => {
    const s = layout(t)
    const done = s.exec([])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('검사할 파일이나 --text 가 필요하다'))
  })

  test('형제 디렉터리의 check.ts 에 인자를 그대로 넘기고 그 출력과 종료 코드를 낸다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    const done = s.exec(['a.md', '--text', '제목 하나', '--x=y'], { FAKE_RC: '1' })
    assert.equal(done.code, 1)
    assert.equal(done.stdout, s.said(s.sibling, 'a.md', '--text', '제목 하나', '--x=y'))
  })

  test('--where 도 그대로 넘긴다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    const done = s.exec(['--where'])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, s.said(s.sibling, '--where'))
  })

  test('표준 입력을 물려준다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    const done = s.exec(['-'], { FAKE_CAT: '1' }, 'from stdin')
    assert.equal(done.stdout, `${s.said(s.sibling, '-')}from stdin`)
  })

  test('KOREAN_CHECK 가 형제보다 먼저다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    s.fake(s.custom)
    const done = s.exec(['a.md'], { KOREAN_CHECK: join(s.root, 'custom') })
    assert.equal(done.stdout, s.said(s.custom, 'a.md'))
  })

  test('형제가 개인 스킬 폴더보다 먼저다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    s.fake(s.personal)
    assert.equal(s.exec(['a.md']).stdout, s.said(s.sibling, 'a.md'))
  })

  test('형제가 없으면 개인 스킬 폴더를 쓴다', (t) => {
    const s = layout(t)
    s.fake(s.personal)
    assert.equal(s.exec(['a.md']).stdout, s.said(s.personal, 'a.md'))
  })

  test('KOREAN_CHECK 의 check.ts 가 없으면 다음 후보로 간다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    assert.equal(s.exec(['a.md'], { KOREAN_CHECK: join(s.root, 'nowhere') }).stdout, s.said(s.sibling, 'a.md'))
  })

  test('어디에도 없으면 2 이고 찾는 곳을 알린다', (t) => {
    const s = layout(t)
    const done = s.exec(['a.md'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('korean-check 를 찾지 못해 표기 검사를 돌리지 못했다.'))
    assert.ok(done.stderr.includes('KOREAN_CHECK, 이 스킬의 형제 디렉터리, 개인 스킬 디렉터리다.'))
    assert.equal(done.stdout, '')
  })

  test('종료 코드 0 과 2 도 그대로 전달한다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    assert.equal(s.exec(['a.md'], { FAKE_RC: '2' }).code, 2)
    assert.equal(s.exec(['a.md']).code, 0)
  })
})
