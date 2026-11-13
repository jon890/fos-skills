// templates/spec-common.md 의 명령 블록이 `orch …` 만 쓰고 실행기 경로 풀기를 되풀이하지 않는지 본다.
// 실행기를 PATH 에 두는 일은 worker 를 띄우는 쪽이 맡는다(worker-path.spec.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../templates/spec-common.md', import.meta.url))

function template(): string {
  return readFileSync(TEMPLATE, 'utf8')
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

  test('틀에 실행기 경로를 푸는 셸 함수나 설치 기록 읽기가 없고, 블록은 orch 만 부른다', () => {
    assert.doesNotMatch(template(), /command -v orch|installed_plugins|CLAUDE_CONFIG_DIR|_o=|return 3/)
    assert.doesNotMatch(template(), /ORCH_SCRIPTS|\$SKILL_DIR|bin\/orch\.ts/)
    const item = (marker: string) => template().split('\n- ').find((part) => part.includes(`<!-- orch-rule: ${marker} -->`)) ?? ''
    assert.match(item('migration'), /\n {2}orch queue reserve --repo "\$\(git rev-parse --show-toplevel\)" --module "\$MODULE" --name "\$NAME"\n/)
    assert.match(item('adr'), /\n {2}orch queue reserve --repo "\$\(git rev-parse --show-toplevel\)" --kind adr --module "\$MODULE" --name "\$NAME"\n/)
    assert.match(item('worker-ask'), /\n {2}orch worker ask --from "\$FROM" --question "\$QUESTION"\n/)
    assert.match(item('feedback-add'), /\n {2}orch feedback add --slug /)
    assert.match(item('study-add'), /\n {2}orch study add --slug /)
  })

  test('orch 를 부르는 블록은 변수 지정 뒤 바로 orch 명령 한 줄이다', () => {
    const blocks = [...template().matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]).filter((text) => /^\s*orch\s/m.test(text))
    assert.ok(blocks.length >= 5)
    for (const block of blocks) {
      const lines = block.split('\n').filter((line) => line.trim() !== '')
      assert.match(lines.at(-1)!, /^\s*orch /)
      assert.ok(lines.slice(0, -1).every((line) => /^\s*[A-Z_]+=""$/.test(line)), block)
    }
  })

  test('공통 규칙 문단에 PATH 와 실행기 풀기 설명이 없다', () => {
    const ask = template().split('\n').find((line) => line.includes('<!-- orch-rule: worker-ask -->')) ?? ''
    assert.match(ask, /`orch worker ask`/)
    assert.doesNotMatch(ask, /PATH|실행기|installPath|셸 함수/)
    assert.doesNotMatch(template(), /PATH 에 `orch`/)
  })
})


test('리뷰 workflow 변경 예외를 worker 와 코디네이터 지침이 함께 제공한다', () => {
  const policy = template().split('\n').find((line) => line.includes('<!-- orch-rule: review-workflow -->'))
  assert.ok(policy, '낡은 공통 지시서를 검사할 정책 표지가 필요하다')
  const replying = readFileSync(new URL('../references/replying.md', import.meta.url), 'utf8')
  for (const text of [policy, replying]) {
    assert.match(text, /workflow/)
    assert.match(text, /Ready 뒤 자동 리뷰를 기다리지 않고 코디네이터에게 독립 리뷰를 요청/)
    assert.match(text, /review-fix/)
  }
})
