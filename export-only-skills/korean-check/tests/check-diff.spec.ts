// check-diff 명령 경계 테스트. 임시 git 저장소에 기존 금지어를 둔 파일을 커밋하고 줄을 더한 뒤 돌린다.
// 기존 줄의 발견이 종료 코드를 올리면 이 모드를 둔 의미가 없고, 더한 줄의 발견이 「기존 줄」 로 빠지면 금지어가 통과한다. 두 방향을 함께 고정한다.
// 명령 경로는 helpers.ts 의 DIFF 상수 하나다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { checkerCode } from '../scripts/check-diff.ts'
import { DIFF, GIT_ENV, cleanEnv, git, initRepo, run, tempDir, write } from './helpers.ts'

const OLD = '# 문서\n\n장애를 트리아지한다.\n\n둘째 단락이다.\n'

function makeRepo() {
  const root = initRepo(tempDir())
  write(join(root, 'doc.md'), OLD)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}
const diff = (root: string, ...args: string[]) => run(DIFF, { cwd: root, env: GIT_ENV, args })
const sections = (out: string) => {
  const [fresh, old = ''] = out.split('## 기존 줄')
  return [fresh, old]
}

describe('이번 변경과 기존 줄', () => {
  test('기존 줄의 발견은 실패로 올리지 않고 기존 줄 묶음에 둔다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n새로 더한 문장이다.\n')
    const done = diff(root)
    assert.equal(done.code, 0, done.stdout + done.stderr)
    const [fresh, old] = sections(done.stdout)
    assert.ok(!fresh.includes('트리아지'))
    assert.ok(old.includes('doc.md:3'))
  })
  test('더한 줄의 금지어는 실패다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    const done = diff(root)
    assert.equal(done.code, 1, done.stdout)
    const [fresh, old] = sections(done.stdout)
    assert.ok(fresh.includes('doc.md:7') && fresh.includes('스윕'))
    assert.ok(old.includes('트리아지'))
  })
  test('바꾼 줄도 이번 변경이다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD.replace('둘째 단락이다.', '둘째 스파이크다.'))
    const done = diff(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(sections(done.stdout)[0].includes('doc.md:5'))
  })
  test('더한 줄의 경고는 실패가 아니다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n배포 + 검증을 쓴다.\n')
    const done = diff(root)
    assert.equal(done.code, 0, done.stdout)
    assert.ok(sections(done.stdout)[0].includes('인라인 + 연결'))
  })
  test('코드 블록 여부는 파일 전체로 판정한다', () => {
    const root = makeRepo()
    const text = OLD + '\n```\n첫 줄\n```\n'
    write(join(root, 'doc.md'), text)
    git(root, 'commit', '-qam', 'fence')
    write(join(root, 'doc.md'), text.replace('첫 줄', '첫 줄\n트리아지 예시'))
    const done = diff(root)
    assert.equal(done.code, 0, done.stdout)
  })
  test('출력의 꼴: 머리 둘, 발견 없음, 빈 줄, 기존 줄의 발견', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n새로 더한 문장이다.\n')
    assert.equal(diff(root).stdout, '## 이번 변경 (HEAD 이후 더한 줄)\n발견 없음\n\n## 기존 줄 (참고. 종료 코드에 넣지 않는다)\ndoc.md:3: 금지어 "트리아지" (열 5, 걸린 글자 "트리아지") — korean-style 매핑 표의 권장 표현으로\n')
  })
  test('금지어 검사기의 줄이 가독성 검사기의 줄보다 앞이다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n자세한 것은 §3 에 있다.\n\n결과를 스윕한다.\n')
    const rows = sections(diff(root).stdout)[0].split('\n').filter((row) => row.startsWith(join('doc.md')))
    assert.deepEqual(rows.map((row) => (row.includes('금지어') ? 'style' : 'read')), ['style', 'read'])
  })
  test('바뀐 .md 가 없으면 통과 한 줄이다', () => {
    const root = makeRepo()
    assert.deepEqual(Object.values(diff(root)).slice(0, 2), [0, '통과: HEAD 이후 바뀐 .md 가 없다\n'])
  })
  test('지운 파일은 보지 않는다', () => {
    const root = makeRepo()
    rmSync(join(root, 'doc.md'))
    assert.equal(diff(root).stdout, '통과: HEAD 이후 바뀐 .md 가 없다\n')
  })
  test('이름을 바꾼 파일은 모든 줄이 이번 변경이다', () => {
    const root = makeRepo()
    git(root, 'mv', 'doc.md', 'renamed.md')
    const done = diff(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(sections(done.stdout)[0].includes('renamed.md:3'))
  })
})

describe('범위', () => {
  test('--base 는 커밋한 변경을 포함한다', () => {
    const root = makeRepo()
    git(root, 'checkout', '-q', '-b', 'work')
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    git(root, 'commit', '-qam', 'work')
    assert.equal(diff(root).code, 0)
    assert.equal(diff(root, '--base', 'main').code, 1)
  })
  test('기준 브랜치에 나중에 들어온 남의 변경은 이번 변경에 섞이지 않는다', () => {
    const root = makeRepo()
    git(root, 'checkout', '-q', '-b', 'work')
    write(join(root, 'other.md'), '문제 없는 문장이다.\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'work')
    git(root, 'checkout', '-q', 'main')
    write(join(root, 'doc.md'), OLD.replace('장애를 트리아지한다.', '장애를 분류한다.'))
    git(root, 'commit', '-qam', 'main moves')
    git(root, 'checkout', '-q', 'work')
    assert.equal(diff(root, '--base', 'main').code, 0)
  })
  test('추적하지 않는 새 파일은 모든 줄이 이번 변경이다', () => {
    const root = makeRepo()
    write(join(root, 'new.md'), '장애를 트리아지한다.\n')
    const done = diff(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(sections(done.stdout)[0].includes('new.md:1'))
  })
  test('무시한 파일은 보지 않는다', () => {
    const root = makeRepo()
    write(join(root, '.gitignore'), 'skip.md\n')
    write(join(root, 'skip.md'), '장애를 트리아지한다.\n')
    assert.equal(diff(root).code, 0)
  })
  test('파일을 직접 주면 그 파일만 본다', () => {
    const root = makeRepo()
    write(join(root, 'new.md'), '장애를 트리아지한다.\n')
    write(join(root, 'doc.md'), OLD + '\n더한 문장이다.\n')
    const done = diff(root, 'doc.md')
    assert.equal(done.code, 0, done.stdout)
    assert.ok(!done.stdout.includes('new.md'))
  })
  test('하위 폴더에서 돌리면 경로는 그 폴더 기준이다', () => {
    const root = makeRepo()
    mkdirSync(join(root, 'docs'))
    write(join(root, 'docs', 'sub.md'), '문제 없다.\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'sub')
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    write(join(root, 'docs', 'sub.md'), '결과를 스파이크한다.\n')
    const done = run(DIFF, { cwd: join(root, 'docs'), env: GIT_ENV })
    assert.equal(done.code, 1)
    assert.deepEqual(sections(done.stdout)[0].split('\n').filter((row) => row.includes('금지어')).map((row) => row.split(':')[0]), ['../doc.md', 'sub.md'])
  })
})

describe('옵션과 오류', () => {
  test('--base 는 접두와 = 로도 준다', () => {
    const root = makeRepo()
    git(root, 'checkout', '-q', '-b', 'work')
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    git(root, 'commit', '-qam', 'work')
    for (const args of [['--bas', 'main'], ['--b', 'main'], ['--base=main']]) assert.equal(diff(root, ...args).code, 1, args.join(' '))
  })
  test('거듭 준 --base 는 마지막 값이다', () => {
    const root = makeRepo()
    git(root, 'checkout', '-q', '-b', 'work')
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    git(root, 'commit', '-qam', 'work')
    assert.equal(diff(root, '--base', 'no-such-ref', '--base', 'main').code, 1)
    assert.equal(diff(root, '--base', 'main', '--base', 'HEAD').code, 0)
  })
  test('옵션 뒤나 앞에 파일을 둘 수 있고 -- 뒤는 파일이다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    for (const args of [['doc.md', '--base', 'HEAD'], ['--base', 'HEAD', 'doc.md'], ['--', 'doc.md']]) assert.equal(diff(root, ...args).code, 1, args.join(' '))
  })
  test('모르는 기준은 2 다', () => {
    const done = diff(makeRepo(), '--base', 'no-such-ref')
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('check-diff: 기준을 찾지 못했다: no-such-ref'), done.stderr)
  })
  test('git 저장소 밖은 2 다', () => {
    const done = run(DIFF, { cwd: tempDir(), env: cleanEnv({ GIT_CEILING_DIRECTORIES: tempDir() }) })
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('check-diff: git 저장소 안에서 돌린다'), done.stderr)
  })
  test('없는 대상과 .md 가 아닌 대상은 2 다', () => {
    const root = makeRepo()
    write(join(root, 'a.txt'), '문장이다.\n')
    assert.ok(diff(root, 'none.md').stderr.includes('check-diff: 대상이 없다: none.md'))
    assert.equal(diff(root, 'none.md').code, 2)
    const txt = diff(root, 'a.txt')
    assert.equal(txt.code, 2)
    assert.ok(txt.stderr.includes('check-diff: 확장자가 .md 가 아니다: a.txt'), txt.stderr)
  })
  test('모르는 옵션과 값 없는 --base 는 사용법 오류 2 다', () => {
    const root = makeRepo()
    for (const args of [['--bogus'], ['-x'], ['--base']]) {
      const done = diff(root, ...args)
      assert.equal(done.code, 2, args.join(' '))
      assert.ok(done.stderr.includes('usage:'), done.stderr)
    }
  })
  test('--help 는 사용법을 stdout 에 내고 0 이다', () => {
    for (const flag of ['-h', '--help', '--he']) {
      const done = diff(makeRepo(), flag)
      assert.equal(done.code, 0, flag)
      assert.ok(done.stdout.includes('usage:') && done.stdout.includes('--base'), done.stdout)
    }
  })
  test('검사기가 2 로 끝나면 그 stderr 를 내고 2 다', () => {
    const root = makeRepo()
    write(join(root, 'doc.md'), OLD + '\n더한 문장이다.\n')
    const done = run(DIFF, { cwd: root, env: cleanEnv({ ...GIT_ENV, KOREAN_STYLE_RULES: join(tempDir(), '없다.md') }) })
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('매핑 표를 찾지 못했다'), done.stderr)
    assert.equal(done.stdout, '')
  })
})

describe('--staged', () => {
  const staged = (root: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; args?: string[] } = {}) =>
    run(DIFF, { cwd: opts.cwd ?? root, env: opts.env ?? GIT_ENV, args: ['--staged', ...(opts.args ?? [])] })
  const stage = (root: string, name: string, text: string) => {
    write(join(root, name), text)
    git(root, 'add', '--', name)
  }

  test('더한 줄의 금지어는 1 이고 권장 표현을 붙인다. 기존 줄의 발견은 내지 않는다', () => {
    const root = makeRepo()
    stage(root, 'doc.md', OLD + '\n결과를 스윕한다.\n')
    const done = staged(root)
    assert.equal(done.code, 1, done.stdout + done.stderr)
    const rows = done.stdout.trimEnd().split('\n')
    assert.equal(rows.length, 2, done.stdout)
    assert.ok(rows[0].startsWith('doc.md:7: 금지어 "스윕"'), rows[0])
    assert.ok(rows[1].startsWith('권장 표현: "스윕" → ') && rows[1].length > '권장 표현: "스윕" → '.length, rows[1])
    assert.ok(!done.stdout.includes('트리아지'))
  })
  test('금지어가 같은 줄이 여럿이어도 권장 표현은 낱말마다 한 줄이다', () => {
    const root = makeRepo()
    stage(root, 'doc.md', OLD + '\n결과를 스윕한다.\n\n다시 스윕한다.\n\n장애를 트리아지한다.\n')
    const hints = staged(root).stdout.split('\n').filter((row) => row.startsWith('권장 표현:'))
    assert.deepEqual(hints.map((row) => /"([^"]+)"/.exec(row)?.[1]), ['스윕', '트리아지'])
  })
  test('더한 줄에 경고만 있으면 0 이고 경고 줄만 낸다', () => {
    const root = makeRepo()
    stage(root, 'doc.md', OLD + '\n배포 + 검증을 쓴다.\n')
    const done = staged(root)
    assert.equal(done.code, 0, done.stdout + done.stderr)
    assert.ok(done.stdout.includes('doc.md:7: 경고: 인라인 + 연결'), done.stdout)
    assert.ok(!done.stdout.includes('권장 표현'))
  })
  test('발견이 없거나 스테이징한 .md 가 없으면 아무것도 내지 않는다', () => {
    const root = makeRepo()
    assert.deepEqual(Object.values(staged(root)), [0, '', ''])
    stage(root, 'doc.md', OLD + '\n새로 더한 문장이다.\n')
    stage(root, 'a.txt', '결과를 스윕한다.\n')
    assert.deepEqual(Object.values(staged(root)), [0, '', ''])
  })
  test('작업 트리가 아니라 스테이징된 내용을 본다', () => {
    const root = makeRepo()
    stage(root, 'doc.md', OLD + '\n결과를 스윕한다.\n')
    write(join(root, 'doc.md'), OLD + '\n결과를 검사한다.\n')
    assert.equal(staged(root).code, 1)
    const other = makeRepo()
    stage(other, 'doc.md', OLD + '\n결과를 검사한다.\n')
    write(join(other, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    assert.deepEqual(Object.values(staged(other)), [0, '', ''])
  })
  test('GIT_INDEX_FILE 이 가리키는 인덱스를 본다', () => {
    const root = makeRepo()
    const index = join(tempDir(), 'index')
    const env = { ...GIT_ENV, GIT_INDEX_FILE: index }
    const run2 = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: root, env }).status, 0, args.join(' '))
    run2('read-tree', 'HEAD')
    write(join(root, 'doc.md'), OLD + '\n결과를 스윕한다.\n')
    run2('add', 'doc.md')
    assert.deepEqual(Object.values(staged(root)), [0, '', ''])
    assert.equal(staged(root, { env }).code, 1)
  })
  test('새 파일은 모든 줄이 대상이고, 이름만 바꾼 파일은 막지 않는다', () => {
    const root = makeRepo()
    stage(root, 'new.md', '장애를 트리아지한다.\n')
    const fresh = staged(root)
    assert.equal(fresh.code, 1, fresh.stdout)
    assert.ok(fresh.stdout.startsWith('new.md:1: 금지어'), fresh.stdout)

    const moved = makeRepo()
    mkdirSync(join(moved, 'docs'))
    git(moved, 'mv', 'doc.md', 'docs/moved.md')
    assert.deepEqual(Object.values(staged(moved)), [0, '', ''])
    write(join(moved, 'docs', 'moved.md'), OLD + '\n결과를 스윕한다.\n')
    git(moved, 'add', '.')
    const done = staged(moved)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(done.stdout.startsWith('docs/moved.md:7: 금지어 "스윕"'), done.stdout)
    assert.ok(!done.stdout.includes('트리아지'))
  })
  test('커밋이 없는 저장소의 첫 커밋도 본다', () => {
    const root = initRepo(tempDir())
    stage(root, 'doc.md', '결과를 스윕한다.\n')
    assert.equal(staged(root).code, 1)
  })
  test('코드 블록 여부는 파일 전체로 판정한다', () => {
    const root = makeRepo()
    const text = OLD + '\n```\n첫 줄\n```\n'
    stage(root, 'doc.md', text)
    git(root, 'commit', '-qm', 'fence')
    stage(root, 'doc.md', text.replace('첫 줄', '첫 줄\n트리아지 예시'))
    assert.deepEqual(Object.values(staged(root)), [0, '', ''])
  })
  test('예외 파일은 평소처럼 대상 파일에서 가장 가까운 것을 읽는다. 하위 폴더의 것은 그 아래에만 듣는다', () => {
    const root = makeRepo()
    write(join(root, '.claude', 'korean-check-allow.txt'), '스윕 작전\n')
    write(join(root, 'sub', '.claude', 'korean-check-allow.txt'), '트리아지 센터\n')
    stage(root, 'top.md', '스윕 작전을 본다.\n')
    stage(root, 'sub/in.md', '트리아지 센터를 본다.\n')
    stage(root, 'sub/deep/in.md', '트리아지 센터를 본다.\n')
    assert.deepEqual(Object.values(staged(root)), [0, '', ''])
    stage(root, 'top.md', '스윕 작전과 트리아지 센터를 본다.\n')
    const done = staged(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(done.stdout.startsWith('top.md:1: 금지어 "트리아지"'), done.stdout)
  })
  test('하위 폴더에서 돌려도 경로는 저장소 루트 기준이다', () => {
    const root = makeRepo()
    stage(root, 'docs/sub.md', '결과를 스윕한다.\n')
    const done = staged(root, { cwd: join(root, 'docs') })
    assert.equal(done.code, 1)
    assert.ok(done.stdout.startsWith('docs/sub.md:1: 금지어'), done.stdout)
  })
  test('이름에 금지어라는 낱말이 든 파일의 경고는 실패가 아니다', () => {
    const root = makeRepo()
    stage(root, '금지어-목록.md', '배포 + 검증을 쓴다.\n')
    const done = staged(root)
    assert.equal(done.code, 0, done.stdout)
    assert.ok(done.stdout.includes('경고'), done.stdout)
  })
  test('DB 문맥 패턴은 1 이고 권장 표현 줄이 없다', () => {
    const root = makeRepo()
    stage(root, 'db.md', ['DB', '표를 만든다.'].join(' ') + '\n')
    const done = staged(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(!done.stdout.includes('권장 표현'), done.stdout)
  })
  test('이름에 glob 글자가 든 파일도 그 파일만 본다', () => {
    const root = makeRepo()
    stage(root, 'a[1].md', '문제 없는 문장이다.\n')
    stage(root, 'a1.md', '문제 없는 문장이다.\n')
    git(root, 'commit', '-qm', 'two')
    stage(root, 'a[1].md', '문제 없는 문장이다.\n\n결과를 스윕한다.\n')
    const done = staged(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(done.stdout.startsWith('a[1].md:3: 금지어'), done.stdout)
  })
  test('매핑 표를 가진 문서는 다른 경로의 사본이어도 검사하지 않는다', () => {
    const root = makeRepo()
    const table = ['# 규칙', '', '## 어색한 말 매핑 표', '', '| 금지 | 원어 | 권장 |', '| --- | --- | --- |', '| 가나다 | x | 라마 |', '', '## 다음 절', '', '결과를 스윕한다.', ''].join('\n')
    stage(root, 'vendor/rules/korean-style.md', table)
    assert.deepEqual(Object.values(staged(root)), [0, '', ''])
    stage(root, 'plain.md', '결과를 스윕한다.\n')
    assert.ok(staged(root).stdout.startsWith('plain.md:1: 금지어'))
  })
  test('심볼릭 링크는 보지 않고, 일반 파일로 바뀌면 모든 줄을 본다', () => {
    const root = makeRepo()
    symlinkSync('doc.md', join(root, 'link.md'))
    git(root, 'add', 'link.md')
    assert.deepEqual(Object.values(staged(root)), [0, '', ''])
    git(root, 'commit', '-qm', 'link')
    rmSync(join(root, 'link.md'))
    stage(root, 'link.md', '결과를 스윕한다.\n')
    const done = staged(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(done.stdout.startsWith('link.md:1: 금지어'), done.stdout)
  })
  test('이름에 「:숫자 」 꼴이 든 파일의 발견도 그 파일의 것으로 읽는다', () => {
    const root = makeRepo()
    stage(root, 'a:1 b.md', '문제 없는 문장이다.\n\n결과를 스윕한다.\n')
    const done = staged(root)
    assert.equal(done.code, 1, done.stdout)
    assert.ok(done.stdout.startsWith('a:1 b.md:3: 금지어'), done.stdout)
  })
  test('검사기가 돌지 못하면 2 다', () => {
    const root = makeRepo()
    stage(root, 'doc.md', OLD + '\n결과를 스윕한다.\n')
    const done = staged(root, { env: { ...GIT_ENV, KOREAN_STYLE_RULES: join(tempDir(), 'none.md') } })
    assert.equal(done.code, 2, done.stdout + done.stderr)
    assert.equal(done.stdout, '')
  })
  test('임시 폴더를 남기지 않는다', () => {
    const root = makeRepo()
    const tmp = tempDir()
    stage(root, 'doc.md', OLD + '\n결과를 스윕한다.\n')
    assert.equal(staged(root, { env: { ...GIT_ENV, TMPDIR: tmp } }).code, 1)
    assert.deepEqual(readdirSync(tmp), [])
  })
  test('--base 나 파일과 함께 주면 사용법 오류 2 이고, 저장소 밖도 2 다', () => {
    const root = makeRepo()
    for (const args of [['--base', 'main'], ['doc.md']]) {
      const done = staged(root, { args })
      assert.equal(done.code, 2, args.join(' '))
      assert.ok(done.stderr.includes('argument --staged: not allowed with --base or files'), done.stderr)
    }
    const outside = run(DIFF, { cwd: tempDir(), env: cleanEnv({ GIT_CEILING_DIRECTORIES: tempDir() }), args: ['--staged'] })
    assert.equal(outside.code, 2)
  })
})

describe('checkerCode', () => {
  const row = 'doc.md:1: 금지어 "가나" (열 1, 걸린 글자 "가나") — 설명'
  test('0 과 금지어 발견 줄이 있는 1 은 그대로다', () => {
    assert.equal(checkerCode({ status: 0, signal: null }, []), 0)
    assert.equal(checkerCode({ status: 1, signal: null }, [row]), 1)
  })
  test('발견 줄 없이 1 로 죽은 검사기는 돌지 못한 것이다', () => {
    assert.equal(checkerCode({ status: 1, signal: null }, []), 2)
    assert.equal(checkerCode({ status: 1, signal: null }, ['doc.md:1  경고 [DASH] 설명']), 2)
  })
  test('띄우지 못했거나 신호로 끝났거나 다른 코드면 돌지 못한 것이다', () => {
    assert.equal(checkerCode({ status: null, signal: null, error: new Error('E2BIG') }, []), 2)
    assert.equal(checkerCode({ status: null, signal: 'SIGKILL' }, []), 2)
    assert.equal(checkerCode({ status: 2, signal: null }, []), 2)
    assert.equal(checkerCode({ status: 13, signal: null }, []), 2)
  })
})
