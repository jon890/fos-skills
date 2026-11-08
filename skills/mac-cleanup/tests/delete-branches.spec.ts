// delete_branches 의 명령 경계 테스트. 임시 저장소의 브랜치만 지우고 실제 저장소는 건드리지 않는다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Repo, Sandbox, write } from './helpers.ts'

const BASE = 'origin/main'
const D = '삭제 후보(-d)'
const PRM = 'PR 머지됨(-D)'

function setup() {
  const box = new Sandbox()
  const repo = new Repo(join(box.root, 'repo'))
  const a = repo.commit('A')
  // feature 는 A 위의 B 이고 origin/main 에만 포함된다. 로컬 main 은 A 라서 -d 가 거절된다
  repo.git('checkout', '-q', '-b', 'feature')
  const b = repo.commit('B')
  repo.git('update-ref', 'refs/remotes/origin/main', b)
  repo.git('checkout', '-q', 'main')
  // merged 는 A 에 있어 -d 가 통과한다
  repo.git('branch', 'merged', a)
  const br = (name: string, tip: string, cls: string, extra: object = {}) => ({ name, tip, class: cls, pr_state: null, ...extra })
  const survey = (branches: object[], base = BASE) => write(join(box.root, 'survey.json'), JSON.stringify([{ repo: repo.dir, base, branches }]))
  const run = (branches: object[], args: string[] = []) => box.run('delete_branches', [survey(branches), ...args])
  const row = (status: string, name: string, detail: string) => `[${status}] ${repo.dir}  ${name}  ${detail}`.trimEnd()
  return { box, repo, a, b, br, survey, run, row }
}

describe('dry-run', () => {
  test('아무것도 바꾸지 않고 삭제 예정만 보인다', () => {
    const { repo, a, b, br, run, row } = setup()
    const done = run([br('merged', a, D), br('feature', b, PRM)], ['--only', 'merged', 'pr-merged'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, `## dry-run (변경 없음, 실제 삭제는 --apply)\n${row('삭제 예정', 'merged', '-d')}\n${row('삭제 예정', 'feature', '-D (PR 머지됨, tip 일치)')}\n\n## 합계\n   2  삭제 예정\n`)
    assert.ok(repo.has('merged') && repo.has('feature'))
  })

  test('-d 가 거절될 브랜치는 이유를 함께 보인다', () => {
    const { a, b, br, run, row } = setup()
    const ok = run([br('feature', b, D)])
    assert.ok(ok.stdout.includes(`${row('삭제 예정', 'feature', '-d')}\n`))
    const mismatch = run([br('feature', a, D)])
    assert.ok(mismatch.stdout.includes(`${row('삭제 예정', 'feature', `-d (거절되면 유지: tip 불일치(조사 ${a.slice(0, 8)}, 지금 ${b.slice(0, 8)}))`)}\n`))
  })

  test('기준에 포함되지 않으면 거절되면 유지라고 보인다', () => {
    const { repo, a, b, br, run, row } = setup()
    repo.git('update-ref', 'refs/remotes/origin/main', a)
    const done = run([br('feature', b, D)])
    assert.ok(done.stdout.includes(`${row('삭제 예정', 'feature', '-d (거절되면 유지: origin/main 에 포함되지 않음)')}\n`))
  })
})

describe('--apply', () => {
  test('삭제 후보는 git branch -d 로 지운다', () => {
    const { repo, a, br, run, row } = setup()
    const done = run([br('merged', a, D)], ['--apply'])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `## 실행\n${row('삭제', 'merged', '-d')}\n\n## 합계\n   1  삭제\n`)
    assert.ok(!repo.has('merged'))
  })

  test('-d 가 거절돼도 tip 이 같고 기준에 포함되면 -D 로 지운다', () => {
    const { repo, b, br, run, row } = setup()
    const done = run([br('feature', b, D)], ['--apply'])
    assert.ok(done.stdout.includes(`${row('삭제', 'feature', '-d 거절 뒤 -D (tip 일치, base 에 포함)')}\n`))
    assert.ok(!repo.has('feature'))
  })

  test('-d 가 거절되고 tip 이 다르면 유지한다', () => {
    const { repo, a, br, run, row } = setup()
    const done = run([br('feature', a, D)], ['--apply'])
    assert.ok(done.stdout.includes(`${row('유지', 'feature', `-d 거절, tip 불일치(조사 ${a.slice(0, 8)}, 지금 `)}`))
    assert.ok(repo.has('feature'))
    assert.equal(done.code, 0)
  })

  test('-d 가 거절되고 기준에 포함되지 않으면 유지한다', () => {
    const { repo, a, b, br, run, row } = setup()
    repo.git('update-ref', 'refs/remotes/origin/main', a)
    const done = run([br('feature', b, D)], ['--apply'])
    assert.ok(done.stdout.includes(`${row('유지', 'feature', '-d 거절, origin/main 에 포함되지 않음')}\n`))
    assert.ok(repo.has('feature'))
  })

  test('PR 머지됨은 tip 이 같을 때만 -D 로 지운다', () => {
    const { repo, a, b, br, run, row } = setup()
    const keep = run([br('feature', a, PRM)], ['--only', 'pr-merged', '--apply'])
    assert.ok(keep.stdout.includes(`${row('유지', 'feature', `tip 불일치(조사 ${a.slice(0, 8)}, 지금 ${b.slice(0, 8)})`)}\n`))
    assert.ok(repo.has('feature'))
    const gone = run([br('feature', b, PRM)], ['--only', 'pr-merged', '--apply'])
    assert.ok(gone.stdout.includes(`${row('삭제', 'feature', '-D')}\n`))
    assert.ok(!repo.has('feature'))
  })

  test('고르지 않은 분류와 gh 확인 실패와 PR 확인 필요는 건드리지 않는다', () => {
    const { repo, b, br, run, row } = setup()
    const done = run([br('feature', b, PRM), br('feature', b, D, { pr_state: 'error' }), br('feature', b, 'PR 확인 필요(-D)'), br('feature', b, '유지')], ['--apply'])
    assert.equal(done.stdout, `## 실행\n${row('건드리지 않음', 'feature', '분류 PR 머지됨(-D)')}\n${row('건드리지 않음', 'feature', 'gh 확인 실패')}\n${row('건드리지 않음', 'feature', '분류 PR 확인 필요(-D)')}\n${row('건드리지 않음', 'feature', '분류 유지')}\n\n## 합계\n   4  건드리지 않음\n`)
    assert.ok(repo.has('feature'))
  })

  test('체크아웃된 브랜치는 실패하고 git 의 오류 문장을 보이며 종료 코드 1 이다', () => {
    const { repo, a, br, run } = setup()
    const dry = run([br('main', a, D)])
    assert.equal(dry.code, 0)
    const done = run([br('main', a, D)], ['--apply'])
    assert.equal(done.code, 1)
    assert.match(done.stdout, /^\[실패\] .+  main  .+\n/m)
    assert.ok(done.stdout.includes('\n## 합계\n   1  실패\n'))
    assert.ok(repo.has('main'))
  })

  test('없는 브랜치는 모드와 분류와 무관하게 유지다', () => {
    const { a, br, run, row } = setup()
    for (const [cls, only] of [[D, 'merged'], [PRM, 'pr-merged']]) {
      for (const args of [[], ['--apply']]) {
        const done = run([br('gone', a, cls)], ['--only', only, ...args])
        assert.ok(done.stdout.includes(`${row('유지', 'gone', '브랜치가 없다')}\n`), done.stdout)
      }
    }
  })

  test('tip 이 없으면 유지다', () => {
    const { run, row } = setup()
    const done = run([{ name: 'merged', class: D }], ['--apply'])
    assert.ok(done.stdout.includes(`${row('유지', 'merged', '조사 JSON 에 tip 이 없다')}\n`))
  })

  test('합계는 상태 이름순이고 실패가 있어도 나머지는 계속한다', () => {
    const { repo, a, b, br, run } = setup()
    const done = run([br('main', a, D), br('merged', a, D), br('feature', b, D)], ['--apply'])
    assert.equal(done.code, 1)
    assert.ok(done.stdout.endsWith('\n## 합계\n   2  삭제\n   1  실패\n'), done.stdout)
    assert.ok(!repo.has('merged') && !repo.has('feature'))
  })
})

describe('옵션과 입력', () => {
  test('--only 는 거듭 주면 마지막 값이고 여러 값을 받는다', () => {
    const { a, b, br, run, row } = setup()
    const both = run([br('merged', a, D), br('feature', b, PRM)], ['--only', 'merged', 'pr-merged'])
    assert.ok(both.stdout.includes('삭제 예정'))
    const last = run([br('merged', a, D), br('feature', b, PRM)], ['--only', 'merged', '--only', 'pr-merged'])
    assert.ok(last.stdout.includes(`${row('건드리지 않음', 'merged', '분류 삭제 후보(-d)')}\n`))
    assert.ok(last.stdout.includes(`${row('삭제 예정', 'feature', '-D (PR 머지됨, tip 일치)')}\n`))
  })

  test('--only 에 모르는 값이면 사용법 오류 2 다', () => {
    const { run, a, br } = setup()
    const done = run([br('merged', a, D)], ['--only', 'merged', 'zzz'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes("argument --only: invalid choice: 'zzz' (choose from 'merged', 'pr-merged')"), done.stderr)
    assert.equal(run([br('merged', a, D)], ['--only']).code, 2)
  })

  test('--only 의 값 목록은 위치 인자 앞에서 옵션처럼 먹는다', () => {
    const { box, survey, a, br } = setup()
    const file = survey([br('merged', a, D)])
    assert.equal(box.run('delete_branches', ['--only', 'merged', file]).code, 2)
    assert.equal(box.run('delete_branches', ['--only', 'merged', '--', file]).code, 0)
    assert.equal(box.run('delete_branches', ['--apply', file]).code, 0)
  })

  test('--apply 는 접두로 줄여 쓸 수 있고 값을 주면 사용법 오류다', () => {
    const { repo, a, br, run } = setup()
    assert.equal(run([br('merged', a, D)], ['--app']).code, 0)
    assert.ok(!repo.has('merged'))
    assert.equal(run([br('merged', a, D)], ['--apply=1']).code, 2)
    assert.equal(run([br('merged', a, D)], ['--a']).code, 0)
  })

  test('조사 JSON 은 - 로 표준 입력에서도 읽는다', () => {
    const { box, repo, a, br } = setup()
    const input = JSON.stringify([{ repo: repo.dir, base: BASE, branches: [br('merged', a, D)] }])
    const done = box.run('delete_branches', ['-', '--apply'], { input })
    assert.equal(done.code, 0)
    assert.ok(!repo.has('merged'))
  })

  test('입력을 읽을 수 없거나 형식이 다르면 2 다', () => {
    const { box } = setup()
    const missing = box.run('delete_branches', [join(box.root, 'none.json')])
    assert.equal(missing.code, 2)
    assert.ok(missing.stderr.startsWith('입력을 읽을 수 없다: '))
    for (const body of ['[{"repo": "x"}]', '{}', 'not json']) {
      const done = box.run('delete_branches', [write(join(box.root, 'o.json'), body)])
      assert.equal(done.code, 2, body)
      assert.equal(done.stdout, '')
    }
    assert.equal(box.run('delete_branches', []).code, 2)
  })

  test('저장소가 없어도 git 실패를 상태로 보이고 계속한다', () => {
    const { box, a, br } = setup()
    const file = write(join(box.root, 'o.json'), JSON.stringify([{ repo: join(box.root, 'nowhere'), base: BASE, branches: [br('merged', a, D)] }]))
    const done = box.run('delete_branches', [file, '--apply'])
    assert.ok(done.stdout.includes('  merged  브랜치가 없다\n'))
  })
})

describe('형식이 틀린 입력', () => {
  test('branches 가 목록이 아니면 아무것도 지우지 않고 실패로 끝난다', () => {
    const { box, repo } = setup()
    const file = write(join(box.root, 'bad.json'), JSON.stringify([{ repo: repo.dir, base: BASE, branches: 'merged' }]))
    const done = box.run('delete_branches', [file, '--apply'])
    assert.notEqual(done.code, 0)
    assert.ok(repo.has('merged'))
  })
})

