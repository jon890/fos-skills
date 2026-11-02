// study-candidates.ts 가 후보마다 파일 하나를 만들고 머리 칸만 고치며, 상태 전이와 옛 표 옮기기를 지키는지 본다. 임시 폴더(git 밖)를 저장소로 준다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { localDate, parse, parseLegacy, sameTopic, statusOf, validSlug } from '../scripts/lib/study.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/study-candidates.ts', import.meta.url))
// ai-analysis 의 .orch/study/candidates.md 를 2026-11-01 에 복사한 것이다. 원본은 고치지 않는다
const FIXTURE = fileURLToPath(new URL('./fixtures/study/candidates.md', import.meta.url))

let repo: string
let dir: string
let trash: string

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'study-candidates-')))
  dir = join(repo, '.orch', 'study')
  trash = join(repo, 'trash')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

function run(...args: string[]) {
  const env = { ...process.env }
  delete env.ORCH_DIR
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args, '--repo', repo], { encoding: 'utf8', env })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function addOne(slug: string, topic: string, ...more: string[]) {
  return run('add', '--slug', slug, '--topic', topic, '--question', 'q', '--origin', 'o', ...more)
}

function seed(name: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}

const today = localDate()

describe('파일 읽기', () => {
  test('상태 칸의 첫머리 낱말이 상태다', () => {
    assert.equal(statusOf('후보'), '후보')
    assert.equal(statusOf('리뷰함: 다시 나온다'), '리뷰함')
    assert.equal(statusOf('글 씀: study/a.md'), '글 씀')
    assert.equal(statusOf('뺌 (이미 있다)'), '뺌')
    assert.equal(statusOf('후보군'), null)
    assert.equal(statusOf(''), null)
  })

  test('slug 는 영문 소문자, 숫자, 하이픈이고 주제는 빈칸과 대소문자, 정규화를 무시하고 비교한다', () => {
    assert.ok(validSlug('minio-object-key-length'))
    assert.ok(validSlug('s3'))
    for (const bad of ['', 'A', 'a_b', 'a--b', '-a', 'a-', '한글', 'a'.repeat(81)]) assert.equal(validSlug(bad), false, bad)
    assert.ok(sameTopic('ShedLock  분산 잠금', ' shedlock 분산 잠금'))
    assert.ok(sameTopic('한글'.normalize('NFD'), '한글'))
    assert.equal(sameTopic('a', 'b'), false)
  })

  test('머리 칸을 읽고 모르는 칸과 본문은 남긴다', () => {
    const c = parse('---\n주제: a: b\n모르는 칸: x\n상태: 리뷰함: 이유\n---\n\n본문\n', 'f', 's')
    assert.ok(c)
    assert.equal(c.values['주제'], 'a: b')
    assert.equal(c.status, '리뷰함')
    assert.equal(c.end, 4)
    assert.equal(parse('# 머리 없음\n', 'f', 's'), null)
  })

  test('옛 표 파일의 행을 읽고 칸 안의 \\| 를 푼다', () => {
    const rows = parseLegacy(readFileSync(FIXTURE, 'utf8'))
    assert.ok(rows)
    assert.equal(rows.length, 8)
    assert.ok(rows.every((row) => row.cells.length === 5 && row.cells[4] === '후보'))
    assert.deepEqual(parseLegacy('| 주제 | 질문 | 생긴 곳 | 참고 | 상태 |\n| --- | --- | --- | --- | --- |\n| a\\|b | q | o | | 후보 |\n')?.[0].cells, ['a|b', 'q', 'o', '', '후보'])
    assert.equal(parseLegacy('# 표 없음\n'), null)
  })
})

describe('add', () => {
  test('폴더가 없으면 만들고 상태 후보, 적은 날 오늘로 파일을 만든다. 줄바꿈은 빈칸으로, 메모는 본문이 된다', () => {
    const r = run('add', '--slug', 'a-b', '--topic', 'a|b', '--question', '첫 줄\n둘째 줄', '--origin', '곳', '--memo', '## 메모\n\n- 근거')
    assert.equal(r.code, 0, r.stderr)
    const file = join(dir, 'a-b.md')
    assert.equal(r.stdout, `ADDED a-b ${file}\n`)
    assert.equal(readFileSync(file, 'utf8'), `---\n주제: a|b\n질문: 첫 줄 둘째 줄\n생긴 곳: 곳\n참고:\n상태: 후보\n적은 날: ${today}\n---\n\n## 메모\n\n- 근거\n`)
    assert.equal(run('list').stdout, `a-b\t${today}\t후보\ta|b\n`)
  })

  test('같은 slug 나 같은 주제가 있으면 만들지 않고 1 이다. 뺀 후보도 같은 후보다', () => {
    addOne('a', 'Topic A')
    let r = addOne('a', '다른 주제')
    assert.equal(r.code, 1)
    assert.match(r.stderr, /같은 후보가 이미 있다\(후보\): .*a\.md/)
    run('set', '--slug', 'a', '--status', '뺌', '--note', '하루 끝에 뺌')
    r = addOne('b', ' topic  a ')
    assert.equal(r.code, 1)
    assert.match(r.stderr, /같은 후보가 이미 있다\(뺌: 하루 끝에 뺌\)/)
    assert.deepEqual(readdirSync(dir), ['a.md'])
  })

  test('slug 가 없거나 틀렸거나 주제, 질문, 생긴 곳이 없으면 사용법 오류다', () => {
    assert.equal(run('add', '--topic', 'a', '--question', 'q', '--origin', 'o').code, 2)
    assert.equal(addOne('Bad_Slug', 'a').code, 2)
    const r = run('add', '--slug', 'a', '--topic', 'a', '--question', 'q')
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--origin 를 준다/)
  })

  test('옛 표 파일이 남아 있으면 stderr 에 옮기라고 알리고 계속한다', () => {
    seed('candidates.md', readFileSync(FIXTURE, 'utf8'))
    const r = addOne('a', 'a')
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /옛 표 파일이 남아 있다. migrate 로 옮긴다/)
  })
})

describe('set', () => {
  beforeEach(() => {
    addOne('a', 'a', '--memo', '본문은 그대로 둔다')
    addOne('b', 'b')
  })

  test('후보를 리뷰함으로, 리뷰함을 글 씀으로 바꾸고 본문과 다른 파일은 그대로 둔다', () => {
    let r = run('set', '--slug', 'a', '--status', '리뷰함', '--note', '다음 일에서\n다시 나온다')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, 'SET a 리뷰함: 다음 일에서 다시 나온다\n')
    r = run('set', '--slug', 'a', '--status', '글 씀', '--note', 'study/a.md')
    assert.equal(r.code, 0, r.stderr)
    assert.match(readFileSync(join(dir, 'a.md'), 'utf8'), /\n상태: 글 씀: study\/a\.md\n적은 날: .*\n---\n\n본문은 그대로 둔다\n$/)
    assert.equal(run('list').stdout, `a\t${today}\t글 씀: study/a.md\ta\nb\t${today}\t후보\tb\n`)
    assert.equal(run('list', '--open').stdout, `b\t${today}\t후보\tb\n`)
  })

  test('후보에서 바로 글 씀으로, 뺌에서 다른 상태로는 바꾸지 않고 1 이다', () => {
    let r = run('set', '--slug', 'a', '--status', '글 씀', '--note', 'x.md')
    assert.equal(r.code, 1)
    assert.match(r.stderr, /후보 에서 글 씀 로 바꿀 수 없다. 바꿀 수 있는 상태: 리뷰함, 뺌/)
    run('set', '--slug', 'b', '--status', '뺌', '--note', '하루 끝에 뺌')
    r = run('set', '--slug', 'b', '--status', '리뷰함', '--note', 'x')
    assert.equal(r.code, 1)
    assert.match(r.stderr, /바꿀 수 있는 상태: 없다/)
  })

  test('없는 후보는 1, 모르는 상태와 메모 없음은 사용법 오류다', () => {
    assert.equal(run('set', '--slug', 'zz', '--status', '뺌', '--note', 'x').code, 1)
    assert.equal(run('set', '--slug', 'a', '--status', '후보', '--note', 'x').code, 2)
    assert.equal(run('set', '--slug', 'a', '--status', '뺌').code, 2)
  })
})

describe('list', () => {
  test('--today 와 --date 는 그날 적은 것만 낸다', () => {
    addOne('new', 'new')
    seed('old.md', '---\n주제: old\n상태: 후보\n적은 날: 2026-01-02\n---\n')
    seed('README.md', '# 안내\n')
    seed('broken.md', '머리가 없다\n')
    assert.equal(run('list', '--today').stdout, `new\t${today}\t후보\tnew\n`)
    assert.equal(run('list', '--date', '2026-01-02', '--open').stdout, 'old\t2026-01-02\t후보\told\n')
    assert.equal(run('list', '--today', '--date', '2026-01-02').code, 2)
    assert.equal(run('list', '--date', '1/2').code, 2)
  })

  test('폴더가 없으면 아무것도 내지 않고 0 이다', () => {
    const r = run('list')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, '')
  })
})

describe('migrate', () => {
  const SLUGS = ['minio-key-length', 'observability-ingest', 'clickhouse-memory', 'hikaricp-pool-size', 'timescale-percentile', 'shadow-compare', 'run-once-cluster', 'expand-contract']

  function slugArgs(count = SLUGS.length): string[] {
    return SLUGS.slice(0, count).flatMap((slug, i) => ['--slug', `${i + 1}=${slug}`])
  }

  test('줄마다 파일을 만들고 상태는 그대로, 적은 날은 옛 파일의 수정 날짜로 적고 옛 파일을 휴지통으로 옮긴다', () => {
    const legacy = seed('candidates.md', readFileSync(FIXTURE, 'utf8').replace('| shadow 비교 배포 | ', '| shadow 비교 배포 \\| 대조 | ').replace(/\| 후보 \|\n\| 여러 서버/, '| 리뷰함: 다시 나온다 |\n| 여러 서버'))
    const mtime = new Date(2026, 10, 1, 12, 0, 0)
    utimesSync(legacy, mtime, mtime)
    const r = run('migrate', ...slugArgs(), '--trash', trash)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, `MIGRATED 8 ${dir}\nTRASHED ${legacy} ${join(trash, 'candidates.md')}\n`)
    assert.equal(existsSync(legacy), false)
    assert.equal(readFileSync(join(trash, 'candidates.md'), 'utf8').includes('| 주제 |'), true)
    assert.equal(readdirSync(dir).length, 8)
    const text = readFileSync(join(dir, 'shadow-compare.md'), 'utf8')
    assert.match(text, /^---\n주제: shadow 비교 배포 \| 대조\n질문: 새 경로를 옆에서/)
    assert.match(text, /\n상태: 리뷰함: 다시 나온다\n적은 날: 2026-11-01\n---\n$/)
    assert.equal(run('list', '--open').stdout.split('\n').filter(Boolean).length, 8)
  })

  test('slug 가 빠진 줄이 있으면 NEED-SLUG 로 알리고 아무 파일도 만들지 않는다', () => {
    const legacy = seed('candidates.md', readFileSync(FIXTURE, 'utf8'))
    const r = run('migrate', ...slugArgs(6), '--trash', trash)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /^NEED-SLUG 7\t여러 서버에서 한 번만 실행하기\nNEED-SLUG 8\t무중단 배포/)
    assert.deepEqual(readdirSync(dir), ['candidates.md'])
    assert.ok(existsSync(legacy))
  })

  test('같은 후보가 이미 있거나 slug 가 겹치면 아무 파일도 만들지 않고 1 이다', () => {
    seed('candidates.md', readFileSync(FIXTURE, 'utf8'))
    seed('other.md', '---\n주제: ClickHouse 쿼리 메모리 한도\n상태: 후보\n---\n')
    let r = run('migrate', ...slugArgs(), '--trash', trash)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /3 번과 같은 후보가 이미 있다: .*other\.md/)
    rmSync(join(dir, 'other.md'))
    const args = slugArgs()
    args[args.length - 1] = '8=minio-key-length'
    r = run('migrate', ...args, '--trash', trash)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /8 번이 앞 줄과 slug 나 주제가 겹친다: minio-key-length/)
    assert.deepEqual(readdirSync(dir), ['candidates.md'])
  })

  test('옛 파일이 없으면 1, 틀린 --slug 는 사용법 오류다', () => {
    assert.equal(run('migrate', '--slug', '1=a').code, 1)
    seed('candidates.md', readFileSync(FIXTURE, 'utf8'))
    assert.equal(run('migrate', '--slug', 'a').code, 2)
    assert.equal(run('migrate', '--slug', '9=a').code, 2)
    assert.equal(run('migrate', '--slug', '1=A').code, 2)
    assert.equal(run('migrate', '--slug', '1=a', '--slug', '1=b').code, 2)
  })
})
