// ego 백엔드가 ego-browser 의 stdin 으로 넘기는 Node 스크립트를 글자까지 본다.
// 옛 구현이 낸 스크립트를 fixtures/ego-scripts.json 에 적어 두고, 명령마다 같은 글자가 나오는지 비교한다.
// 스크립트는 ego 가 해석하는 코드라 공백과 따옴표, 이스케이프까지 같아야 한다. 실제 브라우저는 열지 않는다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Box, egoOut, golden, type EnvChange, type T } from './helpers.ts'

function script(t: T, args: string[], env: EnvChange = {}, config?: unknown): string {
  const box = new Box(t)
  box.env.BROWSER_DRIVER = 'ego'
  const fake = box.fake('ego-browser', [{ stdout: egoOut('9:p1\tDefault\tPersonal\tbrowser-driver/Default') }])
  if (config !== undefined) box.setConfig(config)
  const done = box.run(args, env)
  // 인자 검사로 막힌 호출은 스크립트가 없다
  const calls = fake.calls()
  assert.ok(calls.length <= 1, `${args.join(' ')}: ${done.stderr}`)
  return calls.length ? calls[0].stdin : `(호출 없음) 종료 코드 ${done.code}`
}

const STRANGE = `a"b'c\\d\n\te f\u007fg한글😀</script>\u0001\u001f`

describe('ego 스크립트', () => {
  const cases: [string, string[], EnvChange?, unknown?][] = [
    ['open', ['open', 'https://example.com/a?b=c&d=한글']],
    ['open-timeout', ['open', 'about:blank', '777']],
    ['open-profile', ['open', 'about:blank'], { BROWSER_EGO_PROFILE: 'Profile 2' }],
    ['open-purpose', ['open', 'about:blank'], { BROWSER_EGO_PURPOSE: 'work' }, { egoProfiles: { work: 'Profile 3' } }],
    ['open-default-profile', ['open', 'about:blank'], {}, { egoProfiles: { default: 'Profile "9"' } }],
    ['open-space', ['open', 'about:blank'], { BROWSER_EGO_SPACE: '월 "공수"\\등록' }],
    ['open-strange-url', ['open', STRANGE]],
    ['nav', ['nav', '3:p2', 'https://example.com']],
    ['nav-timeout', ['nav', '3:p2', 'https://example.com', '1500']],
    ['nav-strange', ['nav', '3:p2', STRANGE]],
    ['js', ['js', '3:p2', 'document.title']],
    ['js-timeout', ['js', '3:p2', 'document.title', '--timeout', '45000']],
    ['js-strange', ['js', '3:p2', STRANGE]],
    ['js-multiline', ['js', '3:p2', 'const a = 1;\nawait a;\n// 끝']],
    ['waitjs', ['waitjs', '3:p2', "document.querySelector('#x')"]],
    ['waitjs-timeout', ['waitjs', '3:p2', 'window.ready', '2500']],
    ['waitjs-strange', ['waitjs', '3:p2', STRANGE]],
    ['ready', ['ready', '3:p2']],
    ['ready-timeout', ['ready', '3:p2', '99']],
    ['url', ['url', '3:p2']],
    ['snap', ['snap', '3:p2']],
    ['shot', ['shot', '3:p2', '/tmp/bd-shot.png']],
    ['shot-default', ['shot', '3:p2']],
    ['shot-strange', ['shot', '3:p2', STRANGE]],
    ['close', ['close', '3:p2']],
    ['pages', ['pages']],
    ['pages-profile', ['pages', 'Profile 2']],
    ['pages-space', ['pages'], { BROWSER_EGO_SPACE: '작업' }],
    ['spaces', ['spaces']],
    ['spaces-prefix', ['spaces', 'fos "확인"']],
    ['reset', ['reset'], { BROWSER_EGO_SPACE: '작업' }],
    ['reset-profile', ['reset', 'Profile 2'], { BROWSER_EGO_SPACE: '작업' }],
    ['reset-purpose', ['reset'], { BROWSER_EGO_SPACE: '작업', BROWSER_EGO_PURPOSE: 'work' }, { egoProfiles: { work: 'Profile 3' } }],
    ['reset-id', ['reset', '--space-id', '12']],
    ['click', ['click', '3:p2', '10', '20.5']],
    ['click-button', ['click', '3:p2', '10', '20', '--button', 'middle']],
    ['hover', ['hover', '3:p2', '1e3', '-4']],
    ['drag', ['drag', '3:p2', '1', '2', '3', '4', '--button', 'right']],
  ]
  for (const [key, args, env, config] of cases) {
    test(key, (t) => {
      golden('ego-scripts.json', key, script(t, args, env, config))
    })
  }
})
