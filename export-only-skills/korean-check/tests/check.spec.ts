// check 명령 경계 테스트. 두 검사기를 합쳐 종료 코드 하나로 내는 진입이다.
// 인자 검증, 두 검사기 출력의 순서, 종료 코드는 둘 중 큰 값, --text 의 임시 경로 치환, --diff 의 인자 해석, --where 를 본다.
// 명령 경로는 helpers.ts 의 CHECK 상수 하나다.

import assert from 'node:assert/strict'
import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { CHECK, GIT_ENV, SKILL_DIR, cleanEnv, git, initRepo, run, tempDir, write } from './helpers.ts'

const check = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => run(CHECK, { ...opts, args })
const PASS = (what: string) => `표기 검사 통과: ${what}. 의미 점검은 별도\n`
const file = (text: string, name = 'a.md') => write(join(tempDir(), name), text)

describe('--where', () => {
  test('스킬 디렉터리의 실체 경로를 낸다', () => {
    const done = check(['--where'])
    assert.deepEqual([done.code, done.stdout], [0, `${realpathSync(SKILL_DIR)}\n`])
  })
})

describe('파일 모드', () => {
  test('통과하면 개수와 함께 한 줄을 낸다', () => {
    assert.deepEqual(Object.values(check([file('문제가 없는 문장이다.\n')])).slice(0, 2), [0, PASS('1개 파일')])
    assert.equal(check([file('문제 없다.\n'), file('문제 없다.\n')]).stdout, PASS('2개 파일'))
  })
  test('금지어가 있으면 1 이고 통과 줄이 없다', () => {
    const path = file('장애를 트리아지한다.\n')
    const done = check([path])
    assert.equal(done.code, 1)
    assert.ok(done.stdout.startsWith(`${path}:1: 금지어 "트리아지"`) && !done.stdout.includes('표기 검사 통과'), done.stdout)
  })
  test('경고만 있으면 0 이고 경고 뒤에 통과 줄이 온다', () => {
    const path = file('고쳤다 — 빠졌다.\n')
    const done = check([path])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `${path}:1  경고 [DASH] 평문의 엠대시: 콜론이나 접속사로 바꾼다\n` + PASS('1개 파일'))
  })
  test('금지어 검사기의 줄이 모두 앞이고 가독성 검사기의 줄이 뒤다', () => {
    const dir = tempDir()
    const a = write(join(dir, 'a.md'), '고쳤다 — 빠졌다.\n')
    const b = write(join(dir, 'b.md'), '장애를 트리아지한다.\n')
    const rows = check([a, b]).stdout.split('\n').filter(Boolean)
    assert.deepEqual(rows.map((row) => (row.includes('금지어') ? 'style' : 'read')), ['style', 'read'])
  })
  test('없는 대상은 2 다', () => {
    const gone = join(tempDir(), '없다.md')
    const done = check([gone])
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', `대상이 없다: ${gone}\n`])
  })
  test('확장자가 .md 가 아니면 절반만 검사되므로 2 다', () => {
    const path = file('장애를 트리아지한다.\n', 'a.txt')
    const done = check([path])
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', `확장자가 .md 가 아니라 절반만 검사된다: ${path}\n`])
  })
  test('옵션은 2 이고 옵션이라고 말한다. 앞의 잘못이 먼저다', () => {
    const path = file('문제 없다.\n')
    const done = check(['--bogus', path])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '다루지 않는 옵션이다: --bogus\n')
    assert.equal(check([path, '--bogus']).stderr, '다루지 않는 옵션이다: --bogus\n')
    assert.equal(check([join(tempDir(), '없다.md'), '--bogus']).stderr.startsWith('대상이 없다'), true)
    assert.equal(check(['--']).stderr, '다루지 않는 옵션이다: --\n')
  })
  test('인자가 없으면 2 다', () => {
    const done = check([])
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', '검사할 파일이나 --text 나 --diff 가 필요하다\n'])
  })
  test('종료 코드는 둘 중 큰 값이다: 금지어 검사기가 2 로 끝나면 가독성 경고가 있어도 2 다', () => {
    const path = file('고쳤다 — 빠졌다.\n')
    const done = check([path], { env: cleanEnv({ KOREAN_STYLE_RULES: join(tempDir(), '없다.md') }) })
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('매핑 표를 찾지 못했다') && done.stdout.includes('[DASH]') && !done.stdout.includes('표기 검사 통과'), done.stderr + done.stdout)
  })
})

describe('--text', () => {
  test('통과하면 문자열이라고 알린다', () => {
    assert.deepEqual(Object.values(check(['--text', 'fix(korean-check): 제목을 검사 대상에 넣는다'])).slice(0, 2), [0, PASS('문자열')])
  })
  test('금지어는 임시 경로 대신 (문자열) 로 보이고 1 이다', () => {
    const done = check(['--text', '장애를 트리아지한다'])
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '(문자열):1: 금지어 "트리아지" (열 5, 걸린 글자 "트리아지") — korean-style 매핑 표의 권장 표현으로\n')
  })
  test('여러 인자는 공백으로 이은 한 문자열이다', () => {
    assert.ok(check(['--text', '장애를', '트리아지한다']).stdout.includes('(열 5, 걸린 글자 "트리아지")'))
  })
  test('줄바꿈이 든 문자열은 줄 번호가 붙는다', () => {
    assert.ok(check(['--text', '문제 없다.\n장애를 트리아지한다']).stdout.startsWith('(문자열):2: 금지어'))
  })
  test('가독성 경고는 줄 번호 없이 (문자열) 로 나오고 통과 줄이 따른다', () => {
    const done = check(['--text', '검사기를 고쳤다 — 제목이 빠져 있었다'])
    assert.deepEqual([done.code, done.stdout], [0, '(문자열)  경고 [DASH] 평문의 엠대시: 콜론이나 접속사로 바꾼다\n' + PASS('문자열')])
  })
  test('금지어 줄이 가독성 줄보다 앞이다', () => {
    const rows = check(['--text', '트리아지 — 설명']).stdout.split('\n').filter(Boolean)
    assert.equal(rows.length, 2)
    assert.ok(rows[0].startsWith('(문자열):1: 금지어') && rows[1].startsWith('(문자열)  경고 [DASH]'), rows.join('\n'))
  })
  test('빈 문자열은 통과이고 문자열이 없으면 2 다', () => {
    assert.equal(check(['--text', '']).stdout, PASS('문자열'))
    const done = check(['--text'])
    assert.deepEqual([done.code, done.stderr], [2, '--text 뒤에 검사할 문자열이 필요하다\n'])
  })
  test('임시 파일을 남기지 않는다', () => {
    const tmp = tempDir()
    check(['--text', '장애를 트리아지한다'], { env: cleanEnv({ TMPDIR: tmp }) })
    check(['--text', '통과하는 문장이다'], { env: cleanEnv({ TMPDIR: tmp }) })
    assert.deepEqual(readdirSync(tmp), [])
  })
  test('옵션처럼 보이는 글도 문자열로 본다', () => assert.equal(check(['--text', '--bogus']).stdout, PASS('문자열')))
})

describe('--diff', () => {
  const OLD = '# 문서\n\n장애를 트리아지한다.\n\n둘째 단락이다.\n'
  function makeRepo() {
    const root = initRepo(tempDir())
    write(join(root, 'doc.md'), OLD)
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'init')
    return root
  }
  const diff = (root: string, ...args: string[]) => check(['--diff', ...args], { cwd: root, env: GIT_ENV })

  test('기본 기준은 HEAD 다. 기존 줄의 발견은 실패가 아니다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n새로 더한 문장이다.\n')
    const done = diff(root)
    assert.equal(done.code, 0, done.stdout)
    assert.ok(done.stdout.startsWith('## 이번 변경 (HEAD 이후 더한 줄)\n'))
  })
  test('더한 줄의 금지어는 1 이다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    assert.equal(diff(root).code, 1)
  })
  test('첫 인자는 기준이고 -- 뒤나 기준 바로 뒤가 파일이다', () => {
    const root = makeRepo()
    git(root, 'checkout', '-q', '-b', 'work')
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    write(join(root, 'other.md'), '결과를 스파이크한다.\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'work')
    assert.equal(diff(root, 'main').code, 1)
    const only = diff(root, 'main', '--', 'doc.md')
    assert.ok(only.stdout.includes('(main 이후 더한 줄)') && only.stdout.includes('doc.md:7') && !only.stdout.includes('other.md'), only.stdout)
    const plain = diff(root, 'main', 'other.md')
    assert.ok(plain.stdout.includes('other.md:1') && !plain.stdout.includes('doc.md:7'), plain.stdout)
    const headOnly = diff(root, '--', 'doc.md')
    assert.ok(headOnly.stdout.includes('(HEAD 이후 더한 줄)'), headOnly.stdout)
  })
  test('모르는 기준과 저장소 밖은 2 다', () => {
    assert.equal(diff(makeRepo(), 'no-such-ref').code, 2)
    const outside = check(['--diff'], { cwd: tempDir(), env: cleanEnv({ GIT_CEILING_DIRECTORIES: tempDir() }) })
    assert.equal(outside.code, 2)
  })
  test('--diff 는 첫 인자일 때만 이 모드다', () => {
    const path = file('문제 없다.\n')
    const done = check([path, '--diff'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '다루지 않는 옵션이다: --diff\n')
  })
})
