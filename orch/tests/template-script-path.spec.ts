// templates/spec-common.md 의 스크립트 경로 명령이 세션의 설치본을 고르는지 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../templates/spec-common.md', import.meta.url))

function template(): string {
  return readFileSync(TEMPLATE, 'utf8')
}

function resolver(): string {
  const m = /ORCH_SCRIPTS=\$\((node -e '.*?')\) &&/.exec(template())
  assert.ok(m, '틀에서 경로를 푸는 명령을 찾지 못했다')
  return m[1]
}

function resolve(extra: Record<string, string>, home: string): { code: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, HOME: home }
  if (!('CLAUDE_CONFIG_DIR' in extra)) delete env.CLAUDE_CONFIG_DIR
  // 틀의 명령은 PATH 의 node 를 부른다. 이 테스트의 node 를 먼저 찾게 한다
  env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
  const done = spawnSync('sh', ['-c', resolver()], { env, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function writeInstalled(configDir: string, entries: { scope: string; installPath: string }[]): void {
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  const data = { version: 2, plugins: { 'fos-skills@fos-skills': entries, 'other@x': [{ scope: 'user', installPath: '/no' }] } }
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify(data))
}

// 셸이 한 줄을 읽을 때 따옴표 밖에 홀로 선 `<` 연산자가 있는지. 작은따옴표, 큰따옴표, 역슬래시 인용을 따른다.
// `<<`, `<(` 처럼 연산자 글자가 이어지면 다른 연산자라 `<` 로 세지 않는다. `#` 은 낱말 머리에서만 주석이다.
function hasInputRedirect(line: string): boolean {
  const operators = '();<>|&'
  let quote: '' | "'" | '"' = ''
  let run = ''
  let atWordStart = true
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (c === '\\') i++
      else if (c === '"') quote = ''
      continue
    }
    if (operators.includes(c)) {
      run += c
      atWordStart = true
      continue
    }
    if (run === '<') return true
    run = ''
    if (c === '#' && atWordStart) return false
    if (c === '\\') i++
    else if (c === "'" || c === '"') quote = c
    atWordStart = c === ' ' || c === '\t'
  }
  return run === '<'
}

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'template-script-path-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('spec-common.md 의 스크립트 경로', () => {
  test('고정 경로 플레이스홀더가 남아 있지 않다', () => {
    assert.ok(!template().includes('{{ORCH_SCRIPTS}}'))
  })

  test('입력 리다이렉션 판정은 따옴표 밖의 홀로 선 < 만 잡는다', () => {
    assert.equal(hasInputRedirect('worker-ask --from <머리말의 --from 값>'), true)
    assert.equal(hasInputRedirect("node -e 'a<b' && echo \"x<y\" > out"), false)
    assert.equal(hasInputRedirect("cat <<'EOF'"), false)
  })

  test('bash 블록에 플레이스홀더가 입력 리다이렉션으로 읽히는 줄이 없다', () => {
    // `<머리말의 --from 값>` 같은 플레이스홀더는 셸이 입력 리다이렉션으로 읽는다. `>` 출력 리다이렉션은 정상 명령이라 막지 않는다
    const blocks = [...template().matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
    assert.ok(blocks.length > 0, '틀에 bash 블록이 없다')
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        assert.equal(hasInputRedirect(line), false, `플레이스홀더가 입력 리다이렉션으로 읽힌다: ${line}`)
      }
    }
  })

  test('CLAUDE_CONFIG_DIR 의 설치본을 쓰고 user scope 를 먼저 고른다', () => {
    const config = join(tmp, 'profile with space', 'home')
    writeInstalled(config, [
      { scope: 'project', installPath: '/p/old' },
      { scope: 'user', installPath: '/u/new' },
    ])
    const r = resolve({ CLAUDE_CONFIG_DIR: config }, join(tmp, 'nohome'))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), '/u/new/orch/scripts')
  })

  test('CLAUDE_CONFIG_DIR 가 없으면 ~/.claude 를 쓴다', () => {
    const home = join(tmp, 'h')
    writeInstalled(join(home, '.claude'), [{ scope: 'user', installPath: '/home/bundle' }])
    const r = resolve({}, home)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), '/home/bundle/orch/scripts')
  })

  test('이 기기의 설치본으로 풀린다', (t) => {
    const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    if (!existsSync(join(config, 'plugins', 'installed_plugins.json'))) {
      t.skip('fos-skills 설치본이 없다')
      return
    }
    const r = resolve({ CLAUDE_CONFIG_DIR: config }, homedir())
    if (r.code !== 0) {
      t.skip('fos-skills 항목이 없다')
      return
    }
    assert.ok(r.stdout.trim().endsWith('/orch/scripts'), r.stdout)
  })
})
