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
  expect((row.children as Drawn[]).map((button) => button.props.hotkey)).toEqual(['s', 'u', 'q', 'a', 'd'])
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
