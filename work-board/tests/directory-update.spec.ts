// directory 설치본 갱신을 실제 Git 임시 저장소로 본다. 모의 process.run 은 임시 저장소로 향한 git 만 실행한다.
//
// 실행: node --test work-board/tests/directory-update.spec.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { installOf, resolveLoadSource, updatePlugin, updateVisible } from '../hooks/register.js'

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

// 프로세스 표를 흉내 낸다. ps 는 pid 의 { ppid, command } 를, lsof 는 cwd 를, realpath 는 실제 명령을 쓴다
type Proc = { ppid: number, command: string, cwd?: string }
function fakeProcesses(table: Record<number, Proc>, options: { psExit?: number, psThrows?: boolean, truncated?: boolean, startPid?: number } = {}) {
  return {
    process: { run: async (argv: string[]) => {
      if (argv[0] === 'ps') {
        if (options.psThrows) throw new Error('ps 없음')
        const proc = table[Number(argv[argv.length - 1])]
        if (options.psExit || !proc) return { exitCode: options.psExit || 1, stdout: '', stderr: 'x' }
        return { exitCode: 0, stdout: proc.ppid + ' ' + proc.command + '\n', stderr: '', isStdoutTruncated: Boolean(options.truncated) }
      }
      if (argv[0] === 'sh') return options.psThrows ? Promise.reject(new Error('sh 없음')) : { exitCode: 0, stdout: String(options.startPid ?? 30) + '\n', stderr: '' }
      if (argv[0] === 'lsof') {
        const proc = table[Number(argv[argv.indexOf('-p') + 1])]
        return proc && proc.cwd ? { exitCode: 0, stdout: 'p1\nn' + proc.cwd + '\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }
      }
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: ENV })
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
    } },
  }
}
// 훅(pid 30) -> 셸(20) -> claude(10)
const session = (command: string, cwd = '/') => ({ 30: { ppid: 20, command: 'node hook.js' }, 20: { ppid: 10, command: 'sh' }, 10: { ppid: 1, command, cwd } })

test('로드 출처: 이 세션의 claude 인자만 본다 (절대경로, 상대경로, 공백 경로, 병행 세션)', async () => {
  const dir = repos.success
  const spaced = join(base, 'space dir')
  await mkdir(spaced)
  const cases: [string, string, string?][] = [
    ['절대경로', 'claude --plugin-dir ' + dir, undefined],
    ['등호', 'claude --plugin-dir=' + dir, undefined],
    ['공백 경로', 'claude --plugin-dir "' + spaced + '" --model x', undefined],
    ['상대경로', 'claude --plugin-dir ./success', base],
  ]
  for (const [label, command, cwd] of cases) {
    const root = label === '공백 경로' ? spaced : dir
    const $ = fakeProcesses(session(command, cwd))
    assert.equal(await resolveLoadSource($, root), 'explicit', label)
  }
  // 이 세션은 플래그가 없고 다른 세션이 같은 폴더를 직접 읽어도 영향이 없다
  const parallel = { ...session('claude --model sonnet'), 99: { ppid: 1, command: 'claude --plugin-dir ' + dir } }
  assert.equal(await resolveLoadSource(fakeProcesses(parallel), dir), 'registered')
  // claude 낱말만 든 다른 명령은 세션이 아니다
  assert.equal(await resolveLoadSource(fakeProcesses({ 30: { ppid: 1, command: 'grep claude --plugin-dir ' + dir } }), dir), 'unknown')
})

test('로드 출처를 확정하지 못하면 unknown 이다 (ps 실패, 예외, 잘림, cwd 못 읽음, 프로세스 없음)', async () => {
  const dir = repos.success
  const plain = session('claude --model x')
  assert.equal(await resolveLoadSource(fakeProcesses(plain, { psExit: 1 }), dir), 'unknown')
  assert.equal(await resolveLoadSource(fakeProcesses(plain, { psThrows: true }), dir), 'unknown')
  assert.equal(await resolveLoadSource(fakeProcesses(plain, { truncated: true }), dir), 'unknown')
  assert.equal(await resolveLoadSource(fakeProcesses({ 30: { ppid: 1, command: 'node hook.js' } }), dir), 'unknown')
  assert.equal(await resolveLoadSource(fakeProcesses(plain, { startPid: 0 }), dir), 'unknown')
  const relative = session('claude --plugin-dir ./success')
  delete (relative as Record<number, Proc>)[10].cwd
  assert.equal(await resolveLoadSource(fakeProcesses(relative), dir), 'unknown')
})

test('직접 읽는 tree 는 p 도 Git 갱신도 없다', async () => {
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
