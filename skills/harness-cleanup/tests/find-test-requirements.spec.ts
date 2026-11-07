// find_test_requirements 의 명령 경계 테스트. 테스트가 요구하는 문자열만 찾는지, 후보 파일 선택과 단계 구분을 본다.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Repo, type Result } from './helpers.ts'

function base(): Repo {
  const r = new Repo('hc-ftr-')
  r.file('tests/check.sh', 'grep -q "## 일곱 단계" SKILL.md\n')
  r.file('skills/a/SKILL.md', '## 일곱 단계\n## 언제 쓰나\n')
  return r
}
const find = (r: Repo, ...args: string[]): Result => r.run('find_test_requirements', [r.root, ...args])

describe('테스트가 요구하는 문자열', () => {
  test('테스트 파일에 있는 문자열은 근거로 낸다', () => {
    const r = base()
    const done = find(r, '## 일곱 단계')
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, '테스트 파일 1개에서 1개 문자열을 찾는다\n\n"## 일곱 단계"\n  테스트가 요구: tests/check.sh:1  grep -q "## 일곱 단계" SKILL.md\n')
  })

  test('문서에만 있는 문자열은 없음이다', () => {
    const r = base()
    const done = find(r, '## 언제 쓰나')
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '테스트 파일 1개에서 1개 문자열을 찾는다\n\n"## 언제 쓰나"\n  없음\n')
  })

  test('문자열마다 따로 보고한다', () => {
    const r = base()
    const done = find(r, '## 일곱 단계', '## 언제 쓰나')
    assert.equal(done.stdout.split('테스트가 요구').length - 1, 1)
    assert.equal(done.stdout.split('없음').length - 1, 1)
    assert.ok(done.stdout.startsWith('테스트 파일 1개에서 2개 문자열을 찾는다\n'))
  })

  test('fixture 와 CI 설정과 validate 스크립트도 읽는다', () => {
    const r = base()
    for (const f of ['tests/data/expected.txt', '.github/workflows/ci.yml', '.github/workflows/b.yaml', 'scripts/validate.sh', 'scripts/validate-all.ts']) r.file(f, '## 표본 제목\n')
    r.file('.github/workflows/readme.md', '## 표본 제목\n')
    r.file('scripts/build.sh', '## 표본 제목\n')
    const done = find(r, '## 표본 제목')
    const lines = done.stdout.split('\n').filter((l) => l.includes('테스트가 요구')).map((l) => l.split('  ')[1].replace('테스트가 요구: ', '').split(':')[0]).sort()
    assert.deepEqual(lines, ['.github/workflows/b.yaml', '.github/workflows/ci.yml', 'scripts/validate-all.ts', 'scripts/validate.sh', 'tests/data/expected.txt'])
  })

  test('테스트 파일 이름 규칙을 본다', () => {
    const r = base()
    for (const f of ['src/test_a.py', 'src/b.test.ts', 'src/c_test.go', 'src/__tests__/d.js', 'src/test/e.txt', 'src/tests/f.txt']) r.file(f, '## 표본 제목\n')
    for (const f of ['src/latest.py', 'src/atest.ts', 'src/testing.go']) r.file(f, '## 표본 제목\n')
    const done = find(r, '## 표본 제목')
    assert.equal(done.stdout.split('테스트가 요구').length - 1, 6)
    assert.ok(!done.stdout.includes('src/latest.py') && !done.stdout.includes('src/testing.go'))
  })

  test('worktrees 와 node_modules 는 건너뛴다', () => {
    const r = base()
    for (const f of ['worktrees/w/tests/t.txt', 'node_modules/m/tests/t.txt']) r.file(f, '## 표본 제목\n')
    assert.ok(find(r, '## 표본 제목').stdout.includes('없음'))
  })

  test('빈 문자열 인자와 인자 부족은 2', () => {
    const r = base()
    const empty = find(r, '')
    assert.equal(empty.code, 2)
    assert.equal(empty.stderr, '빈 문자열은 찾을 수 없다\n')
    assert.equal(find(r).code, 2)
    assert.equal(r.run('find_test_requirements', []).code, 2)
  })

  test('저장소가 디렉터리가 아니면 2', () => {
    const r = base()
    const done = r.run('find_test_requirements', [`${r.root}/nope`, 'x'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `대상 저장소를 찾을 수 없다: ${r.root}/nope\n`)
  })

  test('제목 표기를 뗀 문자열로도 찾는다', () => {
    const r = base()
    r.file('tests/test_skill.py', '    "언제 쓰나",\n')
    assert.ok(find(r, '## 언제 쓰나').stdout.includes('테스트가 요구: tests/test_skill.py:1'))
  })

  test('UTF-8 로 읽을 수 없는 파일은 건너뛴다', () => {
    const r = base()
    writeFileSync(join(r.root, 'tests/latin.txt'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
    const done = find(r, '## 일곱 단계')
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('테스트 파일 1개에서'), done.stdout)
  })
})

describe('단계 구분과 후보 파일', () => {
  function plain(): Repo {
    const r = new Repo('hc-ftr-')
    r.file('tests/.keep', '')
    return r
  }

  test('git 이 아니면 빌드 결과물 폴더를 건너뛴다', () => {
    const r = plain()
    for (const d of ['build', 'dist', 'out', 'target', 'coverage', '.next']) r.file(`${d}/resources/test/application-test.yml`, '## 표본 제목\n')
    r.file('tests/t.txt', '## 표본 제목\n')
    const done = find(r, '## 표본 제목')
    assert.equal(done.stdout.split('테스트가 요구').length - 1, 1, done.stdout)
    assert.ok(done.stdout.includes('tests/t.txt:1'))
  })

  test('git 저장소는 무시된 파일을 빼고 새 파일은 읽는다', () => {
    const r = new Repo('hc-ftr-', true)
    r.file('.gitignore', 'build/\n')
    r.file('backend/build/resources/test/application-test.yml', '## 표본 제목\n')
    r.file('tests/new_file.txt', '## 표본 제목\n')
    const done = find(r, '## 표본 제목')
    assert.ok(!done.stdout.includes('backend/build'))
    assert.ok(done.stdout.includes('테스트가 요구: tests/new_file.txt:1'))
  })

  test('git 저장소의 추적 파일을 읽는다', () => {
    const r = new Repo('hc-ftr-', true)
    r.file('tests/t.txt', '## 표본 제목\n')
    r.git('add', 'tests/t.txt')
    assert.ok(find(r, '## 표본 제목').stdout.includes('테스트가 요구: tests/t.txt:1'))
  })

  test('따옴표와 낫표로 감싼 제목과 줄 전체가 제목인 줄은 요구다', () => {
    const r = plain()
    const samples = ['x("확인")', "x('확인')", 'x(`확인`)', '「확인」 을 본다', '『확인』 을 본다', '    확인   ']
    samples.forEach((s, i) => r.file(`tests/q${i}.txt`, `${s}\n`))
    const done = find(r, '## 확인')
    assert.equal(done.stdout.split('테스트가 요구').length - 1, samples.length, done.stdout)
    assert.ok(!done.stdout.includes('낱말만 겹침'))
  })

  test('인자를 그대로 담은 줄은 요구다', () => {
    const r = plain()
    r.file('tests/t.md', '본문\n## 확인\n')
    assert.ok(find(r, '## 확인').stdout.includes('테스트가 요구: tests/t.md:2'))
  })

  test('낱말만 겹친 줄은 개수로만 낸다', () => {
    const r = plain()
    r.file('tests/t.txt', '# 결과를 확인한다\n// 확인 후 진행\n')
    const done = find(r, '## 확인')
    assert.equal(done.stdout, '테스트 파일 2개에서 1개 문자열을 찾는다\n\n"## 확인"\n  없음\n  낱말만 겹침 2건 (--loose 로 목록)\n')
  })

  test('--loose 는 목록을 펼친다', () => {
    const r = plain()
    r.file('tests/t.txt', '# 결과를 확인한다\n')
    const done = find(r, '## 확인', '--loose')
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes('  낱말만 겹침: tests/t.txt:1  # 결과를 확인한다\n'))
    assert.ok(!done.stdout.includes('--loose 로 목록'))
    assert.equal(done.stdout.split('\n')[0], '테스트 파일 2개에서 1개 문자열을 찾는다')
  })

  test('--loose 는 문자열로 세지 않고 맨 앞에서도 받는다', () => {
    const r = plain()
    assert.equal(find(r, '--loose').code, 2)
    r.file('tests/t.txt', '확인\n')
    assert.equal(r.run('find_test_requirements', ['--loose', r.root, '확인']).code, 0)
  })

  test('제목 표기가 없는 인자는 부분 문자열 일치다', () => {
    const r = plain()
    r.file('tests/t.txt', '결과를 확인한다\n')
    assert.ok(find(r, '확인').stdout.includes('테스트가 요구: tests/t.txt:1'))
  })

  test('낫표 안에 든 제목에서 인자가 # 만이면 낱말 겹침도 없다', () => {
    const r = plain()
    r.file('tests/t.txt', '결과를 확인한다\n')
    const done = find(r, '## ')
    assert.equal(done.code, 0)
    assert.ok(!done.stdout.includes('낱말만 겹침'), done.stdout)
  })

  test('줄은 80자로 자르고 앞뒤 공백을 뗀다', () => {
    const r = plain()
    r.file('tests/t.txt', `   확인 ${'가'.repeat(100)}   \n`)
    const done = find(r, '확인')
    assert.ok(done.stdout.includes(`  테스트가 요구: tests/t.txt:1  확인 ${'가'.repeat(80 - 3)}\n`), done.stdout)
  })
})
