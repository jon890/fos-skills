// content-preview 의 style-check 명령 경계 테스트. korean-check 의 check.ts 를 찾는 순서와 인자·종료 코드 전달을 본다.
// 가짜 check.ts 를 형제 디렉터리, KOREAN_CHECK, 개인 스킬 폴더에 둔다. 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { copyScripts, lines, linkFake, run, tempDir, write } from './helpers.ts'

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
  test('업무와 댓글 모드에서 파일 사이 중복 조회를 줄이고 잘못된 링크를 막는다', (t) => {
    const s = layout(t)
    s.fake(s.sibling)
    linkFake(join(s.root, 'dooray'), 'dooray')
    const log = join(s.root, 'dooray.log')
    const env = { PATH: s.root, FAKE_LOG: log, FAKE_DOORAY_JSON: '{"project":{"code":"example"},"number":"18"}' }
    const first = write(join(s.root, 'first.md'), '[example/18 제목](dooray://example/tasks/post-example "registered")')
    const second = write(join(s.root, 'second.md'), '[example/20 제목](dooray://example/tasks/post-example "registered")')
    const done = s.exec(['--mode', 'comment', first, second], env)
    assert.equal(done.code, 1)
    assert.match(done.stderr, /실제 업무 example\/18 가 다릅니다/u)
    assert.match(done.stderr, /고친 예 \[example\/18\]/u)
    assert.deepEqual(lines(log), ['--json post get --id post-example'])

    const good = s.exec([first, '--mode=task'], env)
    assert.equal(good.code, 0)
    assert.equal(good.stdout, s.said(s.sibling, first))
    assert.deepEqual(lines(log), Array(2).fill('--json post get --id post-example'))

    assert.equal(s.exec([second], env).code, 0)
    assert.equal(s.exec(['--text', '--mode', 'task'], env).code, 0)
    assert.equal(lines(log).length, 2)
  })

  test('실제 검사기를 통해 본문과 제목의 물결표 오류를 막는다', (t) => {
    const s = layout(t)
    const checker = join(import.meta.dirname, '..', '..', 'korean-check')
    const body = write(join(s.root, 'body.md'), '범위 1~2 와 3~4 다.\n')
    for (const args of [[body], ['--text', '범위 1~2 와 3~4 다.']]) {
      const done = s.exec(args, { KOREAN_CHECK: checker })
      assert.equal(done.code, 1, done.stdout + done.stderr)
      assert.ok(done.stdout.includes('실패 [TILDE]'))
      assert.ok(!done.stdout.includes('표기 검사 통과'))
    }
  })

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
