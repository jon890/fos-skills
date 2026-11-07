// check_rename_drift 의 명령 경계 테스트. 임시 git 저장소에서 SKILL.md 의 절 이름을 바꾸고 참조 문서를 고쳤는지 본다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Repo } from './helpers.ts'

function repo(skill: string, refs: Record<string, string> = { 'references/a.md': '# 참조\n\n## 옛 절\n본문\n' }): Repo {
  const r = new Repo('hc-drift-', true)
  r.file('skills/s/SKILL.md', skill)
  for (const [name, text] of Object.entries(refs)) r.file(`skills/s/${name}`, text)
  r.commitAll('init')
  return r
}

const BASE = '---\nname: s\n---\n\n## 옛 절\n\n설명\n'

describe('드리프트 판정', () => {
  test('절 이름을 바꾸고 참조 문서를 안 고치면 1', () => {
    const r = repo(BASE)
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    const done = r.run('check_rename_drift', [r.root])
    assert.equal(done.code, 1)
    assert.equal(done.stdout, 'DRIFT: ./skills/s/SKILL.md 에서 "옛 절" 을 바꿨는데 참조 문서가 그대로다 — ./skills/s/references/a.md\n')
    assert.equal(done.stderr, '검사한 SKILL.md: 1개, 드리프트: 1건\n')
  })

  test('참조 문서도 함께 고치면 0', () => {
    const r = repo(BASE)
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    r.file('skills/s/references/a.md', '# 참조\n\n## 새 절\n본문\n')
    const done = r.run('check_rename_drift', [r.root])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '')
    assert.equal(done.stderr, '검사한 SKILL.md: 1개, 드리프트: 0건\n')
  })

  test('굵은 라벨과 목록 마커 뒤의 라벨과 괄호 꼬리를 같은 이름으로 본다', () => {
    const r = repo('---\nname: s\n---\n\n- **옛 라벨** (설명)\n', { 'references/a.md': '옛 라벨 이 여기 있다\n' })
    r.file('skills/s/SKILL.md', '---\nname: s\n---\n\n- **새 라벨**\n')
    const done = r.run('check_rename_drift', [r.root])
    assert.equal(done.code, 1)
    assert.ok(done.stdout.includes('"옛 라벨" 을 바꿨는데'), done.stdout)
  })

  test('이름이 지금도 SKILL.md 에 있으면 이동이라 건너뛴다', () => {
    const r = repo(BASE + '\n### 다른\n')
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '### 옛 절') + '\n### 다른\n')
    const done = r.run('check_rename_drift', [r.root])
    assert.equal(done.code, 0, done.stdout)
  })

  test('기준 커밋에 없던 참조 문서는 대상이 아니다', () => {
    const r = repo(BASE, {})
    mkdirRefs(r)
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    r.file('skills/s/references/new.md', '옛 절 을 새 문서로 옮겼다\n')
    const done = r.run('check_rename_drift', [r.root])
    assert.equal(done.code, 0, done.stdout)
  })

  test('라벨을 담은 문서 가운데 하나라도 함께 바뀌었으면 반영된 것이다', () => {
    const r = repo(BASE, { 'references/a.md': '옛 절 가\n', 'references/b.md': '옛 절 나\n' })
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    r.file('skills/s/references/a.md', '옛 절 가 새 절 도 적었다\n')
    assert.equal(r.run('check_rename_drift', [r.root]).code, 0)
    // 바뀐 문서가 라벨을 더 이상 담지 않으면 남은 문서만 본다
    r.file('skills/s/references/a.md', '새 절 가\n')
    assert.equal(r.run('check_rename_drift', [r.root]).code, 1)
  })

  test('둘 다 안 고치면 문서를 모두 나열한다', () => {
    const r = repo(BASE, { 'references/a.md': '옛 절 가\n', 'references/b.md': '옛 절 나\n', 'references/c.md': '무관\n' })
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    const done = r.run('check_rename_drift', [r.root])
    assert.equal(done.stdout, 'DRIFT: ./skills/s/SKILL.md 에서 "옛 절" 을 바꿨는데 참조 문서가 그대로다 — ./skills/s/references/a.md ./skills/s/references/b.md\n')
  })

  test('기준 커밋을 인자로 주면 그 대비로 본다', () => {
    const r = repo(BASE)
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    r.commitAll('rename')
    assert.equal(r.run('check_rename_drift', [r.root]).code, 2)
    assert.equal(r.run('check_rename_drift', [r.root, 'HEAD~1']).code, 1)
  })
})

describe('대상과 인자', () => {
  test('바뀐 SKILL.md 가 없으면 2 와 안내', () => {
    const r = repo(BASE)
    const done = r.run('check_rename_drift', [r.root])
    assert.equal(done.code, 2)
    assert.equal(done.stdout, '')
    assert.match(done.stderr, /^검사 대상 없음 — 기준 'HEAD' 대비 변경된 SKILL\.md 가 하나도 없다\.\n기준을 바꾸거나 변경을 커밋한 뒤 다시 돌린다\.\n다른 지침의 절 참조는 check_references\.(py|ts) 가 본다\.\n$/)
  })

  test('references 폴더가 없는 스킬은 건너뛴다', () => {
    const r = repo(BASE, {})
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    assert.equal(r.run('check_rename_drift', [r.root]).code, 2)
  })

  test('인자가 없거나 저장소가 없으면 2', () => {
    const r = repo(BASE)
    const none = r.run('check_rename_drift', [])
    assert.equal(none.code, 2)
    assert.ok(none.stderr.includes('<대상 저장소> [<기준 커밋>]'), none.stderr)
    const missing = r.run('check_rename_drift', [`${r.root}/nope`])
    assert.equal(missing.code, 2)
    assert.equal(missing.stderr, `대상 저장소가 없다: ${r.root}/nope\n`)
  })

  test('--scope 는 그 아래 SKILL.md 만 보고 틀리면 2', () => {
    const r = repo(BASE)
    r.file('skills/t/SKILL.md', '---\nname: t\n---\n\n## 옛 절\n')
    r.file('skills/t/references/a.md', '옛 절\n')
    r.commitAll('t')
    r.file('skills/s/SKILL.md', BASE.replace('## 옛 절', '## 새 절'))
    r.file('skills/t/SKILL.md', '---\nname: t\n---\n\n## 새 절\n')
    const all = r.run('check_rename_drift', [r.root])
    assert.equal(all.code, 1)
    assert.equal(all.stdout.split('DRIFT').length - 1, 2)
    const one = r.run('check_rename_drift', [r.root, '--scope', 'skills/s'])
    assert.equal(one.stdout.split('DRIFT').length - 1, 1)
    assert.equal(r.run('check_rename_drift', [r.root, 'HEAD', '--scope=skills/s/SKILL.md']).code, 1)
    assert.equal(r.run('check_rename_drift', [r.root, '--scope', 'zz']).code, 2)
    assert.equal(r.run('check_rename_drift', [r.root, '--scope', 'skills/s/references']).code, 2)
  })

  test('node_modules 와 tasks 아래 SKILL.md 는 보지 않는다', () => {
    const r = repo(BASE)
    r.file('node_modules/x/SKILL.md', '## 옛 절\n')
    r.file('node_modules/x/references/a.md', '옛 절\n')
    r.file('tasks/x/SKILL.md', '## 옛 절\n')
    r.file('tasks/x/references/a.md', '옛 절\n')
    r.commitAll('add')
    r.file('node_modules/x/SKILL.md', '## 새 절\n')
    r.file('tasks/x/SKILL.md', '## 새 절\n')
    assert.equal(r.run('check_rename_drift', [r.root]).code, 2)
  })

  test('찾은 SKILL.md 를 정렬한 순서로 낸다', () => {
    const r = repo(BASE)
    for (const n of ['z', 'a']) {
      r.file(`skills/${n}/SKILL.md`, '---\nname: x\n---\n\n## 옛 절\n')
      r.file(`skills/${n}/references/a.md`, '옛 절\n')
    }
    r.commitAll('more')
    for (const n of ['z', 'a', 's']) r.file(`skills/${n}/SKILL.md`, '---\nname: x\n---\n\n## 새 절\n')
    const done = r.run('check_rename_drift', [r.root])
    const order = done.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[1])
    assert.deepEqual(order, ['./skills/a/SKILL.md', './skills/s/SKILL.md', './skills/z/SKILL.md'])
  })
})

function mkdirRefs(r: Repo): void {
  r.file('skills/s/references/.keep', '')
  r.commitAll('refs')
}
