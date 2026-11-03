import { test, expect } from 'claude-code/testing'
import { updatePlugin } from '../hooks/register.js'

// 머리 줄의 플러그인 버전, p 갱신, 좁은 창의 단축키 줄바꿈, 상태 줄 중복 전송을 본다.
// 테스트의 $.plugin.root 는 저장소 작업 트리라 설치본은 「작업 트리」 로 읽힌다. 마켓플레이스 설치본의 판정은 version.spec.ts 가 본다.

const OLD = 'de0cb6d67b9259b40a33d68e093fb511e256b005'
const NEW = 'b1e2c09d5b5abed277ce7593e2a601f9d2e739d6'
const BOARD = JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [{ id: 'a', title: '항목', status: 'wait' }] })
const MANIFEST = (version) => JSON.stringify({ name: 'fos-skills', repository: 'https://github.com/jon890/fos-skills', ...(version ? { version } : {}) })

const PANE = {
  plugin: 'fos-skills',
  component: 'Pane',
  requestId: 'work-board',
  props: { title: '작업 현황', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Drawn = { type: string; props: Record<string, unknown>; children: (Drawn | string)[] }
const textOf = (node: Drawn | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('')

// remote 는 ls-remote 와 curl 이 돌려줄 값이다. null 이면 그 명령이 실패한다
async function start($, on, { installed = '1.4.0', remote = { commit: NEW, version: '1.5.0' } as { commit: string; version: string } | null, statuses = [] as unknown[] } = {}) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'git' && argv.includes('rev-parse') && argv.includes('HEAD')) return { value: { exitCode: 0, stdout: OLD + '\n', stderr: '' } }
    if (argv[0] === 'git' && argv[1] === 'ls-remote') {
      return { value: remote ? { exitCode: 0, stdout: remote.commit + '\trefs/heads/main\n', stderr: '' } : { exitCode: 128, stdout: '', stderr: 'fatal: unable to access' } }
    }
    if (argv[0] === 'curl') return { value: remote ? { exitCode: 0, stdout: MANIFEST(remote.version), stderr: '' } : { exitCode: 6, stdout: '', stderr: 'curl: (6)' } }
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '없음' } }
  })
  on('fs.exists', (_, e) => ({ value: e.path === '/repo/.omc/board.json' }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/.claude-plugin/plugin.json') ? MANIFEST(installed) : BOARD }))
  on('clock.now', () => ({ value: Date.parse('2026-10-22T10:05:00+09:00') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

// 시각은 실행 환경의 시간대를 따르므로 형식만 보고, 버전 글은 그대로 본다
const head = async (ui) => textOf(await ui.find({ type: 'Box', key: 'updated-at' })).replace(/^\d\d:\d\d 업데이트/, 'HH:MM 업데이트')
const version = async (ui) => ((await ui.find({ type: 'Box', key: 'updated-at' })).children as Drawn[])[1]

test('머리 줄에 갱신 시각과 작업 트리의 version·커밋, main 의 최신 version 을 보이고 뒤처지면 노란색이다 (R1, R2)', async ($, on) => {
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await head(ui)).toBe('HH:MM 업데이트  ·  fos-skills 작업 트리 1.4.0 (de0cb6d) → 최신 1.5.0 (b1e2c09)')
    expect((await version(ui)).props.color).toBe('yellow')
    // 작업 트리는 claude plugin update 로 갱신하지 않으므로 p 가 없다
    expect(await ui.find({ type: 'Button', key: 'update-plugin' })).toBeFalsy()
    await ui.unmount()
  }
})

test('main 과 version 이 같으면 「최신」 을 흐리게 보인다 (R2)', async ($, on) => {
  await start($, on, { remote: { commit: NEW, version: '1.4.0' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await head(ui)).toBe('HH:MM 업데이트  ·  fos-skills 작업 트리 1.4.0 (de0cb6d) 최신')
  expect((await version(ui)).props.dimColor).toBe(true)
  await ui.unmount()
})

test('main 을 읽지 못하면 「최신 확인 불가」 를 흐리게 보인다 (R2)', async ($, on) => {
  await start($, on, { remote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await head(ui)).toBe('HH:MM 업데이트  ·  fos-skills 작업 트리 1.4.0 (de0cb6d) · 최신 확인 불가')
  expect((await version(ui)).props.dimColor).toBe(true)
  await ui.unmount()
})

test('단축키 줄은 flexWrap 으로 좁은 창에서 다음 줄로 넘긴다 (R4)', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 60 } })
  const row = await ui.find({ type: 'Box', key: 'shortcut-row' })
  expect(row.props.flexWrap).toBe('wrap')
  expect((row.children as Drawn[]).map((button) => button.props.hotkey)).toEqual(['s', 'u', 'q', 'c', 'a', 'd'])
  await ui.unmount()
})

test('상태 줄은 글이 바뀔 때만 보낸다', async ($, on) => {
  const statuses: unknown[] = []
  await start($, on, { statuses })
  // 세션 시작과 /board 열기에서 보드 파일을 두 번 읽었지만 같은 글은 한 번만 보낸다
  expect(statuses.length).toBe(new Set(statuses).size)
})

const CACHE = { kind: 'cache', version: '1.4.0', commit: OLD, scope: 'project', projectPath: '/Users/me', key: 'fos-skills@fos-skills' }
const fake = (result) => {
  const calls: { argv: string[]; init: Record<string, unknown> }[] = []
  const fills: string[] = []
  const toasts: string[] = []
  const $ = {
    plugin: { name: 'fos-skills', root: '/x' },
    process: { run: async (argv, init) => {
      calls.push({ argv, init })
      return result
    } },
    prompt: { fill: async ({ text }) => { fills.push(text) } },
    ui: { toast: (text) => { toasts.push(text) }, invalidate: () => {} },
  }
  return { $, calls, fills, toasts }
}

test('p 는 설치본의 scope 로 claude plugin update 를 돌리고, 성공하면 입력란에 /reload-plugins 를 채운다 (R3)', async () => {
  const { $, calls, fills, toasts } = fake({ exitCode: 0, stdout: 'updated', stderr: '' })
  await updatePlugin($, CACHE)
  expect(calls).toEqual([{ argv: ['claude', 'plugin', 'update', 'fos-skills@fos-skills', '--scope', 'project'], init: { timeoutMs: 180000, cwd: '/Users/me' } }])
  expect(fills).toEqual(['/reload-plugins'])
  expect(toasts.at(-1)).toContain('/reload-plugins')
})

test('갱신이 실패하면 toast 에 이유를 보이고 입력란은 그대로다 (R3)', async () => {
  const { $, fills, toasts } = fake({ exitCode: 1, stdout: '', stderr: 'Plugin "fos-skills@fos-skills" not found' })
  await updatePlugin($, CACHE)
  expect(fills).toEqual([])
  expect(toasts.at(-1)).toBe('플러그인 갱신 실패: Plugin "fos-skills@fos-skills" not found')
})

// directory 설치본: 폴더 상태를 git 으로 보고 받는다. 실제 체크아웃이 아니라 가짜 process.run 이다
const DIR = '/Users/me/personal/fos-skills'
const DIRECTORY = { kind: 'directory', version: '1.4.0', commit: OLD, scope: '', projectPath: '', key: '', dir: DIR }
const fakeDirectory = ({ branch = 'main', dirty = '', fetch = 0, ancestor = 0, pull = 0 } = {}) => {
  const calls: string[][] = []
  const fills: string[] = []
  const toasts: string[] = []
  const out = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr })
  const $ = {
    plugin: { name: 'fos-skills', root: DIR },
    process: { run: async (argv: string[]) => {
      calls.push(argv)
      const verb = argv[3]
      if (verb === 'rev-parse') return out(0, branch + '\n')
      if (verb === 'status') return out(0, dirty)
      if (verb === 'fetch') return out(fetch, '', fetch ? 'fatal: unable to access' : '')
      if (verb === 'merge-base') return out(ancestor)
      if (verb === 'pull') return out(pull, 'Fast-forward', pull ? 'fatal: Not possible to fast-forward' : '')
      return out(1)
    } },
    fs: { read: async () => { throw new Error('없음') } },
    prompt: { fill: async ({ text }) => { fills.push(text) } },
    ui: { toast: (text: string) => { toasts.push(text) }, invalidate: () => {} },
  }
  return { $, calls, fills, toasts }
}
const pulled = (calls: string[][]) => calls.some((argv) => argv[3] === 'pull')

test('main 이고 변경이 없고 fast-forward 할 수 있으면 pull --ff-only 하고 /reload-plugins 를 채운다 (R3)', async () => {
  const { $, calls, fills, toasts } = fakeDirectory()
  await updatePlugin($, DIRECTORY)
  expect(calls.at(-1)).toEqual(['git', '-C', DIR, 'pull', '--ff-only', 'origin', 'main'])
  expect(fills).toEqual(['/reload-plugins'])
  expect(toasts.at(-1)).toContain('/reload-plugins')
})

test('main 이 아니면 받지 않고 toast 에 이유를 보인다 (R3)', async () => {
  const { $, calls, fills, toasts } = fakeDirectory({ branch: 'feat/x' })
  await updatePlugin($, DIRECTORY)
  expect(pulled(calls)).toBe(false)
  expect(fills).toEqual([])
  expect(toasts.at(-1)).toBe('main 이 아니라서 받지 않았어요')
})

test('추적 파일 변경이 있으면 받지 않고 toast 에 이유를 보인다 (R3)', async () => {
  const { $, calls, fills, toasts } = fakeDirectory({ dirty: ' M a.txt\n' })
  await updatePlugin($, DIRECTORY)
  expect(pulled(calls)).toBe(false)
  expect(fills).toEqual([])
  expect(toasts.at(-1)).toBe('고치는 중인 파일이 있어서 받지 않았어요')
})

test('fast-forward 할 수 없으면 받지 않고 toast 에 이유를 보인다 (R3)', async () => {
  const { $, calls, fills, toasts } = fakeDirectory({ ancestor: 1 })
  await updatePlugin($, DIRECTORY)
  expect(pulled(calls)).toBe(false)
  expect(fills).toEqual([])
  expect(toasts.at(-1)).toBe('fast-forward 할 수 없어서 받지 않았어요')
})

test('pull 이 실패하면 갱신 실패 toast 를 보이고 입력란은 그대로다 (R3)', async () => {
  const { $, fills, toasts } = fakeDirectory({ pull: 1 })
  await updatePlugin($, DIRECTORY)
  expect(fills).toEqual([])
  expect(toasts.at(-1)).toBe('플러그인 갱신 실패: fatal: Not possible to fast-forward')
})

// 세션 시작부터 로드 출처 판정을 거친다. ps 는 훅의 조상 claude 한 개를 돌려주는 모의다 (R1, R3, R5)
type Source = 'registered' | 'explicit' | 'ps-fail' | 'ps-throw'
function directorySession(source: Source) {
  const ctx = { installed: '1.4.0', root: '', pulls: 0 }
  const register = ($, on) => {
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('process.run', (_, e) => {
      const argv = e.argv
      const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
      if (argv[0] === 'ps') {
        if (source === 'ps-throw') return { value: { exitCode: 127, stdout: '', stderr: 'ps: not found' } }
        if (source === 'ps-fail') return { value: { exitCode: 1, stdout: '', stderr: 'x' } }
        return ok('1 claude ' + (source === 'explicit' ? '--plugin-dir ' + ctx.root : '--model sonnet') + '\n')
      }
      if (argv[0] === 'realpath') return ok(argv[1] + '\n')
      if (argv[0] === 'sh') return ok(argv[2].includes('PPID') ? '10\n' : '/home/me/.claude')
      if (argv[0] === 'git' && argv.includes('--abbrev-ref')) return ok('main\n')
      if (argv[0] === 'git' && argv.includes('rev-parse') && argv.includes('HEAD')) return ok(ctx.installed === '1.4.0' ? OLD + '\n' : NEW + '\n')
      if (argv[0] === 'git' && argv[1] === 'ls-remote') return ok(NEW + '\trefs/heads/main\n')
      if (argv[0] === 'curl') return ok(MANIFEST('1.5.0'))
      if (argv[0] === 'git' && argv.includes('pull')) { ctx.pulls++; ctx.installed = '1.5.0'; return ok('Fast-forward') }
      if (argv[0] === 'git') return ok('')
      return { value: { exitCode: 1, stdout: '', stderr: '없음' } }
    })
    on('fs.exists', (_, e) => ({ value: e.path === '/repo/.omc/board.json' }))
    on('fs.read', (_, e) => {
      if (e.path.endsWith('/plugins/known_marketplaces.json')) return { value: JSON.stringify({ 'fos-skills': { source: { source: 'directory', path: ctx.root } } }) }
      if (e.path.endsWith('/.claude-plugin/plugin.json')) ctx.root = e.path.slice(0, -'/.claude-plugin/plugin.json'.length)
      return { value: e.path.endsWith('/.claude-plugin/plugin.json') ? MANIFEST(ctx.installed) : BOARD }
    })
    on('clock.now', () => ({ value: Date.parse('2026-10-22T10:05:00+09:00') }))
    on('clock.every', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('prompt.fill', () => ({ isFilled: true }))
  }
  return { ctx, register }
}

test('directory 설치본은 받은 뒤 설치본을 다시 읽어 머리 줄이 새 version 을 보인다 (R5)', async ($, on) => {
  const { register } = directorySession('registered')
  register($, on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await head(ui)).toBe('HH:MM 업데이트  ·  fos-skills 1.4.0 (de0cb6d) → 최신 1.5.0 (b1e2c09) · p 로 갱신')
  await ui.press({ key: 'update-plugin' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await head(ui)).toBe('HH:MM 업데이트  ·  fos-skills 1.5.0 (b1e2c09) 최신')
  await ui.unmount()
})

test('등록된 폴더를 --plugin-dir 로 직접 읽으면 작업 트리라서 p 도 pull 도 없다 (R1, R3)', async ($, on) => {
  const { ctx, register } = directorySession('explicit')
  register($, on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await head(ui)).toBe('HH:MM 업데이트  ·  fos-skills 작업 트리 1.4.0 (de0cb6d) → 최신 1.5.0 (b1e2c09)')
  // p 버튼이 그려지지 않아 누를 수 없다
  await expect(ui.press({ key: 'update-plugin' })).rejects.toThrow()
  expect(ctx.pulls).toBe(0)
  await ui.unmount()
})

for (const source of ['ps-fail', 'ps-throw'] as const) {
  test('로드 출처를 확정하지 못하면(' + source + ') 설치본 확인 불가로 두고 p 도 pull 도 없다 (R1, R3)', async ($, on) => {
    const { ctx, register } = directorySession(source)
    register($, on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const text = await head(ui)
    expect(text).toContain('설치본 확인 불가')
    expect(text).not.toContain('p 로')
    await expect(ui.press({ key: 'update-plugin' })).rejects.toThrow()
    expect(ctx.pulls).toBe(0)
    await ui.unmount()
  })
}
