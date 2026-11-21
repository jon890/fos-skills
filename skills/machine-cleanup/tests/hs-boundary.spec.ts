// 홈서버 쪽 코드의 경계를 본다(스펙 REQ11, 설계 「책임과 경계」).
// 1. 홈서버에서 도는 스크립트는 orca 를 부르지 않고 맥 전용 모듈을 import 하지 않는다. 홈서버의 orca 는 화면 낭독기다.
// 2. 스킬 폴더(tests 제외)에 홈서버 고유 값이 없다. 공개 저장소라 실제 값 목록은 커밋하지 않고 값의 꼴로 막는다.
//    환경 변수 MACHINE_CLEANUP_PRIVATE_WORDS 가 커밋하지 않는 목록 파일(줄마다 낱말 하나)을 가리키면 그 낱말도 찾는다.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { importClosure } from '../scripts/remote.ts'

const SKILL = join(import.meta.dirname, '..')
const REMOTE_SCRIPTS = ['hs_survey.ts', 'hs_delete.ts', 'delete_branches.ts', 'delete_sessions.ts']
const MAC_ONLY = ['container_runtimes.ts', 'survey_system.ts', 'docker_volumes.ts', 'docker_images.ts', 'colima_trim.ts', 'runtime_reclaim.ts', 'runtime_start.ts', 'survey_docker.ts', 'docker_cleanup.ts']

describe('홈서버에서 도는 스크립트', () => {
  for (const script of REMOTE_SCRIPTS) {
    test(`${script} 의 import 에 맥 전용 모듈과 orca 호출이 없다`, () => {
      const files = importClosure(join(SKILL, 'scripts', script), SKILL)
      for (const f of files) {
        assert.ok(!MAC_ONLY.some((m) => f.endsWith(`/${m}`)), `${script} → ${f}`)
        assert.doesNotMatch(readFileSync(join(SKILL, f), 'utf8'), /\[\s*['"]orca['"]/, `${f} 가 orca 를 부른다`)
      }
    })
  }
})

const skillFiles = (): string[] => {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'tests') walk(p)
      } else out.push(p)
    }
  }
  walk(SKILL)
  return out
}

describe('홈서버 고유 값(REQ11)', () => {
  test('사용자 홈 아래 절대 경로와 /opt 경로가 없다', () => {
    for (const f of skillFiles()) {
      const text = readFileSync(f, 'utf8')
      assert.doesNotMatch(text, /(?<![\w*/.-])\/home\/[A-Za-z][^\s/]*\//, relative(SKILL, f))
      assert.doesNotMatch(text, /(?<![\w*/.-])\/opt\//, relative(SKILL, f))
    }
  })

  const wordsFile = process.env.MACHINE_CLEANUP_PRIVATE_WORDS
  test('커밋하지 않는 실제 값 목록의 낱말이 없다', { skip: wordsFile ? false : 'MACHINE_CLEANUP_PRIVATE_WORDS 가 없다' }, () => {
    const words = readFileSync(wordsFile!, 'utf8').split('\n').map((w) => w.trim()).filter(Boolean)
    for (const f of skillFiles()) {
      const text = readFileSync(f, 'utf8')
      for (const w of words) assert.ok(!new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text), `${relative(SKILL, f)} 에 비공개 낱말이 있다`)
    }
  })
})
