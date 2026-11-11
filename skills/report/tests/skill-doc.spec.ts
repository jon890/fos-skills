// report 스킬의 공통 틀 부품과 SKILL.md 의 부르는 말, 다른 스킬과 나누는 문장을 잃지 않았는지 본다.
// 스펙 R4(틀의 부품), R1(부르는 말), R8(다른 스킬과 나누는 문장)이다.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'

const SKILL = join(import.meta.dirname, '..')
const R8 = '청중 앞에서 넘기며 말하는 발표는 `presentation`, 외부에 게시할 글은 `content-preview`, 혼자 읽는 설명과 보고서는 `report`'
const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(' ')

describe('공통 틀', () => {
  test('스펙 R4 의 부품이 모두 있다', () => {
    const body = readFileSync(join(SKILL, 'assets', 'template.html'), 'utf8')
    for (const marker of [
      'class="toc"', 'class="top"', 'class="meta"', 'class="lead"', 'class="concl"', 'class="chip y"', 'class="chip p"', 'class="chip n"', 'class="chip x"',
      'class="steps"', 'class="callout"', '<details', 'id="srcbox"', 'class="ref"',
    ]) {
      assert.ok(body.includes(marker), marker)
    }
  })
})

describe('SKILL.md', () => {
  const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8')
  const [, front, ...rest] = text.split('---')
  const description = front.split('description:')[1].split('metadata:')[0]
  const body = rest.join('---')

  test('description 이 부르는 말을 갖는다', () => {
    for (const phrase of ['/report', 'HTML 로 시각화해서 설명', '보고서로 만들어', '한눈에 보이게 정리']) assert.ok(description.includes(phrase), phrase)
  })

  test('description 과 본문이 다른 스킬과 나누는 문장을 갖는다', () => {
    assert.ok(squash(description).includes(R8))
    assert.ok(body.includes(R8))
  })
})

test('작성 단계에서 연결한 참조 문서를 열 수 있다', () => {
  const pending = [join(SKILL, 'SKILL.md')]
  const visited = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const body = readFileSync(file, 'utf8')
    for (const match of body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1]
      if (/^[a-z]+:/i.test(target)) continue
      const linked = resolve(dirname(file), target)
      assert.ok(existsSync(linked), `${file}: ${target}`)
      if (linked.endsWith('.md')) pending.push(linked)
    }
  }
})
