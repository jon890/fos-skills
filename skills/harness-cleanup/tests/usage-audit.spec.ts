// 사용 기록 모드 명령(extract_skill_usage, render_session, model_fit_signals)의 명령 경계 테스트.
// 실제 대화 기록은 쓰지 않고 임시 jsonl 표본을 쓴다. session_log 의 읽기, 가리기, 세션 id 처리도 이 출력으로 본다.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { Repo, type Result, run, write } from './helpers.ts'

type Rec = Record<string, unknown>
const SID = 'abcdef1234'
const skillCall = (skill: string, ts: string, id: string, extra: Rec = {}): Rec => ({
  type: 'assistant', timestamp: ts, sessionId: SID, ...extra,
  message: { model: 'test-model', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
})
const user = (text: string, ts: string, extra: Rec = {}): Rec => ({ type: 'user', timestamp: ts, sessionId: SID, ...extra, message: { content: text } })
const toolError = (ts: string, body: unknown = '실패'): Rec => ({ type: 'user', timestamp: ts, sessionId: SID, message: { content: [{ type: 'tool_result', is_error: true, content: body }] } })

// 사용법 안내 문구의 「docstring」 은 옮긴 구현에서 「머리 주석」 이다. 두 구현의 stderr 를 같은 글자로 맞춰 본다
const docWord = (r: Result): Result => ({ ...r, stderr: r.stderr.replaceAll('머리 주석에 있다', 'docstring 에 있다') })

class Case {
  readonly base = tempDir('hc-usage-')
  readonly projects = join(this.base, 'projects')
  readonly out = join(this.base, 'out')
  session(name: string, records: unknown[], dir = '-repo', tail = '{깨진 줄\n'): string {
    return write(join(this.projects, dir, `${name}.jsonl`), records.map((r) => `${JSON.stringify(r)}\n`).join('') + tail)
  }
  extract(...args: string[]): Result {
    return docWord(run('extract_skill_usage', ['--projects', this.projects, ...args], { cwd: this.base }))
  }
  rows(done: Result): Record<string, string[]> {
    return Object.fromEntries(done.stdout.split('\n').filter((l) => l.includes('\t') && !l.startsWith('skill\t')).map((l) => [l.split('\t')[0], l.split('\t').slice(1)]))
  }
}

describe('extract_skill_usage 집계', () => {
  test('user 와 assistant 레코드만 센다', () => {
    const c = new Case()
    const call = skillCall('fos-skills:plan', '2026-10-10T00:00:00Z', 't1')
    const blob = { type: 'api-request-blob', sessionId: SID, message: call.message }
    c.session(SID, [call, blob, blob, user('그게 아니라 다시 해', '2026-10-10T00:01:00Z'), toolError('2026-10-10T00:02:00Z')])
    const done = c.extract('--skill', 'plan')
    assert.equal(done.code, 0, done.stderr)
    // calls, main, with_correction, with_interrupt, tool_errors, reinvoked, friction
    assert.deepEqual(c.rows(done)['plan'], ['1', '1', '1', '0', '1', '0', '4'])
    assert.equal(done.stdout, '# 읽은 파일 1, 호출 1\nskill\tcalls\tmain\twith_correction\twith_interrupt\ttool_errors\treinvoked\tfriction\nplan\t1\t1\t1\t0\t1\t0\t4\n')
  })

  test('--skill 과 --since 로 범위를 좁힌다', () => {
    const c = new Case()
    c.session(SID, [skillCall('plan', '2026-09-01T00:00:00Z', 't1'), skillCall('plan', '2026-10-05T00:00:00Z', 't2'), user('<command-name>/orch</command-name>', '2026-10-06T00:00:00Z')])
    const rows = c.rows(c.extract('--since', '2026-10-01'))
    assert.equal(rows['plan'][0], '1')
    assert.equal(rows['orch'][0], '1')
    assert.ok(!('orch' in c.rows(c.extract('--skill', 'plan'))))
    assert.deepEqual(Object.keys(c.rows(c.extract('--skill', 'plan', '--skill', 'fos-skills:orch'))), ['plan', 'orch'])
  })

  test('호출 수가 많은 순으로 내고 같으면 읽은 순서다', () => {
    const c = new Case()
    c.session(SID, [skillCall('aaa', '2026-10-05T00:00:00Z', 'a1'), skillCall('bbb', '2026-10-05T00:01:00Z', 'b1'), skillCall('bbb', '2026-10-05T00:02:00Z', 'b2'), skillCall('ccc', '2026-10-05T00:03:00Z', 'c1')])
    assert.deepEqual(Object.keys(c.rows(c.extract())), ['bbb', 'aaa', 'ccc'])
  })

  test('같은 tool_use id 는 한 번만 센다', () => {
    const c = new Case()
    const call = skillCall('plan', '2026-10-05T00:00:00Z', 'same')
    c.session(SID, [call, call, skillCall('plan', '2026-10-05T00:00:01Z', 'other')])
    assert.equal(c.rows(c.extract())['plan'][0], '2')
  })

  test('슬래시 명령과 Skill 도구 호출을 함께 세고 이름의 접두사를 뗀다', () => {
    const c = new Case()
    c.session(SID, [user('<command-name>/fos-skills:spec</command-name> 인자', '2026-10-05T00:00:00Z'), skillCall('spec', '2026-10-05T00:01:00Z', 't1')])
    const row = c.rows(c.extract())['spec']
    assert.equal(row[0], '2')
    assert.equal(row[5], '1')
  })

  test('정정과 중단과 재호출의 점수', () => {
    const c = new Case()
    c.session(SID, [
      skillCall('plan', '2026-10-05T00:00:00Z', 't1'),
      user('아니 그게 아니라', '2026-10-05T00:00:10Z'),
      user('[Request interrupted by user]', '2026-10-05T00:00:20Z'),
      toolError('2026-10-05T00:00:30Z'),
      toolError('2026-10-05T00:00:31Z'),
      skillCall('plan', '2026-10-05T00:01:00Z', 't2'),
    ])
    // 첫 호출: 정정 1, 중단 1, 오류 2, 재호출 → 3+3+2+2 = 10. 둘째 호출은 0
    assert.deepEqual(c.rows(c.extract())['plan'], ['2', '2', '1', '1', '2', '1', '10'])
  })

  test('정정 정규식이 걸리는 말과 안 걸리는 말', () => {
    const c = new Case()
    const says = ['다시 해', '왜 이래', '왜', 'STOP', 'Wrong thing', 'not WHAT I asked', '하지마', '하지 마', '안돼', '안 되네', '이상하네', '멈춰']
    const plain = ['좋아요', '왜냐하면 그렇다', '왜?', '진행해 줘', '고마워']
    const records: Rec[] = []
    let n = 0
    for (const s of [...says, ...plain]) {
      records.push(skillCall('plan', `2026-10-05T00:${String(n).padStart(2, '0')}:00Z`, `t${n}`), user(s, `2026-10-05T00:${String(n).padStart(2, '0')}:30Z`))
      n++
    }
    c.session(SID, records)
    const row = c.rows(c.extract())['plan']
    assert.equal(row[0], String(says.length + plain.length))
    assert.equal(row[2], String(says.length))
  })

  test('시스템 알림과 도구 결과와 메타 발화는 사람 발화로 세지 않는다', () => {
    const c = new Case()
    c.session(SID, [
      skillCall('plan', '2026-10-05T00:00:00Z', 't1'),
      user('<system-reminder>다시</system-reminder>', '2026-10-05T00:00:01Z'),
      user('Caveat: 다시', '2026-10-05T00:00:02Z'),
      user('   ', '2026-10-05T00:00:03Z'),
      user('다시', '2026-10-05T00:00:04Z', { isMeta: true }),
      { type: 'user', timestamp: '2026-10-05T00:00:05Z', sessionId: SID, message: { content: [{ type: 'tool_result', content: 'x' }, { type: 'text', text: '다시' }] } },
      { type: 'user', timestamp: '2026-10-05T00:00:06Z', sessionId: SID, message: { content: [{ type: 'text', text: '다시' }, { type: 'image' }] } },
    ])
    assert.equal(c.rows(c.extract())['plan'][2], '1')
  })

  test('하위 에이전트 기록은 main 에서 빼고 주 세션 id 로 묶는다', () => {
    const c = new Case()
    c.session(SID, [skillCall('plan', '2026-10-05T00:00:00Z', 't1')])
    const sub = write(join(c.projects, '-repo', SID, 'subagents', 'agent-1.jsonl'), `${JSON.stringify({ ...skillCall('plan', '2026-10-05T00:00:00Z', 't2'), sessionId: undefined })}\n`)
    assert.ok(sub)
    const done = c.extract('--samples', '5', '--out', c.out)
    assert.equal(c.rows(done)['plan'][0], '2')
    assert.equal(c.rows(done)['plan'][1], '1')
    const lines = readFileSync(join(c.out, 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => [l.session, l.subagent]).sort(), [[SID, false], [SID, true]].sort())
  })

  test('--since 는 파일의 수정 시각으로도 거른다', () => {
    const c = new Case()
    const old = c.session('oldsess', [skillCall('plan', '2026-10-05T00:00:00Z', 't1')])
    utimesSync(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    c.session('newsess', [skillCall('plan', '2026-10-05T00:00:00Z', 't2')])
    const done = c.extract('--since', '2026-10-01')
    assert.equal(done.stdout.split('\n')[0], '# 읽은 파일 1, 호출 1')
    assert.equal(c.extract().stdout.split('\n')[0], '# 읽은 파일 2, 호출 2')
  })

  test('호출이 없어도 0 이고 머리 줄만 낸다', () => {
    const c = new Case()
    c.session(SID, [user('안녕', '2026-10-05T00:00:00Z')])
    const done = c.extract()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '# 읽은 파일 1, 호출 0\nskill\tcalls\tmain\twith_correction\twith_interrupt\ttool_errors\treinvoked\tfriction\n')
  })

  test('jsonl 이 아닌 파일과 깨진 줄과 JSON 이 객체가 아닌 줄은 건너뛴다', () => {
    const c = new Case()
    write(join(c.projects, '-repo', 'notes.txt'), '"type": "user"\n')
    c.session(SID, [skillCall('plan', '2026-10-05T00:00:00Z', 't1')], '-repo', '[1, "type": "user"]\n"type": "assistant"\n{"type": "user", "message": null}\n')
    const done = c.extract()
    assert.equal(done.stdout.split('\n')[0], '# 읽은 파일 1, 호출 1')
  })
})

describe('extract_skill_usage 표본과 파일', () => {
  test('표준 출력에는 발췌가 없고 표본은 세션 id 앞 8자를 쓴다', () => {
    const c = new Case()
    c.session(SID, [skillCall('plan', '2026-10-05T00:00:00Z', 't1'), user('비밀 문장 다시', '2026-10-05T00:01:00Z')])
    const done = c.extract('--samples', '1')
    assert.ok(!done.stdout.includes('비밀 문장'))
    assert.ok(done.stdout.endsWith('\n# 마찰 점수 상위 호출. 점수는 표본을 고르는 데만 쓴다\nsession\ttimestamp\tskill\tfriction\nabcdef12\t2026-10-05T00:00:00\tplan\t3\n'), done.stdout)
    assert.ok(!done.stdout.includes('abcdef1234'))
  })

  test('표본은 점수가 높은 순이고 같으면 기록 순서다', () => {
    const c = new Case()
    c.session(SID, [
      skillCall('p', '2026-10-05T00:00:00Z', 't1'), user('좋아', '2026-10-05T00:00:30Z'),
      skillCall('q', '2026-10-05T00:01:00Z', 't2'), toolError('2026-10-05T00:01:30Z'),
      skillCall('r', '2026-10-05T00:02:00Z', 't3'), user('다시', '2026-10-05T00:02:30Z'),
    ])
    const tail = c.extract('--samples', '2').stdout.split('\n').slice(-3)
    assert.deepEqual(tail, ['abcdef12\t2026-10-05T00:02:00\tr\t3', 'abcdef12\t2026-10-05T00:01:00\tq\t1', ''])
  })

  test('--out 은 가린 발췌를 쓰고 형식은 json.dumps 와 같다', () => {
    const c = new Case()
    c.session(SID, [
      user('첫 요청 입니다', '2026-10-05T00:00:00Z', { cwd: '/w' }),
      skillCall('plan', '2026-10-05T00:01:00Z', 't1', { cwd: '/w' }),
      user('token=ghp_abcdefghijklmnopqrstuvwxyz0123 다시', '2026-10-05T00:02:00Z'),
    ])
    const file = join(c.projects, '-repo', `${SID}.jsonl`)
    const done = c.extract('--out', c.out)
    assert.equal(done.code, 0, done.stderr)
    assert.equal(
      readFileSync(join(c.out, 'invocations.jsonl'), 'utf8'),
      `{"skill": "plan", "ts": "2026-10-05T00:01:00Z", "model": "test-model", "via": "tool", "session": "${SID}", "file": ${JSON.stringify(file)}, "cwd": "/w", "subagent": false, "humans": ["[가림] 다시"], "n_humans": 1, "corrections": 1, "interrupts": 0, "tool_errors": 0, "reinvoked": false, "assistant_turns": 1, "friction": 3}\n`,
    )
    assert.equal(
      readFileSync(join(c.out, 'sessions.jsonl'), 'utf8'),
      `{"session": "${SID}", "file": ${JSON.stringify(file)}, "cwd": "/w", "model": "test-model", "first_user": "첫 요청 입니다", "skills": ["plan"]}\n`,
    )
  })

  test('발췌 길이 제한: 발화 400자, 열다섯 건, 첫 요청 300자', () => {
    const c = new Case()
    const records: Rec[] = [user('가'.repeat(500), '2026-10-05T00:00:00Z'), skillCall('plan', '2026-10-05T00:01:00Z', 't1')]
    for (let i = 0; i < 17; i++) records.push(user(`${'나'.repeat(450)}${i}`, `2026-10-05T00:02:${String(i).padStart(2, '0')}Z`))
    c.session(SID, records)
    c.extract('--out', c.out)
    const inv = JSON.parse(readFileSync(join(c.out, 'invocations.jsonl'), 'utf8'))
    assert.equal(inv.humans.length, 15)
    assert.equal(inv.n_humans, 17)
    assert.equal([...inv.humans[0]].length, 400)
    const ses = JSON.parse(readFileSync(join(c.out, 'sessions.jsonl'), 'utf8'))
    assert.equal([...ses.first_user].length, 300)
  })

  test('가리기 대상: 토큰 형식과 키=값', () => {
    const c = new Case()
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz', 'github_pat_abcdefghijklmnopqrst', 'sk-abcdefghijklmnopqrstuv', 'xoxb-1234567890ab', 'AKIAABCDEFGHIJKLMNOP',
      'eyJabcdefghij.abcdefghij.abcdefghij', 'Bearer abcdefghijklmnop1234', 'BEARER abcdefghijklmnop1234', 'password: hunter2', 'API_KEY=zzz', 'api-key = zzz', 'Token:abc', 'passwd=1', 'SECRET=1',
    ]
    const keep = ['ghp_short', 'sk-short', 'passwordless', 'bearer short', 'pass word=1']
    const records: Rec[] = []
    ;[...secrets, ...keep].forEach((s, i) => {
      const mm = String(i).padStart(2, '0')
      records.push(skillCall('plan', `2026-10-05T00:${mm}:00Z`, `t${i}`), user(`앞 ${s} 뒤`, `2026-10-05T00:${mm}:30Z`))
    })
    c.session(SID, records)
    c.extract('--out', c.out)
    const humans: string[] = readFileSync(join(c.out, 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).humans[0])
    assert.deepEqual(humans.slice(0, secrets.length), secrets.map(() => '앞 [가림] 뒤'))
    assert.deepEqual(humans.slice(secrets.length), keep.map((s) => `앞 ${s} 뒤`))
  })

  test('--out 이 git 작업 트리 안이면 거부하고 2', () => {
    const c = new Case()
    c.session(SID, [skillCall('plan', '2026-10-05T00:00:00Z', 't1')])
    const repo = new Repo('hc-usage-repo-', true)
    const refused = c.extract('--out', join(repo.root, 'usage'))
    assert.equal(refused.code, 2)
    assert.equal(refused.stderr, `--out 이 git 작업 트리 안이다. 발췌가 커밋될 수 있어 거부한다: ${join(repo.root, 'usage')}\n`)
    assert.equal(refused.stdout, '')
  })

  test('--out 폴더가 아직 없어도 만든다', () => {
    const c = new Case()
    c.session(SID, [skillCall('plan', '2026-10-05T00:00:00Z', 't1')])
    const nested = join(c.out, 'a', 'b')
    assert.equal(c.extract('--out', nested).code, 0)
    assert.equal(readFileSync(join(nested, 'sessions.jsonl'), 'utf8'), '')
  })
})

describe('extract_skill_usage 인자', () => {
  test('대화 기록 폴더가 없으면 2', () => {
    const c = new Case()
    const done = docWord(run('extract_skill_usage', ['--projects', join(c.base, '없음')], { cwd: c.base }))
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `대화 기록 폴더가 없다: ${join(c.base, '없음')}\n`)
  })

  test('날짜 형식과 옵션이 틀리면 인자 오류 2', () => {
    const c = new Case()
    c.session(SID, [])
    const bad = c.extract('--since', '2026/10/01')
    assert.equal(bad.code, 2)
    assert.equal(bad.stderr, "인자 오류: time data '2026/10/01' does not match format '%Y-%m-%d'. 사용법은 이 파일의 docstring 에 있다\n")
    assert.match(c.extract('--since', '2026-10-01x').stderr, /^인자 오류: unconverted data remains.*: "?x"?\. 사용법은 이 파일의 docstring 에 있다\n$/)
    assert.match(c.extract('--since', '2026-02-30').stderr, /^인자 오류: .*day.*range.*\. 사용법은 이 파일의 docstring 에 있다\n$/)
    assert.equal(c.extract('--since', '2026-13-01').stderr, "인자 오류: time data '2026-13-01' does not match format '%Y-%m-%d'. 사용법은 이 파일의 docstring 에 있다\n")
    assert.equal(c.extract('--since', '').code, 0)
    for (const args of [['--nope'], ['--samples', 'x'], ['--skill'], ['extra']]) {
      const done = c.extract(...args)
      assert.equal(done.code, 2, args.join(' '))
      assert.ok(done.stderr.endsWith('인자 오류: 2. 사용법은 이 파일의 docstring 에 있다\n'), done.stderr)
    }
  })

  test('날짜는 한 자리 월 일도 받고 옵션은 고유 접두로 줄여 쓴다', () => {
    const c = new Case()
    c.session(SID, [skillCall('plan', '2026-10-05T00:00:00Z', 't1')])
    assert.equal(c.extract('--since', '2026-1-5').code, 0)
    assert.equal(c.extract('--sk', 'plan', '--sa=1').code, 0)
    assert.equal(c.extract('--s', 'plan').code, 2)
    assert.equal(c.extract('--samples=').code, 2)
  })

  test('-h 는 도움말이 아니라 인자 오류다', () => {
    const c = new Case()
    c.session(SID, [])
    assert.equal(c.extract('-h').code, 2)
  })
})

describe('render_session', () => {
  function render(c: Case, ...args: string[]): Result {
    return docWord(run('render_session', args, { cwd: c.base }))
  }

  test('id 앞부분으로 주 세션을 찾아 --out 파일에만 쓴다', () => {
    const c = new Case()
    c.session(SID, [user('첫 요청 password=hunter2', '2026-10-05T00:00:00Z'), skillCall('plan', '2026-10-05T00:01:00Z', 't1'), toolError('2026-10-05T00:02:00Z')])
    const target = join(c.out, 's.txt')
    const done = render(c, 'abcdef12', '--out', target, '--projects', c.projects, '--from', '2026-10-05T00:01')
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, `${target}: 2줄\n`)
    assert.equal(readFileSync(target, 'utf8'), '[10-05T00:01:00] TOOL: Skill {"skill": "plan"}\n[10-05T00:02:00] TOOL_ERROR: 실패\n')
  })

  test('비밀값을 가린다', () => {
    const c = new Case()
    c.session(SID, [user('password=hunter2 그대로', '2026-10-05T00:00:00Z')])
    const target = join(c.out, 's.txt')
    render(c, 'abcdef12', '--out', target, '--projects', c.projects)
    assert.equal(readFileSync(target, 'utf8'), '[10-05T00:00:00] USER: [가림] 그대로\n')
  })

  test('역할 이름과 길이 제한과 건너뛰는 발화', () => {
    const c = new Case()
    const records: Rec[] = [
      user('<system-reminder>무시</system-reminder>', '2026-10-05T00:00:00Z'),
      user('가'.repeat(2000), '2026-10-05T00:00:01Z'),
      { type: 'assistant', timestamp: '2026-10-05T00:00:02Z', message: { content: [{ type: 'text', text: '나'.repeat(1500) }, { type: 'text', text: '   ' }, { type: 'tool_use', name: 'Bash', input: { command: '다'.repeat(500) } }, { type: 'thinking', text: 'x' }, 'str'] } },
      toolError('2026-10-05T00:00:03Z', [{ type: 'text', text: '목록' }, { type: 'text', text: '오류' }, 'x']),
      toolError('2026-10-05T00:00:04Z', '라'.repeat(600)),
      { type: 'user', timestamp: '2026-10-05T00:00:05Z', message: { content: [{ type: 'tool_result', is_error: false, content: '정상' }] } },
      { type: 'user', timestamp: '2026-10-05T00:00:06Z', message: { content: [{ type: 'text', text: '목록 발화' }] } },
      { type: 'user', message: { content: '시각 없음' } },
    ]
    c.session(SID, records)
    const target = join(c.out, 's.txt')
    assert.equal(render(c, SID, '--out', target, '--projects', c.projects).code, 0)
    const lines = readFileSync(target, 'utf8').split('\n')
    assert.equal(lines[0], `[10-05T00:00:01] USER: ${'가'.repeat(1500)}`)
    assert.equal(lines[1], `[10-05T00:00:02] ASSISTANT: ${'나'.repeat(1200)}`)
    assert.equal(lines[2], `[10-05T00:00:02] TOOL: Bash ${`{"command": "${'다'.repeat(500)}"}`.slice(0, 400)}`)
    assert.equal(lines[3], '[10-05T00:00:03] TOOL_ERROR: 목록 오류')
    assert.equal(lines[4], `[10-05T00:00:04] TOOL_ERROR: ${'라'.repeat(500)}`)
    assert.equal(lines[5], '[10-05T00:00:06] USER: 목록 발화')
    assert.equal(lines[6], '[] USER: 시각 없음')
    assert.equal(lines.length, 8)
  })

  test('--max-chars 를 넘으면 잘림 줄로 끝낸다', () => {
    const c = new Case()
    c.session(SID, [user('가'.repeat(100), '2026-10-05T00:00:00Z'), user('나'.repeat(100), '2026-10-05T00:00:01Z'), user('다', '2026-10-05T00:00:02Z')])
    const target = join(c.out, 's.txt')
    const done = render(c, SID, '--out', target, '--projects', c.projects, '--max-chars', '150')
    assert.equal(done.stdout, `${target}: 3줄\n`)
    const lines = readFileSync(target, 'utf8').split('\n')
    assert.equal(lines[2], '... (잘림)')
    const negative = render(c, SID, '--out', target, '--projects', c.projects, '--max-chars', '-5')
    assert.equal(negative.stdout, `${target}: 2줄\n`)
    const exact = render(c, SID, '--out', target, '--projects', c.projects, '--max-chars=100000')
    assert.equal(exact.stdout, `${target}: 3줄\n`)
  })

  test('파일 경로를 직접 줄 수 있고 기록이 비어도 빈 줄 하나를 쓴다', () => {
    const c = new Case()
    const file = c.session('x', [])
    const target = join(c.out, 'deep', 's.txt')
    const done = render(c, file, '--out', target)
    assert.equal(done.stdout, `${target}: 0줄\n`)
    assert.equal(readFileSync(target, 'utf8'), '\n')
  })

  test('모르는 세션과 둘 이상에 맞는 id 앞부분은 2', () => {
    const c = new Case()
    mkdirSync(c.projects, { recursive: true })
    const none = render(c, 'zzzz', '--out', join(c.out, 's.txt'), '--projects', c.projects)
    assert.equal(none.code, 2)
    assert.equal(none.stderr, "세션 'zzzz' 에 맞는 파일이 0개다. 파일 경로나 더 긴 id 를 준다\n")
    c.session('abcd0001', [])
    c.session('abcd0002', [], '-other')
    const two = render(c, 'abcd', '--out', join(c.out, 's.txt'), '--projects', c.projects)
    assert.equal(two.code, 2)
    assert.equal(two.stderr, "세션 'abcd' 에 맞는 파일이 2개다. 파일 경로나 더 긴 id 를 준다\n")
    assert.equal(render(c, 'abcd0001', '--out', join(c.out, 's.txt'), '--projects', c.projects).code, 0)
    assert.equal(render(c, "it's", '--out', join(c.out, 's.txt'), '--projects', c.projects).stderr, '세션 "it\'s" 에 맞는 파일이 0개다. 파일 경로나 더 긴 id 를 준다\n')
    const missingProjects = render(c, 'abcd', '--out', join(c.out, 's.txt'), '--projects', join(c.base, 'none'))
    assert.equal(missingProjects.stderr, "세션 'abcd' 에 맞는 파일이 0개다. 파일 경로나 더 긴 id 를 준다\n")
  })

  test('하위 에이전트 파일은 id 로 찾지 않는다', () => {
    const c = new Case()
    write(join(c.projects, '-repo', 'abcd9999', 'subagents', 'abcd-sub.jsonl'), '')
    const done = render(c, 'abcd', '--out', join(c.out, 's.txt'), '--projects', c.projects)
    assert.equal(done.code, 2)
  })

  test('--out 이 git 작업 트리 안이면 거부하고 2', () => {
    const c = new Case()
    c.session(SID, [])
    const repo = new Repo('hc-usage-repo-', true)
    const done = render(c, SID, '--out', join(repo.root, 'x', 's.txt'), '--projects', c.projects)
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `--out 이 git 작업 트리 안이다. 발췌가 커밋될 수 있어 거부한다: ${join(repo.root, 'x', 's.txt')}\n`)
  })

  test('인자 오류는 2 와 한 줄 안내', () => {
    const c = new Case()
    for (const args of [[], [SID], ['--out', 'x'], [SID, '--out', 'x', '--max-chars', 'a'], [SID, '--out', 'x', '--bogus'], ['-h']]) {
      const done = render(c, ...args)
      assert.equal(done.code, 2, args.join(' '))
      assert.ok(done.stderr.endsWith('인자 오류. 사용법은 이 파일의 docstring 에 있다\n'), done.stderr)
    }
  })

  test('옵션은 접두로 줄여 쓸 수 있다', () => {
    const c = new Case()
    c.session(SID, [user('x', '2026-10-05T00:00:00Z')])
    const target = join(c.out, 'p.txt')
    assert.equal(render(c, SID, '--ou', target, '--pro', c.projects, '--fr=2026', '--max=100').code, 0)
    assert.equal(readFileSync(target, 'utf8'), '[10-05T00:00:00] USER: x\n')
  })
})

describe('model_fit_signals', () => {
  function skills(c: Case): string {
    const skill = join(c.base, 'skills', 'demo')
    write(join(skill, 'SKILL.md'), '---\nname: demo\ndescription: 데모\nmetadata:\n---\n**강조** 하위 에이전트\n')
    write(join(skill, 'README.md'), '**강조** **강조**\n')
    return join(c.base, 'skills')
  }
  const sig = (c: Case, ...roots: string[]) => run('model_fit_signals', roots, { cwd: c.base })

  test('스킬 문서만 세고 README 는 세지 않는다', () => {
    const c = new Case()
    const done = sig(c, skills(c))
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, 'skill\t줄\tdesc자\t굵은강조\t실측사례\t검증지시\t위임지시\t금지문\t날짜\t강조/1000줄\t사례/1000줄\ndemo\t6\t2\t1\t0\t0\t1\t0\t0\t166\t0\n')
  })

  test('인자가 없거나 폴더가 없으면 2', () => {
    const c = new Case()
    const none = sig(c)
    assert.equal(none.code, 2)
    assert.equal(none.stderr, '인자 오류: 스킬 폴더를 하나 이상 준다. 없는 폴더: []\n')
    const missing = sig(c, join(c.base, 'no'))
    assert.equal(missing.code, 2)
    assert.equal(missing.stderr, `인자 오류: 스킬 폴더를 하나 이상 준다. 없는 폴더: [PosixPath('${join(c.base, 'no')}')]\n`)
  })

  test('신호별 출현 수와 천 줄당 비율', () => {
    const c = new Case()
    const skill = join(c.base, 'skills', 's')
    const body = [
      '---', 'name: s', 'description: |', '  여러 줄 설명이다', '  둘째 줄', 'metadata:', '  version: "1"', '---',
      '**a** **b** 와 **c**', '실측으로 확인, 실측 사례, 실측했다, 실측한 값, 실측만', '검증 확인 재검증 다시 돌 verifier code-reviewer critic 리뷰어', '하위 에이전트 subagent 에이전트에게 맡 위임 Agent 도구 spawn 스폰',
      '않는다 하지 않 말 것 금지 NEVER MUST', '2026-10-05 20261005 2026-1-5',
    ].join('\n')
    write(join(skill, 'SKILL.md'), `${body}\n`)
    write(join(skill, 'references', 'x.md'), '**z**\n')
    write(join(skill, 'tests', 'y.md'), '**t**\n')
    write(join(skill, 'node_modules', 'm', 'y.md'), '**t**\n')
    write(join(skill, 'CHANGELOG.md'), '**c**\n')
    const done = sig(c, join(c.base, 'skills'))
    const row = done.stdout.split('\n')[1].split('\t')
    assert.equal(row.join('\t'), 's\t15\t16\t4\t4\t9\t7\t6\t1\t266\t266')
  })

  test('스킬 폴더가 여럿이면 이름순으로 나열하고 SKILL.md 없는 폴더는 건너뛴다', () => {
    const c = new Case()
    const root = join(c.base, 'skills')
    for (const n of ['zeta', 'alpha', 'Beta']) write(join(root, n, 'SKILL.md'), '본문\n')
    mkdirSync(join(root, 'empty'), { recursive: true })
    write(join(root, 'file.txt'), '')
    const other = join(c.base, 'more')
    write(join(other, 'omega', 'SKILL.md'), '본문\n')
    const names = sig(c, root, other).stdout.split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0])
    assert.deepEqual(names, ['Beta', 'alpha', 'zeta', 'omega'])
  })

  test('빈 스킬은 줄 수를 1 로 나눠 0 이고 설명이 없으면 0자', () => {
    const c = new Case()
    write(join(c.base, 's', 'x', 'SKILL.md'), '')
    const row = sig(c, join(c.base, 's')).stdout.split('\n')[1]
    assert.equal(row, 'x\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0')
  })

  test('줄 수는 줄바꿈을 \\n 으로 바꾼 뒤 \\n 만 센다', () => {
    const c = new Case()
    write(join(c.base, 's', 'x', 'SKILL.md'), 'a\x85b c\rd\r\ne')
    const row = sig(c, join(c.base, 's')).stdout.split('\n')[1].split('\t')
    assert.equal(row[1], '3')
  })

  test('설명 길이는 여러 줄 블록과 한 줄 값 모두 앞뒤 공백을 뗀 글자 수다', () => {
    const c = new Case()
    write(join(c.base, 's', 'one', 'SKILL.md'), '---\nname: one\ndescription: 한 줄 설명이다\nmetadata:\n  v: 1\n---\n')
    write(join(c.base, 's', 'two', 'SKILL.md'), '---\nname: two\ndescription: |\n  첫째\n  둘째\nmetadata:\n---\n')
    write(join(c.base, 's', 'three', 'SKILL.md'), '---\nname: three\ndescription: 끝에 다른 키\nlicense: MIT\n---\n')
    write(join(c.base, 's', 'four', 'SKILL.md'), '---\nname: four\ndescription: 닫는 줄 없음\n')
    const rows = Object.fromEntries(sig(c, join(c.base, 's')).stdout.split('\n').slice(1).filter(Boolean).map((l) => [l.split('\t')[0], l.split('\t')[2]]))
    assert.deepEqual(rows, { four: '0', one: '8', three: '7', two: '7' })
  })

  test('날짜 표기는 앞 두 글자가 ASCII 20 이어야 한다', () => {
    const c = new Case()
    write(join(c.base, 's', 'x', 'SKILL.md'), '2026-10-05 ２０２６-10-05 1999-01-01 2099-12-31\n')
    const row = sig(c, join(c.base, 's')).stdout.split('\n')[1].split('\t')
    assert.equal(row[8], '2')
  })
})

