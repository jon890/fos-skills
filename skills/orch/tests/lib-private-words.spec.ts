// lib/private-words.ts 의 목록 읽기, 위치 찾기, 값 가리기, 공개 여부 기억을 본다. 스펙은 docs/features/private-leak-guard/spec.md 다.
// 가상 낱말만 쓴다. 실제 목록(~/.config/orch/private-words.txt)은 읽지 않는다. 목록 경로와 머신 폴더는 임시 폴더로 바꾼다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { privateWordsLines } from '../scripts/doctor/orch-doctor.ts'
import type { Visibility } from '../scripts/lib/private-words.ts'
import {
  commentRows,
  diffFindings,
  FAILED_TTL_MS,
  findingsText,
  mask,
  messageFindings,
  nameFindings,
  privateWordsPath,
  readPrivateWords,
  redactLine,
  repoVisibility,
  textFindings,
  VISIBILITY_TTL_MS,
} from '../scripts/lib/private-words.ts'

const WORD = 'example-secret'
let tmp = ''
const saved: Record<string, string | undefined> = {}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'private-words-'))
  for (const key of ['HOME', 'ORCH_MACHINE_DIR', 'ORCH_PRIVATE_WORDS']) saved[key] = process.env[key]
  delete process.env.ORCH_PRIVATE_WORDS
  process.env.ORCH_MACHINE_DIR = join(tmp, 'machine')
})
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

function list(text: string): string {
  const file = join(mkdtempSync(join(tmp, 'list-')), 'private-words.txt')
  writeFileSync(file, text)
  return file
}

describe('목록', () => {
  test('한 줄에 낱말 하나이고 빈 줄과 # 줄은 건너뛴다(REQ1)', () => {
    const words = readPrivateWords(list(`# 주석\n\n  ${WORD}  \nOther-Host\n`))
    assert.deepEqual(words, [{ word: WORD, line: 3 }, { word: 'other-host', line: 4 }])
  })

  test('없거나 비었으면 빈 목록이다(REQ2)', () => {
    assert.deepEqual(readPrivateWords(join(tmp, 'none.txt')), [])
    assert.deepEqual(readPrivateWords(list('# 주석만\n\n')), [])
  })

  test('목록 자리는 홈 아래 한 곳이고 ORCH_PRIVATE_WORDS 로만 바꾼다', () => {
    assert.equal(privateWordsPath('/h'), '/h/.config/orch/private-words.txt')
    process.env.ORCH_PRIVATE_WORDS = '/x/words.txt'
    try {
      assert.equal(privateWordsPath(), '/x/words.txt')
    } finally {
      delete process.env.ORCH_PRIVATE_WORDS
    }
  })

  test('가리기는 대소문자를 가리지 않고 정규식 문자도 그대로 찾는다', () => {
    const special = [{ word: 'a.b+c', line: 1 }]
    assert.equal(mask('xA.B+Cy aXb+c', special), 'x***y aXb+c')
    assert.equal(mask('İ example-secret', [{ word: 'example-secret', line: 1 }]), 'İ ***')
  })
})

describe('찾기', () => {
  const words = readPrivateWords(list(`${WORD}\n`))

  test('대소문자를 가리지 않고 줄마다 위치와 목록 줄을 낸다', () => {
    assert.deepEqual(textFindings(`첫 줄\n/srv/${WORD.toUpperCase()}/x\n`, words, 'PR 본문'), [{ where: 'PR 본문 2번째 줄', entry: 1 }])
    assert.equal(findingsText([{ where: 'a:3', entry: 1 }]), 'a:3(목록 1번째 줄)')
  })

  test('더한 줄만 보고 지운 줄은 보지 않는다(REQ3)', () => {
    const diff = [
      'diff --git a/old.txt b/old.txt',
      '--- a/old.txt',
      '+++ b/old.txt',
      '@@ -4 +3,0 @@',
      `-${WORD} 를 지운다`,
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,3 @@',
      '+깨끗한 줄',
      `+++ ${WORD} 로 시작하는 더한 줄`,
      '+또 깨끗한 줄',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      `-${WORD}`,
    ].join('\n')
    assert.deepEqual(diffFindings(diff, words), [{ where: 'new.txt:2', entry: 1 }])
  })

  test('파일 이름에 낱말이 있으면 가려서 알린다', () => {
    assert.deepEqual(nameFindings([`docs/${WORD}.md`, 'ok.md'], words), [{ where: '파일 이름 docs/***.md', entry: 1 }])
    assert.equal(mask(`a/${WORD}/${WORD.toUpperCase()}`, words), 'a/***/***')
  })

  test('커밋 메시지는 자르는 줄 아래를 보지 않는다', () => {
    const message = `제목\n\n본문 ${WORD}\n# ------------------------ >8 ------------------------\n+${WORD}\n`
    assert.deepEqual(messageFindings(message, words), [{ where: '커밋 메시지 3번째 줄', entry: 1 }])
  })

  test('보류 이유에 낱말이 있으면 위치만 남긴다(REQ5)', () => {
    assert.equal(redactLine('배포 대기', words, 'PR 본문', '머지 보류: 배포 대기'), '배포 대기')
    assert.equal(redactLine(`${WORD} 확인 전`, words, 'PR 본문', `본문\n- 머지 보류: ${WORD} 확인 전`), '비공개 낱말이 있어 값을 생략한다(PR 본문 2번째 줄)')
  })

  test('댓글 줄은 [id, body] JSON 이고 깨지면 null 이다', () => {
    assert.deepEqual(commentRows('[1,"a\\nb"]\n[2,null]\n'), [{ id: '1', body: 'a\nb' }, { id: '2', body: '' }])
    assert.equal(commentRows('not json\n'), null)
  })
})

describe('공개 여부 기억(REQ6)', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmp, 'repo-'))
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0)
    return dir
  }

  test('같은 저장소는 기한 안에 다시 묻지 않는다', () => {
    const dir = repo()
    let calls = 0
    const lookup = (): Visibility => { calls += 1; return 'public' }
    assert.equal(repoVisibility(dir, lookup, 1000), 'public')
    assert.equal(repoVisibility(dir, lookup, 1000 + VISIBILITY_TTL_MS - 1), 'public')
    assert.equal(calls, 1)
    assert.equal(repoVisibility(dir, lookup, 1000 + VISIBILITY_TTL_MS), 'public')
    assert.equal(calls, 2)
  })

  test('읽지 못한 결과는 짧게 기억한다', () => {
    const dir = repo()
    let calls = 0
    const lookup = (): Visibility => { calls += 1; return 'unknown' }
    assert.equal(repoVisibility(dir, lookup, 0), 'unknown')
    assert.equal(repoVisibility(dir, lookup, FAILED_TTL_MS - 1), 'unknown')
    assert.equal(calls, 1)
    repoVisibility(dir, lookup, FAILED_TTL_MS)
    assert.equal(calls, 2)
  })
})

describe('doctor 안내(REQ2)', () => {
  function home(words: string | null): void {
    const dir = mkdtempSync(join(tmp, 'home-'))
    if (words !== null) {
      mkdirSync(join(dir, '.config', 'orch'), { recursive: true })
      writeFileSync(join(dir, '.config', 'orch', 'private-words.txt'), words)
    }
    process.env.HOME = dir
  }

  test('공개 저장소에서 목록이 없으면 한 줄로 알리고, 있거나 비공개면 내지 않는다', () => {
    const dir = mkdtempSync(join(tmp, 'doctor-'))
    home(null)
    const lines = privateWordsLines(dir, () => 'public')
    assert.match(lines[0], /^PRIVATE-WORDS-MISSING .*\.config\/orch\/private-words\.txt$/)
    assert.equal(lines.filter((line) => !line.startsWith('  ')).length, 1)
    home('# 비었다\n')
    assert.equal(privateWordsLines(mkdtempSync(join(tmp, 'doctor-')), () => 'public').length, 2)
    assert.deepEqual(privateWordsLines(mkdtempSync(join(tmp, 'doctor-')), () => 'private'), [])
    assert.deepEqual(privateWordsLines(mkdtempSync(join(tmp, 'doctor-')), () => 'unknown'), [])
    home(`${WORD}\n`)
    let asked = false
    assert.deepEqual(privateWordsLines(mkdtempSync(join(tmp, 'doctor-')), () => { asked = true; return 'public' }), [])
    assert.equal(asked, false)
  })
})
