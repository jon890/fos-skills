// 런타임 표(references/runtimes.md)와 코드의 표(RUNTIMES 와 옆 함수)가 같은지, 스킬 문서가 런타임 이름을 전제하지 않는지 확인한다(REQ3, REQ6, REQ7).

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { contextOf, diskOf, RUNTIMES, socketsOf, startOf } from '../scripts/container_runtimes.ts'

const SKILL_DIR = join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(SKILL_DIR, rel), 'utf8')
const skill = read('SKILL.md')
const targets = read('references/targets.md')
const runtimes = read('references/runtimes.md')

// 문서의 `## 제목` 절 본문
const section = (text: string, heading: RegExp): string => {
  const start = text.split('\n').findIndex((l) => heading.test(l))
  assert.ok(start >= 0, `${heading} 절이 없다`)
  const rest = text.split('\n').slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return rest.slice(0, end < 0 ? undefined : end).join('\n')
}

const NAMES = /colima|docker desktop|orbstack/i

describe('런타임 표와 코드의 표', () => {
  test('코드의 런타임 정의마다 소켓, context, 디스크 파일, 켜는 명령이 문서 표 줄에 있다', () => {
    const rows = runtimes.split('\n').filter((l) => l.startsWith('| `'))
    for (const def of RUNTIMES) {
      const profile = def.kind === 'colima' ? '<프로필>' : 'default'
      const row = rows.find((l) => l.includes(def.label))
      assert.ok(row, `${def.label} 줄이 없다`)
      for (const socket of socketsOf(def.kind, profile)) assert.ok(row.includes(`\`${socket}\``), `${def.label} 소켓 ${socket}`)
      assert.ok(row.includes(`\`${contextOf(def.kind, profile)}\``), `${def.label} context`)
      assert.ok(row.includes(`\`${diskOf(def.kind, profile)}\``), `${def.label} 디스크 파일`)
      assert.ok(row.includes(`\`${startOf(def.kind, profile).join(' ')}\``), `${def.label} 켜는 명령`)
      assert.ok(row.includes(`\`${def.reclaim}\``), `${def.label} 회수`)
    }
  })

  test('Colima 의 default 프로필 이름 규칙과 알 수 없는 런타임, 원격 엔진 줄이 표에 있다', () => {
    assert.equal(contextOf('colima', 'default'), 'colima')
    assert.equal(diskOf('colima', 'default'), '~/.colima/_lima/_disks/colima/datadisk')
    assert.ok(runtimes.includes('default 프로필은 `colima`'))
    assert.ok(runtimes.includes('`unknown:<context>`') && runtimes.includes('`remote:<context>`'))
  })
})

describe('REQ6 문서가 런타임 이름을 전제하지 않는다', () => {
  test('SKILL.md 와 targets.md 에 특정 런타임 이름이 없고 런타임 표를 가리킨다', () => {
    assert.deepEqual(skill.split('\n').filter((l) => NAMES.test(l)), [])
    assert.deepEqual(targets.split('\n').filter((l) => NAMES.test(l)), [])
    assert.ok(skill.includes('references/runtimes.md') && targets.includes('references/runtimes.md'))
  })

  test('SKILL.md 가 부르는 스크립트와 references 파일이 모두 있다', () => {
    const scripts = new Set([...skill.matchAll(/scripts\/([a-z_]+\.ts)/g)].map((m) => m[1]))
    assert.ok(scripts.has('container_runtimes.ts') && scripts.has('runtime_start.ts') && scripts.has('runtime_reclaim.ts') && scripts.has('survey_docker.ts'))
    assert.ok(targets.includes('docker_cleanup.ts') && !/docker --context \S+ (rmi|builder)|docker builder prune/.test(skill + targets), '이미지·빌드 캐시 삭제는 docker_cleanup.ts 로만 안내한다')
    for (const name of scripts) assert.ok(existsSync(join(SKILL_DIR, 'scripts', name)), name)
    for (const m of skill.matchAll(/references\/([a-z-]+\.md)/g)) assert.ok(existsSync(join(SKILL_DIR, 'references', m[1])), m[1])
  })
})

describe('REQ3 승인 묶음과 REQ7 보고 항목', () => {
  test('3단계는 런타임 이름과 상관없이 런타임마다 따로 묻는 묶음을 요구한다', () => {
    const step = section(skill, /^## 3\. 승인/)
    assert.ok(step.includes('「켜서 조사하기」(꺼진 런타임마다 따로 한 묶음'))
    assert.ok(step.includes('Docker 정리(켜진 런타임마다 따로 한 묶음'))
    assert.ok(step.includes('런타임은 묶음을 합치지 않고 하나씩 묻는다'))
    assert.ok(step.includes('이 맥 밖의 엔진은 어떤 묶음에도 넣지 않는다'))
  })

  test('4단계는 승인한 런타임만 켜고 120초 안에 못 켜면 그 런타임만 건너뛴다', () => {
    const step = section(skill, /^## 4\. 실행/)
    assert.ok(step.includes('runtime_start.ts'))
    assert.ok(step.includes('최대 120초'))
    assert.ok(step.includes('그 런타임만 「켜지 못함」'))
    assert.ok(step.includes('정리가 끝나도 런타임을 끄지 않는다'))
  })

  test('5단계는 확보량, 런타임별 디스크 파일 전후, 정리하지 않은 런타임 세 가지를 보고 항목으로 요구한다', () => {
    const step = section(skill, /^## 5\. 재측정과 보고/)
    assert.ok(step.includes('확보량: 호스트 디스크 여유 전후 값이다'))
    assert.ok(step.includes('런타임별 디스크 파일 전후 크기: 참고 줄이다'))
    assert.ok(step.includes('정리하지 않은 런타임: 켜지 않았거나 켜지 못한 런타임'))
    assert.ok(step.includes('VM 디스크 크기와 함께'))
  })
})
