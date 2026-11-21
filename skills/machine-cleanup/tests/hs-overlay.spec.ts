// hs_overlay.ts 가 개인 오버레이를 따라가 fos-home-infra 오버레이를 읽고, 없거나 틀리면 홈서버를 막는지 본다(스펙 REQ11, REQ12).

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'
import { overlayMarkdown, sampleConfig } from './hs-helpers.ts'
import { jsonBlock, pointerPath, validate } from '../scripts/hs_overlay.ts'

describe('hs_overlay 내부 함수', () => {
  test('개인 오버레이의 줄에서 경로를 읽고 ~/ 를 푼다', () => {
    assert.equal(pointerPath('# 맥\n- 앱 A 는 빼기\nfos-home-infra 오버레이: ~/infra/.claude/machine-cleanup-overlay.md\n', '/Users/me'), '/Users/me/infra/.claude/machine-cleanup-overlay.md')
    assert.equal(pointerPath('fos-home-infra 오버레이: `/x/y.md`', '/h'), '/x/y.md')
    assert.equal(pointerPath('없음', '/h'), null)
  })

  test('JSON 블록이 없으면 형식 오류다', () => {
    assert.throws(() => jsonBlock('# 제목\n값 없음\n'), /json 코드 블록이 없다/)
  })

  test('필수 키가 빠지면 틀린 곳을 모두 알린다', () => {
    const cfg = sampleConfig('/r')
    delete cfg.lock
    cfg.daily_prune = '3시'
    cfg.hermes.delete = ['x']
    assert.throws(() => validate(cfg), (e: Error) => /lock/.test(e.message) && /daily_prune/.test(e.message) && /\{session\}/.test(e.message))
  })
})

describe('hs_overlay 명령', () => {
  test('개인 오버레이가 가리킨 파일을 검사해 JSON 으로 낸다', () => {
    const box = new Sandbox('hso-')
    const infra = write(join(box.root, 'infra/.claude/machine-cleanup-overlay.md'), overlayMarkdown(sampleConfig(box.root)))
    write(join(box.home, '.claude/overlays/machine-cleanup.md'), `# 맥 예외\nfos-home-infra 오버레이: ${infra}\n`)
    const out = join(box.root, 'cfg.json')
    const r = box.run('hs_overlay', ['--json-out', out])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).host, 'example-host')
  })

  test('개인 오버레이에 그 줄이 없으면 1 로 끝나고 홈서버를 하지 않는다고 알린다', () => {
    const box = new Sandbox('hso-')
    write(join(box.home, '.claude/overlays/machine-cleanup.md'), '# 맥 예외만\n')
    const r = box.run('hs_overlay')
    assert.equal(r.code, 1)
    assert.match(r.stderr, /홈서버 오버레이를 찾지 못함/)
    assert.match(r.stderr, /홈서버는 조사도 정리도 하지 않는다/)
  })

  test('가리킨 파일이 없으면 1, 형식이 틀리면 3 이다', () => {
    const box = new Sandbox('hso-')
    assert.equal(box.run('hs_overlay', ['--overlay', join(box.root, 'none.md')]).code, 1)
    const bad = write(join(box.root, 'bad.md'), overlayMarkdown({ host: 'h' }))
    const r = box.run('hs_overlay', ['--overlay', bad])
    assert.equal(r.code, 3)
    assert.match(r.stderr, /형식 오류/)
  })
})
