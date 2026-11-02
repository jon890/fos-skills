// 플러그인 버전 표시와 갱신 명령을 정하는 순수 함수를 본다. 화면은 version.test.ts 가 본다.
//
// 실행: node --test work-board/tests/version.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  configDirOf, installOf, parseLsRemote, rawManifestUrl, updateCommand, updateVisible, versionLabel, versionState, versionText,
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
