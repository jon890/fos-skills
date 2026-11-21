// check_pr_branches 의 명령 경계 테스트. gh 는 가짜 실행 파일이고 저장소는 임시 저장소다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Repo, Sandbox, write } from './helpers.ts'

const CLASS = 'PR 확인 필요(-D)'

function setup() {
  const box = new Sandbox()
  const repo = new Repo(join(box.root, 'repo'))
  const a = repo.commit('A')
  repo.git('checkout', '-q', '-b', 'pushed')
  const b = repo.commit('B')
  repo.git('update-ref', 'refs/remotes/origin/pushed', b)
  repo.git('checkout', '-q', '-b', 'ahead')
  const c = repo.commit('C')
  repo.git('checkout', '-q', 'main')
  const survey = (branches: object[]) => write(join(box.root, 'survey.json'), JSON.stringify([{ repo: repo.dir, branches }]))
  return { box, repo, a, b, c, survey }
}

const pr = (number: number, state: string, headRefOid: string, mergedAt: string | null = null) => ({ number, state, headRefOid, mergedAt })

describe('판정', () => {
  test('원격에 없는 로컬 커밋이 0 이면 잃는 커밋 없음이다', () => {
    const { box, b, survey } = setup()
    box.fake('gh', [{ stdout: JSON.stringify([pr(7, 'CLOSED', b)]) }])
    const done = box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }])])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, `${join(box.root, 'repo')}  pushed\n  tip: 조사=${b.slice(0, 8)} 지금=${b.slice(0, 8)} 같음\n  원격에 없는 로컬 커밋: 0\n  PR #7 CLOSED head=tip:예 머지=-\n  판정: 잃는 커밋 없음\n\n1개 확인\n`)
  })

  test('로컬에만 있는 커밋이 있으면 사용자 판단이고 PR head 가 tip 과 다르면 아니오다', () => {
    const { box, b, c, survey } = setup()
    box.fake('gh', [{ stdout: JSON.stringify([pr(8, 'MERGED', b, '2026-01-01T00:00:00Z')]) }])
    const done = box.run('check_pr_branches', [survey([{ name: 'ahead', tip: c, class: CLASS }])])
    assert.ok(done.stdout.includes('  원격에 없는 로컬 커밋: 1\n'), done.stdout)
    assert.ok(done.stdout.includes('  PR #8 MERGED head=tip:아니오 머지=2026-01-01T00:00:00Z\n'))
    assert.ok(done.stdout.includes('  판정: 로컬 커밋 1개, 사용자 판단\n'))
  })

  test('조사 때 tip 과 다르면 다시 조사하게 한다', () => {
    const { box, a, survey } = setup()
    box.fake('gh', [{ stdout: '[]' }])
    const done = box.run('check_pr_branches', [survey([{ name: 'pushed', tip: a, class: CLASS }])])
    assert.ok(done.stdout.includes(`  tip: 조사=${a.slice(0, 8)} 지금=`))
    assert.ok(done.stdout.includes(' 다름\n'))
    assert.ok(done.stdout.includes('  PR: 없음\n'))
    assert.ok(done.stdout.includes('  판정: tip 바뀜, 다시 조사\n'))
  })

  test('브랜치가 없으면 다시 조사하게 한다', () => {
    const { box, a, survey } = setup()
    box.fake('gh', [{ stdout: '[]' }])
    const done = box.run('check_pr_branches', [survey([{ name: 'gone', tip: a, class: CLASS }])])
    assert.ok(done.stdout.includes(`  tip: 조사=${a.slice(0, 8)} 지금=- 다름\n`))
    assert.ok(done.stdout.includes('  원격에 없는 로컬 커밋: ?\n'))
    assert.ok(done.stdout.includes('  판정: 브랜치 없음, 다시 조사\n'))
  })

  test('gh 가 실패하면 그 브랜치만 표시하고 판정은 낸다', () => {
    const { box, b, survey } = setup()
    box.fake('gh', [{ stderr: 'boom', code: 1 }])
    const done = box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }])])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('  PR: gh 확인 실패\n'))
    assert.ok(done.stdout.includes('  판정: 잃는 커밋 없음\n'))
  })

  test('gh 가 PATH 에 없어도 확인 실패로 계속한다', () => {
    const { box, b, survey } = setup()
    const done = box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }])])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes('  PR: gh 확인 실패\n'))
  })

  test('분류가 다른 브랜치는 보지 않고 pr_state 가 null 이어도 읽는다', () => {
    const { box, b, c, survey } = setup()
    box.fake('gh', [{ stdout: '[]' }])
    const done = box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS, pr_state: null }, { name: 'ahead', tip: c, class: '삭제 후보(-d)', pr_state: null }])])
    assert.ok(done.stdout.includes('pushed\n'))
    assert.ok(!done.stdout.includes('ahead'))
    assert.ok(done.stdout.endsWith('\n1개 확인\n'))
  })

  test('후보가 없는 조사 파일은 0개 확인이다', () => {
    const { box, survey } = setup()
    const done = box.run('check_pr_branches', [survey([])])
    assert.equal(done.stdout, '\n0개 확인\n')
  })
})

describe('gh 호출과 옵션', () => {
  test('gh 는 저장소를 cwd 로 최근 5건을 상태 무관하게 묻는다', () => {
    const { box, repo, b, survey } = setup()
    const gh = box.fake('gh', [{ stdout: '[]' }])
    box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }])])
    assert.deepEqual(gh.calls().map((c) => c.argv), [['pr', 'list', '--head', 'pushed', '--state', 'all', '--limit', '5', '--json', 'number,state,headRefOid,mergedAt']])
    assert.equal(gh.calls()[0].cwd, repo.dir)
  })

  test('--pr-limit 은 접두로 줄여 쓸 수 있고 값은 그대로 gh 에 간다', () => {
    const { box, b, survey } = setup()
    const gh = box.fake('gh', [{ stdout: '[]' }])
    box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }]), '--pr-l', '12'])
    assert.equal(gh.calls()[0].argv[7], '12')
    box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }]), '--pr-limit=3'])
    assert.equal(gh.calls()[1].argv[7], '3')
  })

  test('--json 은 들여쓴 JSON 과 줄바꿈 하나를 낸다', () => {
    const { box, repo, b, survey } = setup()
    box.fake('gh', [{ stdout: JSON.stringify([pr(7, 'CLOSED', b)]) }])
    const done = box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }]), '--json'])
    const expected = [{ repo: repo.dir, name: 'pushed', surveyed_tip: b, current_tip: b, tip_same: true, local_only_commits: 0, gh_error: false, prs: [{ number: 7, state: 'CLOSED', head_is_tip: true, merged_at: null }], verdict: '잃는 커밋 없음' }]
    assert.equal(done.stdout, `${JSON.stringify(expected, null, 2)}\n`)
  })

  test('--json 은 한글을 이스케이프하지 않는다', () => {
    const { box, b, survey } = setup()
    box.fake('gh', [{ stdout: '[]' }])
    const done = box.run('check_pr_branches', [survey([{ name: 'pushed', tip: b, class: CLASS }]), '--json'])
    assert.ok(done.stdout.includes('"verdict": "잃는 커밋 없음"'))
  })
})

describe('입력 오류', () => {
  test('조사 파일이 없으면 2 다', () => {
    const { box } = setup()
    const done = box.run('check_pr_branches', [join(box.root, 'none.json')])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.startsWith('조사 JSON 을 읽을 수 없다: '))
    assert.equal(done.stdout, '')
  })

  test('최상위가 목록이 아니면 2 다', () => {
    const { box } = setup()
    const file = write(join(box.root, 'o.json'), '{}')
    const done = box.run('check_pr_branches', [file])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('조사 JSON 을 읽을 수 없다: 최상위가 목록이 아니다'))
  })

  test('JSON 이 깨져 있으면 2 다', () => {
    const { box } = setup()
    const done = box.run('check_pr_branches', [write(join(box.root, 'o.json'), '[')])
    assert.equal(done.code, 2)
  })

  test('인자가 없거나 정수가 아니면 사용법 오류 2 다', () => {
    const { box } = setup()
    assert.equal(box.run('check_pr_branches', []).code, 2)
    const file = write(join(box.root, 'o.json'), '[]')
    const bad = box.run('check_pr_branches', [file, '--pr-limit', 'x'])
    assert.equal(bad.code, 2)
    assert.ok(bad.stderr.includes("argument --pr-limit: invalid int value: 'x'"))
    assert.equal(box.run('check_pr_branches', [file, '--gh-timeout']).code, 2)
    assert.equal(box.run('check_pr_branches', [file, '--nope']).code, 2)
    assert.equal(box.run('check_pr_branches', [file, '--pr-limit', '--', '3']).code, 2)
  })

  test('음수와 앞뒤 공백이 든 정수를 값으로 읽는다', () => {
    const { box } = setup()
    const file = write(join(box.root, 'o.json'), '[]')
    assert.equal(box.run('check_pr_branches', [file, '--pr-limit', '-1']).code, 0)
    assert.equal(box.run('check_pr_branches', [file, '--pr-limit', ' 4 ']).code, 0)
    assert.equal(box.run('check_pr_branches', [file, '--pr-limit', '1_0']).code, 0)
  })
})
