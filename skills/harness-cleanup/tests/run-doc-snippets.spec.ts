// run_doc_snippets 의 명령 경계 테스트. 블록 추출, --list 의 위험 표시, --block 번호, 머리말 추출, 실행 출력의 꼴을 본다.
// bash 와 zsh 가 모두 있으면 두 셸의 줄을 다 본다. zsh 가 없는 환경은 CI 가 설치한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { gitEnv } from '../../../modules/testkit/git.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { Repo, type Result, run, write } from './helpers.ts'

const RULE = '─'.repeat(37)
const HAS_ZSH = spawnSync('zsh', ['-c', 'true']).status === 0

function doc(text: string): { dir: string; path: string; snip: (...args: string[]) => Result } {
  const dir = tempDir('hc-snip-')
  const path = write(join(dir, 'doc.md'), text)
  return { dir, path, snip: (...args) => run('run_doc_snippets', [path, ...args], { cwd: dir }) }
}

const fence = (body: string, lang = 'bash') => `\`\`\`${lang}\n${body}\n\`\`\`\n`

describe('--list', () => {
  const DOC = `# 문서\n\n안전한 블록이다.\n\n${fence('echo SAFE_MARK > "$MARK_FILE"')}\n위험한 블록이다.\n\n${fence('gh pr merge 1')}\n${fence('git push origin main')}`

  test('블록마다 번호, 시작 줄, 머리말, 첫 줄을 낸다', () => {
    const d = doc(DOC)
    const done = d.snip('--list')
    assert.equal(done.code, 0)
    assert.equal(
      done.stdout,
      '  1  5행  안전한 블록이다.  |  echo SAFE_MARK > "$MARK_FILE"\n  2  11행  위험한 블록이다.  |  gh pr merge 1  [위험: gh]\n  3  15행  ```  |  git push origin main  [위험: git push]\n',
    )
  })

  test('실행하지 않는다', () => {
    const dir = tempDir('hc-snip-')
    const marker = join(dir, 'executed')
    const d = doc(fence(`touch ${marker}`))
    assert.equal(d.snip('--list').code, 0)
    assert.ok(!existsSync(marker))
  })

  test('위험 명령 패턴과 안 걸리는 낱말', () => {
    const risky = ['git commit -m x', 'git -C /x checkout main', 'git reset --hard', 'git clean -fd', 'git merge a', 'git rebase main', 'gh pr list', 'orca worktree ls', 'nhncloud configure x', 'foo --apply', 'rm -rf /tmp/x', 'rm -f a', 'kill 1', 'killall x', 'pkill x']
    const safe = ['git status', 'git log', 'ghost run', 'rm file', 'skill x', 'echo --apply한글', 'orcax a', 'mygh a', 'nhncloud list', 'git pushx']
    const d = doc([...risky, ...safe].map((c) => fence(c)).join('\n'))
    const lines = d.snip('--list').stdout.split('\n').filter(Boolean)
    assert.equal(lines.length, risky.length + safe.length)
    risky.forEach((c, i) => assert.ok(lines[i].includes('[위험: '), `${c}: ${lines[i]}`))
    safe.forEach((c, i) => assert.ok(!lines[risky.length + i].includes('[위험'), `${c}: ${lines[risky.length + i]}`))
    assert.ok(lines[1].endsWith('[위험: git -C /x checkout]'), lines[1])
    assert.ok(lines[11].endsWith('[위험: rm -f]'), lines[11])
    assert.ok(lines[12].endsWith('[위험: kill]'), lines[12])
  })

  test('한 블록이 여러 패턴에 걸리면 패턴 순서로 모두 낸다', () => {
    const d = doc(fence('gh pr create\ngit push\nkill 1'))
    assert.ok(d.snip('--list').stdout.endsWith('[위험: git push, gh, kill]\n'))
  })

  test('머리말은 50자, 첫 줄은 70자로 자르고 빈 줄을 건너뛴다', () => {
    const d = doc(`${'가'.repeat(60)}\n\n${fence(`\n\n${'나'.repeat(80)}`)}`)
    assert.equal(d.snip('--list').stdout, `  1  3행  ${'가'.repeat(50)}  |  ${'나'.repeat(70)}\n`)
  })

  test('sh 블록도 bash 블록으로 센다. zsh 와 text 블록은 세지 않는다', () => {
    const d = doc(`${fence('echo a', 'sh')}${fence('echo b', 'zsh')}${fence('echo c', 'text')}${fence('echo d', 'bash')}`)
    const lines = d.snip('--list').stdout.split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    assert.ok(lines[0].includes('echo a') && lines[1].includes('echo d'))
  })

  test('블록이 없으면 3', () => {
    const d = doc('본문뿐\n')
    const done = d.snip('--list')
    assert.equal(done.code, 3)
    assert.equal(done.stderr, 'bash 블록을 찾지 못했다\n')
  })

  test('--list 는 어디에 있어도 받고 --block 보다 우선한다', () => {
    const d = doc(fence('echo a'))
    assert.equal(d.snip('--list', '--block', '9').code, 0)
    assert.equal(run('run_doc_snippets', ['--list', d.path]).code, 0)
  })

  test('본문 줄바꿈이 CRLF 여도 같은 블록으로 읽는다', () => {
    const d = doc('# 제목\r\n\r\n```bash\r\necho a\r\n```\r\n')
    assert.ok(d.snip('--list').stdout.includes('echo a'))
  })
})

describe('--block 과 인자', () => {
  const DOC = `${fence('echo FIRST')}\n${fence('echo SECOND')}`

  test('번호의 블록 하나만 돈다', () => {
    const dir = tempDir('hc-snip-')
    const marker = join(dir, 'mark')
    const d = doc(`${fence(`touch ${marker}`)}\n${fence('echo SECOND')}`)
    const done = d.snip('--block', '2')
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('블록 2/2 (1줄)\n'))
    assert.ok(done.stdout.includes('SECOND'))
    assert.ok(!existsSync(marker))
  })

  test('범위 밖 번호는 3 이고 번호가 없으면 2', () => {
    const d = doc(DOC)
    const out = d.snip('--block', '9')
    assert.equal(out.code, 3)
    assert.equal(out.stderr, '블록 9 이 없다 (블록 2개)\n')
    assert.equal(d.snip('--block', '0').code, 3)
    assert.equal(d.snip('--block', '-1').stderr, '블록 -1 이 없다 (블록 2개)\n')
    const none = d.snip('--block')
    assert.equal(none.code, 2)
    assert.equal(none.stderr, '--block 에 블록 번호가 필요하다\n')
    assert.equal(d.snip('--block', 'x').code, 2)
    assert.equal(d.snip('--block', '').code, 2)
  })

  test('번호는 파이썬 int 처럼 읽는다', () => {
    const d = doc(DOC)
    for (const n of [' 2 ', '+2', '２', '0_2', '٢']) assert.ok(d.snip('--block', n).stdout.includes('블록 2/2'), n)
    assert.equal(d.snip('--block', '1_0').stderr, '블록 10 이 없다 (블록 2개)\n')
    assert.equal(d.snip('--block', '1__0').code, 2)
    assert.equal(d.snip('--block', '_1').code, 2)
    assert.equal(d.snip('--block', '1.5').code, 2)
  })

  test('--block=값 꼴은 옵션이 아니라 머리말이다', () => {
    const d = doc(DOC)
    const done = d.snip('--block=2')
    assert.equal(done.code, 3)
    assert.equal(done.stderr, '"--block=2" 뒤에서 bash 블록을 찾지 못했다\n')
  })

  test('인자가 없으면 사용법과 2', () => {
    const done = run('run_doc_snippets', [])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('사용법:'), done.stderr)
    assert.ok(done.stderr.includes('--block <번호>'))
    assert.equal(done.stdout, '')
  })

  test('파일이 없거나 디렉터리면 2', () => {
    const d = doc('x')
    const missing = run('run_doc_snippets', [join(d.dir, 'nope.md')], { cwd: d.dir })
    assert.equal(missing.code, 2)
    assert.equal(missing.stderr, `파일이 없다: ${join(d.dir, 'nope.md')}\n`)
    assert.equal(run('run_doc_snippets', [d.dir]).code, 2)
  })
})

describe('실행', () => {
  test('머리말 뒤 첫 블록 하나만 돌고 안내 두 줄로 끝난다', () => {
    const d = doc(`# 문서\n\n안전한 블록이다.\n\n${fence('echo MARK_OUT')}\n${fence('echo OTHER')}`)
    const done = d.snip('안전한 블록이다.')
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith(`추출한 블록 (1줄)\n${RULE}\n[bash] 문법 OK / 출력 1줄\n    MARK_OUT\n`), done.stdout)
    assert.ok(!done.stdout.includes('OTHER'))
    assert.ok(done.stdout.endsWith(`${RULE}\n출력이 0줄이면 음성 대조를 하라 — 검사 대상 경로에 탐지 대상을 심고\n같은 블록이 그것을 잡아내는지 확인한다. 잡지 못하면 검사가 도는 것이 아니다.\n`))
  })

  test('머리말이 정규식 글자를 담아도 글자 그대로 찾는다', () => {
    const d = doc(`a.*b (c)\n${fence('echo HIT')}\n`)
    assert.ok(d.snip('a.*b (c)').stdout.includes('HIT'))
    assert.equal(d.snip('axxb (c)').code, 3)
  })

  test('머리말 뒤에 블록이 없으면 3', () => {
    const d = doc('머리말\n본문뿐\n')
    const done = d.snip('머리말')
    assert.equal(done.code, 3)
    assert.equal(done.stderr, '"머리말" 뒤에서 bash 블록을 찾지 못했다\n')
  })

  test('머리말을 생략하면 블록을 모두 돈다', () => {
    const d = doc(`${fence('echo ONE')}\n${fence('echo TWO\necho THREE')}`)
    const done = d.snip()
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('블록 2개를 돈다\n블록 1/2 (1줄)\n'), done.stdout)
    assert.ok(done.stdout.includes('블록 2/2 (2줄)\n'))
    assert.ok(done.stdout.includes('[bash] 문법 OK / 출력 2줄\n    TWO\n    THREE\n'))
  })

  test('블록이 없으면 3', () => {
    const d = doc('본문뿐\n')
    const done = d.snip()
    assert.equal(done.code, 3)
    assert.equal(done.stderr, 'bash 블록을 찾지 못했다\n')
  })

  test('표준 출력 뒤에 표준 오류를 붙이고 빈 줄은 세지 않으며 열 줄까지 보인다', () => {
    const d = doc(fence('echo a\necho\necho b >&2'))
    const done = d.snip('--block', '1')
    assert.ok(done.stdout.includes('[bash] 문법 OK / 출력 2줄\n    a\n    \n    b\n'), done.stdout)
    const many = doc(fence('seq 1 15'))
    const out = many.snip('--block', '1').stdout
    assert.ok(out.includes('[bash] 문법 OK / 출력 15줄\n    1\n'))
    assert.ok(out.includes('    10\n') && !out.includes('    11\n'))
  })

  test('문법 오류는 실행하지 않고 오류 줄을 보여 주며 종료 코드는 0', () => {
    const dir = tempDir('hc-snip-')
    const marker = join(dir, 'ran')
    const d = doc(fence(`touch ${marker}\necho "unterminated`))
    const done = d.snip('--block', '1')
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('[bash] 문법 오류\n    '), done.stdout)
    assert.ok(!existsSync(marker))
  })

  test('블록이 실패해도 종료 코드는 0 이다', () => {
    const d = doc(fence('exit 7'))
    const done = d.snip('--block', '1')
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('[bash] 문법 OK / 출력 0줄\n'))
  })

  test('셸이 두 개 다 있으면 bash 다음 zsh 순서로 돈다', { skip: !HAS_ZSH }, () => {
    const d = doc(fence('echo "$0" | sed s,.*/,, ; echo ${BASH_VERSION:+bash}${ZSH_VERSION:+zsh}'))
    const out = d.snip('--block', '1').stdout
    assert.ok(out.indexOf('[bash] 문법 OK') < out.indexOf('[zsh] 문법 OK'), out)
    assert.ok(out.includes('    bash\n') && out.includes('    zsh\n'), out)
  })

  test('zsh 가 없으면 한 줄 알리고 bash 만 돈다', () => {
    const bin = tempDir('hc-bin-')
    symlinkSync('/bin/bash', join(bin, 'bash'))
    const d = doc(fence('echo hi'))
    const done = run('run_doc_snippets', [d.path, '--block', '1'], { cwd: d.dir, env: { ...gitEnv(), PATH: bin } })
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes('[bash] 문법 OK / 출력 1줄\n    hi\n'), done.stdout)
    assert.ok(done.stdout.includes('zsh 없음, bash 만\n'), done.stdout)
    assert.equal(done.stdout.split('zsh 없음').length - 1, 1)
    const many = doc(`${fence('echo one')}\n${fence('echo two')}`)
    const all = run('run_doc_snippets', [many.path], { cwd: many.dir, env: { ...gitEnv(), PATH: bin } })
    assert.equal(all.code, 0, all.stderr)
    assert.equal(all.stdout.split('zsh 없음').length - 1, 1, all.stdout)
    assert.equal(all.stdout.split('[bash] 문법 OK').length - 1, 2)
  })

  test('임시 스크립트 파일을 남기지 않는다', () => {
    const d = doc(fence('echo "$0"'))
    const done = d.snip('--block', '1')
    const script = done.stdout.split('\n').find((l) => l.startsWith('    /'))!.trim()
    assert.ok(!existsSync(script), script)
  })

  test('Repo 도우미가 만든 임시 저장소에서도 같다', () => {
    const r = new Repo('hc-snip-', true)
    r.file('doc.md', fence('git rev-parse --is-inside-work-tree'))
    const done = r.run('run_doc_snippets', ['doc.md', '--block', '1'])
    assert.ok(done.stdout.includes('    true\n'))
  })
})
