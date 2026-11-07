// check_duplication 의 명령 경계 테스트. 파일 사이에서 연속으로 겹치는 줄을 찾는 정규화와 정렬, 출력 꼴, 종료 코드를 본다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Repo } from './helpers.ts'

const WARNING =
  '\n주의 — 이 검사는 줄 단위 문자열 일치만 본다.\n0건은 의미 중복이 없다는 뜻이 아니다. 같은 규칙을 문서마다 다르게 표현해 두면 잡히지 않는다.\n같은 개념(레이어 경계, 배포 정책, 검증 순서 등)을 언급하는 파일이 몇 개인지는 사람이 센다.'

const LINES = ['배포는 항상 PR 로 한다고 적어 둔다', '머지 전에 테스트를 돌려야 한다고 적었다', '브랜치 이름은 영문 소문자로 짓는다고 한다', '커밋은 관심사별로 나눈다고 문서에 있다', '푸시 전에 원격을 먼저 받아 온다고 한다']

describe('중복 구간', () => {
  test('겹침이 없으면 0건과 주의 문구와 종료 코드 0', () => {
    const r = new Repo()
    r.file('AGENTS.md', `${LINES.join('\n')}\n`)
    r.file('CLAUDE.md', '전혀 다른 내용이 여기에 들어 있다 길다\n')
    const done = r.run('check_duplication', [r.root])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `연속 3줄 이상 중복 0건\n${WARNING}\n`)
  })

  test('두 파일 사이의 연속 일치는 보고하고 1 로 끝난다', () => {
    const r = new Repo()
    r.file('AGENTS.md', `# 가\n${LINES.join('\n')}\n끝 줄은 다르다 길게 쓴다\n`)
    r.file('CLAUDE.md', `# 나\n${LINES.slice(1, 5).join('\n')}\n다른 끝 줄을 길게 쓴다\n`)
    const done = r.run('check_duplication', [r.root])
    assert.equal(done.code, 1)
    assert.equal(
      done.stdout,
      `중복 구간 1건 (합계 4줄)\n\n    4줄  AGENTS.md:3  ↔  CLAUDE.md:2\n         "${LINES[1]}"\n\n어느 쪽이 단일 소스인지 정하고 나머지는 그 문서를 가리키게 바꾼다.\n${WARNING}\n`,
    )
  })

  test('최소 연속 줄 수를 위치 인자로 준다', () => {
    const r = new Repo()
    r.file('AGENTS.md', `${LINES.slice(0, 4).join('\n')}\n`)
    r.file('CLAUDE.md', `${LINES.slice(0, 4).join('\n')}\n`)
    assert.equal(r.run('check_duplication', [r.root, '5']).code, 0)
    assert.ok(r.run('check_duplication', [r.root, '5']).stdout.startsWith('연속 5줄 이상 중복 0건\n'))
    assert.equal(r.run('check_duplication', [r.root, '4']).code, 1)
  })

  test('공백 차이는 같은 줄로 보고 짧은 줄과 표 구분선과 태그와 펜스 줄은 뺀다', () => {
    const r = new Repo()
    r.file('AGENTS.md', `배포는   항상 PR 로    한다고 적어 둔다\n짧은 줄\n| --- | --- |\n<details>\n\`\`\`bash\n${LINES[1]}\n${LINES[2]}\n`)
    r.file('CLAUDE.md', `${LINES[0]}\n짧은 줄\n| --- | --- |\n<details>\n\`\`\`bash\n${LINES[1]}\n${LINES[2]}\n`)
    const done = r.run('check_duplication', [r.root, '1'])
    assert.equal(done.code, 1)
    assert.ok(done.stdout.includes('중복 구간'), done.stdout)
    assert.ok(!done.stdout.includes('짧은 줄'))
    assert.ok(!done.stdout.includes('| --- |'))
  })

  test('프런트매터는 비교에서 뺀다', () => {
    const r = new Repo()
    const fm = '---\nname: aaaa-bbbb-cccc-dddd-eeee\ndescription: 같은 설명이 길게 여기에 적혀 있다\n---\n'
    r.file('skills/a/SKILL.md', `${fm}본문 A 는 서로 다르다고 길게 적는다\n`)
    r.file('skills/b/SKILL.md', `${fm}본문 B 도 서로 다르다고 길게 적는다\n`)
    const done = r.run('check_duplication', [r.root, '1'])
    assert.equal(done.code, 0, done.stdout)
  })

  test('같은 파일 안의 반복은 세지 않는다', () => {
    const r = new Repo()
    r.file('AGENTS.md', `${LINES.slice(0, 3).join('\n')}\n${LINES.slice(0, 3).join('\n')}\n`)
    assert.equal(r.run('check_duplication', [r.root]).code, 0)
  })

  test('구간은 긴 순으로 내고 스물다섯 개까지만 보여 준다', () => {
    const r = new Repo()
    const block = (n: number, len: number) => Array.from({ length: len }, (_, i) => `구간 ${n} 의 ${i} 번째 줄은 길게 적어 둔다`).join('\n')
    let a = ''
    let b = ''
    for (let n = 0; n < 27; n++) {
      a += `${block(n, 3 + (n % 4))}\n서로 다른 사이 줄 A${n} 는 길게 적어 둔다\n`
      b += `${block(n, 3 + (n % 4))}\n서로 다른 사이 줄 B${n} 는 길게 적어 둔다\n`
    }
    r.file('AGENTS.md', a)
    r.file('CLAUDE.md', b)
    const done = r.run('check_duplication', [r.root])
    assert.equal(done.code, 1)
    assert.ok(done.stdout.startsWith('중복 구간 27건 (합계 '), done.stdout.slice(0, 40))
    const rows = done.stdout.split('\n').filter((l) => l.includes('  ↔  '))
    assert.equal(rows.length, 25)
    const lens = rows.map((l) => Number(l.trim().split('줄')[0]))
    assert.deepEqual(lens, [...lens].sort((x, y) => y - x))
  })

  test('대상 파일이 없으면 2', () => {
    const r = new Repo()
    r.file('data.txt', 'x\n')
    const done = r.run('check_duplication', [r.root])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '대상 파일을 찾지 못했다 — repo root 에서 실행하는지 확인하라\n')
    assert.equal(done.stdout, '')
  })

  test('--scope 는 비교 파일을 제한하고 틀리면 2', () => {
    const r = new Repo()
    r.file('a/AGENTS.md', `${LINES.join('\n')}\n`)
    r.file('b/AGENTS.md', `${LINES.join('\n')}\n`)
    r.file('c/AGENTS.md', '다른 내용이다 아주 길게 적어 둔다 정말\n')
    assert.equal(r.run('check_duplication', [r.root, '--scope', 'a']).code, 0)
    assert.equal(r.run('check_duplication', [r.root, '--scope=a']).code, 0)
    assert.equal(r.run('check_duplication', [r.root, '--scope', '.']).code, 1)
    const bad = r.run('check_duplication', [r.root, '--scope', 'zz'])
    assert.equal(bad.code, 2)
    assert.equal(bad.stderr, '범위 경로가 없다: zz\n')
  })

  test('최소 줄 수가 숫자가 아니면 오류 종료한다', () => {
    const r = new Repo()
    r.file('AGENTS.md', 'x\n')
    const done = r.run('check_duplication', [r.root, 'abc'])
    assert.notEqual(done.code, 0)
    assert.equal(done.stdout, '')
  })
})
