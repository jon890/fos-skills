// 플러그인 버전 표시와 갱신 명령을 정하는 순수 함수를 본다. 화면은 version.test.ts 가 본다.
//
// 실행: node --test work-board/tests/version.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  configDirOf, directoryMarketplaceOf, isClaudeCommand, pluginDirValues, resolvePath, directoryRefusal, installOf, parseLsRemote, rawManifestUrl, updateCommand, updateVisible, versionLabel, versionState, versionText,
} from '../hooks/register.js'

const CONFIG = '/Users/me/.claude'
const USER_ROOT = CONFIG + '/plugins/cache/fos-skills/fos-skills/1.4.0'
const PROJECT_ROOT = CONFIG + '/plugins/cache/fos-skills/fos-skills/de0cb6d67b92'
const OLD = 'de0cb6d67b9259b40a33d68e093fb511e256b005'
const NEW = 'b1e2c09d5b5abed277ce7593e2a601f9d2e739d6'
const INSTALLED = { version: 2, plugins: {
  'fos-skills@fos-skills': [
    { scope: 'user', installPath: USER_ROOT, version: '1.4.0', gitCommitSha: NEW },
    { scope: 'project', projectPath: '/Users/me', installPath: PROJECT_ROOT, version: 'de0cb6d67b92', gitCommitSha: OLD },
  ],
  'other@fos-skills': [{ scope: 'user', installPath: USER_ROOT, gitCommitSha: 'x' }],
} }

test('마켓플레이스 캐시 폴더에서 설정 폴더를 뽑고, 캐시가 아니면 빈 값이다 (R1)', () => {
  assert.equal(configDirOf(USER_ROOT), CONFIG)
  assert.equal(configDirOf('/Users/me/personal/fos-skills'), '')
})

test('설치본은 installPath 가 같은 기록에서 scope 와 커밋을 읽고, version 은 설치본 plugin.json 에서 읽는다 (R1)', () => {
  assert.deepEqual(installOf(PROJECT_ROOT, INSTALLED, { name: 'fos-skills' }, 'fos-skills'),
    { kind: 'cache', version: '', commit: OLD, scope: 'project', projectPath: '/Users/me', key: 'fos-skills@fos-skills' })
  assert.equal(installOf(USER_ROOT, INSTALLED, { name: 'fos-skills', version: '1.4.0' }, 'fos-skills')?.version, '1.4.0')
  assert.equal(installOf(CONFIG + '/plugins/cache/fos-skills/fos-skills/zzz', INSTALLED, {}, 'fos-skills'), null)
  assert.deepEqual(installOf('/work/fos-skills', null, { version: '1.4.0' }, 'fos-skills'),
    { kind: 'tree', version: '1.4.0', commit: '', scope: '', projectPath: '', key: '' })
})

const PROFILE_A = '/Users/me/Library/Application Support/orca/claude-profiles/18c49fc3/home'
const PROFILE_B = '/Users/me/Library/Application Support/orca/claude-profiles/7ba02f76/home'
const PROFILE_ROOT = PROFILE_A + '/plugins/cache/fos-skills/fos-skills/1.4.0'
const ALIAS_ROOT = PROFILE_B + '/plugins/cache/fos-skills/fos-skills/1.4.0'
const records = (entries) => ({ plugins: { 'fos-skills@fos-skills': entries } })

test('다른 Orca 프로필의 같은 캐시 설치본을 찾고 현재 프로필의 설정 폴더를 유지한다 (R1, R3)', () => {
  const install = installOf(PROFILE_ROOT, records([
    { scope: 'project', projectPath: '/Users/me', installPath: ALIAS_ROOT, gitCommitSha: NEW },
  ]), { version: '1.4.0' }, 'fos-skills')
  assert.equal(configDirOf(PROFILE_ROOT), PROFILE_A)
  assert.deepEqual(install, { kind: 'cache', version: '1.4.0', commit: NEW, scope: 'project',
    projectPath: '/Users/me', key: 'fos-skills@fos-skills' })
  assert.deepEqual(updateCommand(install), {
    argv: ['claude', 'plugin', 'update', 'fos-skills@fos-skills', '--scope', 'project'], cwd: '/Users/me',
  })
})

test('정확한 경로는 다른 키에 있는 user scope 의 대체 경로보다 먼저 고른다 (R1, R3)', () => {
  const installed = { plugins: {
    'fos-skills@other': [{ scope: 'user', installPath: ALIAS_ROOT, gitCommitSha: OLD }],
    'fos-skills@fos-skills': [{ scope: 'local', projectPath: '/repo', installPath: PROFILE_ROOT, gitCommitSha: NEW }],
  } }
  const install = installOf(PROFILE_ROOT, installed, {}, 'fos-skills')
  assert.equal(install?.commit, NEW)
  assert.deepEqual(updateCommand(install), {
    argv: ['claude', 'plugin', 'update', 'fos-skills@fos-skills', '--scope', 'local'], cwd: '/repo',
  })
})

test('같은 꼬리의 대체 경로가 겹치면 user scope 를 먼저 고르고 없으면 기록 순서다 (R3)', () => {
  const project = { scope: 'project', projectPath: '/repo', installPath: ALIAS_ROOT, gitCommitSha: OLD }
  const local = { ...project, scope: 'local' }
  const user = { scope: 'user', installPath: ALIAS_ROOT, gitCommitSha: NEW }
  const install = installOf(PROFILE_ROOT, records([project, user]), {}, 'fos-skills')
  assert.deepEqual(updateCommand(install), {
    argv: ['claude', 'plugin', 'update', 'fos-skills@fos-skills', '--scope', 'user'], cwd: '',
  })
  assert.equal(installOf(PROFILE_ROOT, records([local, project]), {}, 'fos-skills')?.scope, 'local')
})

test('캐시의 마켓, 플러그인, 버전이 다르거나 캐시가 아닌 경로는 대체하지 않는다 (R1)', () => {
  for (const installPath of [
    ALIAS_ROOT.replace('/1.4.0', '/1.3.0'),
    ALIAS_ROOT.replace('/cache/fos-skills/', '/cache/other/'),
    ALIAS_ROOT.replace('/fos-skills/1.4.0', '/other/1.4.0'),
    '/work/fos-skills/1.4.0', undefined,
  ]) {
    assert.equal(installOf(PROFILE_ROOT, records([null, { scope: 'user', installPath }]), {}, 'fos-skills'), null)
  }
})

test('ls-remote 출력에서 main 커밋을 읽고, 없으면 던진다', () => {
  assert.equal(parseLsRemote(NEW + '\trefs/heads/main\n'), NEW)
  assert.throws(() => parseLsRemote(''), /main 커밋/)
})

test('GitHub 저장소만 그 커밋의 plugin.json 원문 주소를 만든다', () => {
  assert.equal(rawManifestUrl('https://github.com/jon890/fos-skills', NEW),
    'https://raw.githubusercontent.com/jon890/fos-skills/' + NEW + '/.claude-plugin/plugin.json')
  assert.equal(rawManifestUrl('https://github.com/jon890/fos-skills.git', NEW),
    'https://raw.githubusercontent.com/jon890/fos-skills/' + NEW + '/.claude-plugin/plugin.json')
  assert.equal(rawManifestUrl('https://gitlab.com/a/b', NEW), '')
})

test('둘 다 version 이 있으면 version 으로, 아니면 커밋으로 최신 여부를 정한다 (R2)', () => {
  const install = { kind: 'cache', version: '1.4.0', commit: OLD }
  assert.equal(versionState(install, { commit: NEW, version: '1.4.0' }), 'latest')
  assert.equal(versionState(install, { commit: NEW, version: '1.5.0' }), 'behind')
  assert.equal(versionState({ ...install, version: '' }, { commit: OLD, version: '1.5.0' }), 'latest')
  assert.equal(versionState({ ...install, version: '' }, { commit: NEW, version: '' }), 'behind')
  assert.equal(versionState(install, { error: '시간 초과' }), 'unknown')
  assert.equal(versionState(install, undefined), 'unknown')
  assert.equal(versionState(null, { commit: NEW, version: '1.4.0' }), 'unknown')
})

test('버전 글은 「version (커밋 7자리)」 이고 빠진 쪽은 생략한다', () => {
  assert.equal(versionText('1.4.0', NEW), '1.4.0 (b1e2c09)')
  assert.equal(versionText('', NEW), 'b1e2c09')
  assert.equal(versionText('1.4.0', ''), '1.4.0')
})

test('머리 줄 버전 글: 최신은 흐리게, 뒤처지면 노란색과 「p 로 갱신」, 확인하지 못하면 흐린 「최신 확인 불가」 (R2)', () => {
  const install = { kind: 'cache', version: '1.4.0', commit: OLD, scope: 'user', projectPath: '', key: 'fos-skills@fos-skills' }
  assert.deepEqual(versionLabel('fos-skills', install, { commit: OLD, version: '1.4.0' }),
    { text: 'fos-skills 1.4.0 (de0cb6d) 최신', color: undefined, dim: true })
  assert.deepEqual(versionLabel('fos-skills', install, { commit: NEW, version: '1.5.0' }),
    { text: 'fos-skills 1.4.0 (de0cb6d) → 최신 1.5.0 (b1e2c09) · p 로 갱신', color: 'yellow', dim: false })
  assert.deepEqual(versionLabel('fos-skills', install, { error: '시간 초과' }),
    { text: 'fos-skills 1.4.0 (de0cb6d) · 최신 확인 불가', color: undefined, dim: true })
  assert.equal(versionLabel('fos-skills', install, undefined).text, 'fos-skills 1.4.0 (de0cb6d) · 최신 확인 중')
  assert.equal(versionLabel('fos-skills', { kind: 'tree', version: '1.4.0', commit: OLD }, { commit: NEW, version: '1.5.0' }).text,
    'fos-skills 작업 트리 1.4.0 (de0cb6d) → 최신 1.5.0 (b1e2c09)')
  assert.equal(versionLabel('fos-skills', null, undefined, '기록 없음').text, 'fos-skills 설치본 확인 불가: 기록 없음')
})

test('갱신 명령은 그 설치본의 scope 를 붙이고, project scope 는 그 프로젝트 폴더에서 돈다 (R3)', () => {
  const user = { kind: 'cache', version: '', commit: NEW, scope: 'user', projectPath: '', key: 'fos-skills@fos-skills' }
  assert.deepEqual(updateCommand(user), { argv: ['claude', 'plugin', 'update', 'fos-skills@fos-skills', '--scope', 'user'], cwd: '' })
  assert.deepEqual(updateCommand({ ...user, scope: 'project', projectPath: '/Users/me' }),
    { argv: ['claude', 'plugin', 'update', 'fos-skills@fos-skills', '--scope', 'project'], cwd: '/Users/me' })
  assert.equal(updateCommand({ kind: 'tree', version: '', commit: NEW, scope: '', projectPath: '', key: '' }), null)
})

test('p 는 갱신할 수 있는 설치본이 최신으로 확인되지 않았을 때만 보인다 (R3)', () => {
  const user = { kind: 'cache', version: '', commit: OLD, scope: 'user', projectPath: '', key: 'fos-skills@fos-skills' }
  assert.equal(updateVisible(user, { commit: OLD, version: '' }), false)
  assert.equal(updateVisible(user, { commit: NEW, version: '' }), true)
  assert.equal(updateVisible(user, { error: '오프라인' }), true)
  assert.equal(updateVisible({ ...user, kind: 'tree', key: '', scope: '' }, { commit: NEW, version: '' }), false)
})

const KNOWN = {
  'fos-skills': { source: { source: 'directory', path: '/Users/me/personal/fos-skills' }, installLocation: '/Users/me/personal/fos-skills' },
  other: { source: { source: 'github', repo: 'a/b' }, installLocation: '/x' },
}
const DIRECTORY = { kind: 'directory', version: '1.4.0', commit: OLD, scope: '', projectPath: '', key: '', dir: '/Users/me/personal/fos-skills' }

test('directory 소스 마켓플레이스의 폴더를 읽은 설치본은 tree 와 구분해 폴더 경로를 든다 (R1)', () => {
  assert.equal(directoryMarketplaceOf('/Users/me/personal/fos-skills/', KNOWN), '/Users/me/personal/fos-skills')
  assert.equal(directoryMarketplaceOf('/work/other-checkout', KNOWN), '')
  assert.equal(directoryMarketplaceOf('/x', KNOWN), '')
  assert.deepEqual(installOf('/Users/me/personal/fos-skills', null, { version: '1.4.0' }, 'fos-skills', KNOWN),
    { kind: 'directory', version: '1.4.0', commit: '', scope: '', projectPath: '', key: '', dir: '/Users/me/personal/fos-skills' })
  // --plugin-dir 로 읽은 다른 작업 트리나 known 을 못 읽은 경우는 tree 다
  assert.equal(installOf('/work/fos-skills', null, {}, 'fos-skills', KNOWN)?.kind, 'tree')
  assert.equal(installOf('/Users/me/personal/fos-skills', null, {}, 'fos-skills', null)?.kind, 'tree')
})

test('directory 설치본이 뒤처지면 머리 줄에 「p 로 갱신」 을 보이고, 작업 트리는 보이지 않는다 (R2)', () => {
  const label = versionLabel('fos-skills', DIRECTORY, { commit: NEW, version: '1.5.0' })
  assert.equal(label.text, 'fos-skills 1.4.0 (de0cb6d) → 최신 1.5.0 (b1e2c09) · p 로 갱신')
  assert.equal(label.color, 'yellow')
  assert.ok(updateVisible(DIRECTORY, { commit: NEW, version: '1.5.0' }))
  assert.ok(!updateVisible(DIRECTORY, { commit: NEW, version: '1.4.0' }))
  assert.ok(!versionLabel('fos-skills', { ...DIRECTORY, kind: 'tree' }, { commit: NEW, version: '1.5.0' }).text.includes('p 로'))
})

test('directory 설치본의 갱신 명령은 그 폴더에서 origin main 을 fast-forward 로만 받는다 (R3)', () => {
  assert.deepEqual(updateCommand(DIRECTORY), {
    argv: ['git', '-C', '/Users/me/personal/fos-skills', 'pull', '--ff-only', 'origin', 'main'], cwd: '',
  })
})

test('main 이 아니거나 추적 파일 변경이 있으면 받지 않는 이유를 돌려준다 (R3)', () => {
  assert.equal(directoryRefusal('main\n', ''), '')
  assert.match(directoryRefusal('feat/x\n', ''), /main 이 아니/)
  assert.match(directoryRefusal('main\n', ' M work-board/hooks/register.js\n'), /고치는 중인 파일/)
})

test('claude 명령 줄만 고르고 --plugin-dir 값은 공백·따옴표·등호 형식을 따른다 (R1, R3)', () => {
  assert.equal(isClaudeCommand('/usr/local/bin/claude --model opus'), true)
  assert.equal(isClaudeCommand('node /x/bin/claude --plugin-dir /a'), true)
  assert.equal(isClaudeCommand('vim notes-claude.txt'), false)
  assert.equal(isClaudeCommand('grep claude --plugin-dir /a'), false)
  assert.deepEqual(pluginDirValues('claude --plugin-dir /a/b --model opus'), ['/a/b'])
  assert.deepEqual(pluginDirValues('claude --plugin-dir=/a/b/'), ['/a/b/'])
  assert.deepEqual(pluginDirValues('claude --plugin-dir "/a/space dir" --x'), ['/a/space dir'])
  assert.deepEqual(pluginDirValues('claude --plugin-dir /a/space dir --model opus'), ['/a/space dir'])
  assert.deepEqual(pluginDirValues('claude --plugin-dir ./rel --plugin-dir /b'), ['./rel', '/b'])
  assert.deepEqual(pluginDirValues('claude --model opus'), [])
  assert.equal(resolvePath('/w/p', './x/../y'), '/w/p/y')
  assert.equal(resolvePath('/w', '/a//b/'), '/a/b')
})

test('--plugin-dir 로 직접 읽는 tree 는 p 도 갱신 명령도 없다 (R1, R3)', () => {
  const root = '/Users/me/personal/fos-skills'
  const install = installOf(root, null, { version: '1.4.0' }, 'fos-skills', KNOWN, true)
  assert.equal(install?.kind, 'tree')
  assert.ok(!updateVisible(install, { commit: NEW, version: '1.5.0' }))
  assert.ok(!versionLabel('fos-skills', install, { commit: NEW, version: '1.5.0' }).text.includes('p 로'))
  assert.equal(updateCommand(install), null)
})
