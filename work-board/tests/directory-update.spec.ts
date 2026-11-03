// directory 설치본 갱신을 실제 Git 임시 저장소로 본다. 모의 process.run 은 임시 저장소로 향한 git 만 실행한다.
//
// 실행: node --test work-board/tests/directory-update.spec.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { installOf, updatePlugin, updateVisible } from '../hooks/register.js'

const ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
}
const git = (...args: string[]) => {
  const r = spawnSync('git', args, { encoding: 'utf8', env: ENV })
  if (r.status !== 0) throw new Error(JSON.stringify({ args, stderr: r.stderr }))
  return r.stdout.trim()
}
const manifest = (v: string) => JSON.stringify({ name: 'fos-skills', version: v, repository: '' })

const NAMES = ['success', 'dirty', 'staged', 'branch', 'diverged', 'ahead', 'detached']
let base = ''
let latest = ''
let old = ''
const repos: Record<string, string> = {}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'directory-update-'))
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  git('init', '--bare', '--initial-branch=main', remote)
  git('clone', remote, seed)
  await mkdir(join(seed, '.claude-plugin'))
  await writeFile(join(seed, '.claude-plugin/plugin.json'), manifest('1.4.0'))
  await writeFile(join(seed, 'tracked.txt'), 'initial\n')
  git('-C', seed, 'add', '.')
  git('-C', seed, 'commit', '-m', 'initial')
  git('-C', seed, 'push', 'origin', 'main')
  old = git('-C', seed, 'rev-parse', 'HEAD')
  for (const name of NAMES) {
    repos[name] = join(base, name)
    git('clone', remote, repos[name])
  }
  await writeFile(join(seed, '.claude-plugin/plugin.json'), manifest('1.5.0'))
  git('-C', seed, 'commit', '-am', 'latest')
  git('-C', seed, 'push', 'origin', 'main')
  latest = git('-C', seed, 'rev-parse', 'HEAD')
  await writeFile(join(repos.dirty, 'tracked.txt'), 'local dirty\n')
  await writeFile(join(repos.staged, 'tracked.txt'), 'local staged\n')
  git('-C', repos.staged, 'add', 'tracked.txt')
  git('-C', repos.branch, 'checkout', '-b', 'feat/test')
  git('-C', repos.detached, 'checkout', '--detach')
  await writeFile(join(repos.diverged, 'tracked.txt'), 'local committed\n')
  git('-C', repos.diverged, 'commit', '-am', 'local')
  git('-C', repos.ahead, 'pull', '--ff-only', 'origin', 'main')
  await writeFile(join(repos.ahead, 'tracked.txt'), 'ahead committed\n')
  git('-C', repos.ahead, 'commit', '-am', 'ahead')
})

after(async () => {
  if (base) await rm(base, { recursive: true, force: true })
})

const REFUSAL: Record<string, RegExp> = {
  dirty: /고치는 중인 파일/, staged: /고치는 중인 파일/, branch: /main 이 아니라서/, detached: /main 이 아니라서/,
  diverged: /fast-forward 할 수 없어서/, ahead: /fast-forward 할 수 없어서/,
}

for (const name of NAMES) {
  test('directory 설치본 ' + name + ': ' + (name === 'success' ? 'main 을 fast-forward 로 받고 /reload-plugins 를 채운다' : '받지 않고 이유를 알린다'), async () => {
    const dir = repos[name]
    const calls: string[][] = []
    const fills: string[] = []
    const toasts: string[] = []
    const before = git('-C', dir, 'rev-parse', 'HEAD')
    const $ = {
      plugin: { root: dir, name: 'fos-skills' },
      process: { run: async (argv: string[]) => {
        calls.push(argv)
        assert.equal(argv[0], 'git')
        assert.equal(argv[1], '-C')
        assert.equal(argv[2], dir)
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: ENV })
        return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
      } },
      fs: { read: (path: string) => readFile(path, 'utf8') },
      prompt: { fill: async ({ text }: { text: string }) => { fills.push(text) } },
      ui: { toast: (text: string) => { toasts.push(text) }, invalidate: () => {} },
    }
    await updatePlugin($, { kind: 'directory', version: '1.4.0', dir, commit: old } as never)
    const pulled = calls.some((argv) => argv[3] === 'pull')
    const after = git('-C', dir, 'rev-parse', 'HEAD')
    if (name === 'success') {
      assert.equal(after, latest)
      assert.deepEqual(fills, ['/reload-plugins'])
    } else {
      assert.equal(pulled, false)
      assert.equal(after, before)
      assert.deepEqual(fills, [])
      assert.match(toasts.at(-1) || '', REFUSAL[name])
    }
  })
}

test('등록된 폴더를 --plugin-dir 로 직접 읽으면 tree 라서 p 도 Git 갱신도 없다', async () => {
  const dir = repos.success
  const known = { market: { source: { source: 'directory', path: dir } } }
  const install = installOf(dir, null, { version: '1.4.0' }, 'fos-skills', known, true)
  assert.equal(install?.kind, 'tree')
  assert.equal(updateVisible(install, { commit: latest, version: '1.5.0' }), false)
  const calls: string[][] = []
  const $ = {
    plugin: { root: dir, name: 'fos-skills' },
    process: { run: async (argv: string[]) => { calls.push(argv); return { exitCode: 0, stdout: '', stderr: '' } } },
    prompt: { fill: async () => {} },
    ui: { toast: () => {}, invalidate: () => {} },
  }
  await updatePlugin($, install as never)
  assert.deepEqual(calls, [])
})
