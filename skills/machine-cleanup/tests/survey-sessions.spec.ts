// survey_sessions 의 명령 경계 테스트. ps 와 lsof 는 가짜 실행 파일이고 대화 기록은 임시 홈에 둔다.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'

const DAY = 86400
const PS_ARGS = ['pid=,ppid=,etime=,tty=,rss=,pcpu=,command=']
const pad = (text: string, width: number) => text.padStart(width)
const human9 = (text: string) => pad(text, 9)

type Row = { pid: number; ppid: number; etime: string; tty: string; rss: number; cpu: string; command: string }
const psLine = (r: Row) => `  ${r.pid}     ${r.ppid} ${r.etime} ${r.tty}  ${r.rss}  ${r.cpu} ${r.command}`

function setup(rows: Row[] = [], cwds: Record<number, string> = {}, extraPs: string[] = []) {
  const box = new Sandbox()
  box.fake('ps', [{ args: PS_ARGS, stdout: `${[...rows.map(psLine), ...extraPs].join('\n')}\n` }])
  box.fake('lsof', [{ stdout: Object.entries(cwds).map(([pid, cwd]) => `p${pid}\nn${cwd}\n`).join('') }])
  const projects = join(box.home, '.claude/projects')
  const now = Math.floor(Date.now() / 1000)
  const age = (path: string, days: number) => utimesSync(path, now - days * DAY, now - days * DAY)
  // 기록 폴더 하나. cwd 가 없는 경로면 워크트리가 사라진 기록이다
  const session = (name: string, cwd: string | null, days = 20, size = 100, base = projects) => {
    const file = write(join(base, name, 'a.jsonl'), `${cwd === null ? '{"type":"user"}' : JSON.stringify({ type: 'user', cwd })}\n${'x'.repeat(size)}`)
    age(file, days)
    return join(base, name)
  }
  return { box, projects, now, age, session, run: (args: string[] = []) => box.run('survey_sessions', args) }
}

const R = (pid: number, ppid: number, etime: string, tty: string, rss: number, cpu: string, command: string): Row => ({ pid, ppid, etime, tty, rss, cpu, command })

describe('에이전트 세션', () => {
  test('시간 내림차순으로 표시하고 현재 세션과 오래됨을 표시한다', () => {
    const rows = [
      R(101, 1, '2-03:04:05', 'ttys001', 204800, '1.5', '/Users/x/.local/bin/claude --resume'),
      R(102, 101, '30:00', '??', 1024, '0.0', 'codex serve'),
      R(process.pid, 1, '05:00:00', 'ttys002', 2048, '12.34', '/usr/local/bin/claude'),
      R(300, 1, '24:00:00', 'ttys003', 512, '0.0', '/usr/bin/vim claude.md'),
    ]
    const { run } = setup(rows, { 101: '/work/a', [process.pid]: '/work/me' })
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    const out = done.stdout.split('\n')
    assert.equal(out[0], '## 에이전트 세션 3개 (오래됨 기준 24시간)')
    assert.equal(out[1], `${pad('PID', 7)} ${pad('시간', 7)} ${'TTY'.padEnd(8)} ${pad('RSS', 9)} ${pad('CPU', 5)}  표시   cwd`)
    assert.equal(out[2], `${pad('101', 7)} ${pad('51.1', 6)}h ${'ttys001'.padEnd(8)} ${human9('200.0MB')} ${pad('1.5', 5)}  ${'오래됨'.padEnd(5)}  /work/a`)
    assert.equal(out[3], `${pad(String(process.pid), 7)} ${pad('5.0', 6)}h ${'ttys002'.padEnd(8)} ${human9('2.0MB')} ${pad('12.3', 5)}  ${'현재'.padEnd(5)}  /work/me`)
    assert.equal(out[4], `${pad('102', 7)} ${pad('0.5', 6)}h ${'??'.padEnd(8)} ${human9('1.0MB')} ${pad('0.0', 5)}  ${''.padEnd(5)}  ?`)
    assert.equal(out[5], '현재 세션과 조상은 \'현재\' 로 표시했다. 종료 대상에 넣지 않는다.')
  })

  test('--min-age-hours 는 오래됨 기준을 바꾼다', () => {
    const rows = [R(101, 1, '03:00:00', 'ttys001', 1024, '0.0', 'claude')]
    const { run } = setup(rows)
    assert.ok(run().stdout.includes(`  ${''.padEnd(5)}  ?\n`))
    const done = run(['--min-age-hours', '2.5'])
    assert.ok(done.stdout.includes('(오래됨 기준 2.5시간)'))
    assert.ok(done.stdout.includes(`  ${'오래됨'.padEnd(5)}  ?\n`))
    assert.ok(run(['--min=1e1']).stdout.includes('(오래됨 기준 10시간)'))
  })

  test('조상 PID 는 모두 현재로 표시한다', () => {
    const rows = [R(process.pid, 900, '01:00:00', 'ttys001', 1, '0.0', 'claude'), R(900, 1, '01:00:00', 'ttys001', 1, '0.0', 'claude'), R(901, 1, '01:00:00', 'ttys001', 1, '0.0', 'claude')]
    const { run } = setup(rows)
    const marks = run().stdout.split('\n').filter((l) => /^ +\d+ +/.test(l) && l.includes('h ')).map((l) => (l.includes('현재') ? '현재' : '-'))
    assert.deepEqual(marks, ['현재', '현재', '-'])
  })

  test('ps 의 etime 꼴: 분:초, 시:분:초, 일-시:분:초', () => {
    const rows = [R(1001, 1, '05:30', 't', 1, '0', 'claude'), R(1002, 1, '02:00:00', 't', 1, '0', 'claude'), R(1003, 1, '3-04:30:00', 't', 1, '0', 'claude'), R(1004, 1, '1-00:00:00', 't', 1, '0', 'claude')]
    const { run } = setup(rows)
    const hours = run(['--json']).stdout
    const parsed = JSON.parse(hours).sessions as { pid: number; hours: number }[]
    assert.deepEqual(parsed.map((s) => [s.pid, s.hours]), [[1001, 0.09], [1002, 2], [1003, 76.5], [1004, 24]])
  })

  test('읽을 수 없는 ps 줄은 건너뛴다', () => {
    const { run } = setup([R(101, 1, '01:00:00', 'ttys001', 1024, '0.0', 'claude')], {}, ['bad line', '  x  1 01:00:00 t 1 0.0 claude', '  7  1 1:2:3:4 t 1 0.0 claude', '  8  1 01:00:00 t 1 abc claude'])
    assert.ok(run().stdout.startsWith('## 에이전트 세션 1개'))
  })

  test('에이전트가 없으면 lsof 를 부르지 않는다', () => {
    const { box, run } = setup([R(1, 0, '01:00', 't', 1, '0', '/bin/zsh')])
    const lsof = box.fake('lsof', [{ stdout: '' }])
    run()
    assert.deepEqual(lsof.calls(), [])
  })

  test('lsof 는 세션 PID 를 쉼표로 이어 cwd 만 묻는다', () => {
    const { box, run } = setup([R(101, 1, '01:00', 't', 1, '0', 'claude'), R(102, 1, '01:00', 't', 1, '0', 'codex')])
    run()
    const lsof = box.fake('lsof', [{ stdout: '' }])
    run()
    assert.deepEqual(lsof.calls().at(-1)!.argv, ['-a', '-p', '101,102', '-d', 'cwd', '-Fpn'])
  })
})

describe('반복 helper 와 대화 기록', () => {
  test('같은 명령줄 앞 150자가 10개 이상이면 RSS 순으로 묶는다', () => {
    const many = (n: number, command: string, rss: number, start: number) => Array.from({ length: n }, (_, i) => R(start + i, 1, '01:00', 't', rss, '0', command))
    // claude, codex 가 아닌 프로세스는 세션이 아니고 helper 묶음에만 든다
    const rows = [...many(10, 'node oxide-helper.js', 100, 2000), ...many(9, 'other-helper', 5000, 3000), ...many(12, `${'a'.repeat(150)}1`, 50, 4000), ...many(3, `${'a'.repeat(150)}2`, 50, 5000)]
    const { run } = setup(rows)
    const out = run().stdout
    assert.ok(out.includes('\n## 반복 helper 프로세스 (같은 명령줄 10개 이상)\n  10개 1000.0KB'.replace('  10개 1000.0KB', `  10개 ${human9('1000.0KB')}`) + '  node oxide-helper.js\n'), out)
    // 앞 150자가 같은 두 묶음은 하나로 합쳐 15개이고 RSS 합은 750KB 다. 명령줄은 앞 150자만 보인다
    assert.ok(out.includes(`  15개 ${human9('750.0KB')}  ${'a'.repeat(150)}\n`), out)
    assert.ok(!out.includes('other-helper'))
  })

  test('helper 가 없으면 없음이다', () => {
    const { run } = setup([])
    assert.ok(run().stdout.includes('\n## 반복 helper 프로세스 (같은 명령줄 10개 이상)\n없음\n'))
  })

  test('대화 기록 폴더의 전체 크기와 오래된 파일 크기를 센다', () => {
    const { box, age, run } = setup()
    const a = write(join(box.home, '.claude/projects/x/old.jsonl'), 'a'.repeat(3000))
    const b = write(join(box.home, '.claude/projects/x/new.jsonl'), 'b'.repeat(1000))
    age(a, 40)
    age(b, 1)
    write(join(box.home, '.codex/sessions/s.jsonl'), 'c'.repeat(2048))
    const out = run(['--log-age-days', '30']).stdout
    assert.ok(out.includes('\n## 대화 기록 (오래된 기준 30일)\n'))
    assert.ok(out.includes(`${human9('3.9KB')} 중 오래된 것 ${human9('2.9KB')}  ${join(box.home, '.claude/projects')}\n`), out)
    assert.ok(out.includes(`${human9('2.0KB')} 중 오래된 것 ${human9('2.0KB')}  ${join(box.home, '.codex/sessions')}\n`) || out.includes(`${join(box.home, '.codex/sessions')}\n`))
  })

  test('Orca 계정의 codex sessions 도 이름순으로 센다', () => {
    const { box, run } = setup()
    for (const name of ['b', 'a']) write(join(box.home, `Library/Application Support/orca/codex-accounts/${name}/home/sessions/s.jsonl`), 'x')
    const out = run().stdout
    const a = out.indexOf('codex-accounts/a/home/sessions')
    const b = out.indexOf('codex-accounts/b/home/sessions')
    assert.ok(a > 0 && b > a)
  })

  test('기록 폴더가 없으면 없음이다', () => {
    const { run } = setup()
    const out = run().stdout
    assert.ok(out.includes('\n## 대화 기록 (오래된 기준 30일)\n없음\n'))
    assert.ok(out.includes(`## 워크트리가 사라진 대화 기록 (`))
    assert.ok(out.endsWith(')\n없음\n'))
  })

  test('--log-age-days 는 정수여야 한다', () => {
    const { run } = setup()
    assert.equal(run(['--log-age-days', '1.5']).code, 2)
    assert.equal(run(['--log-age-days', ' 7 ']).code, 0)
    assert.equal(run(['--log-age-days=-1']).code, 0)
  })
})

describe('워크트리가 사라진 대화 기록', () => {
  test('cwd 경로가 없는 폴더만 세고 묶음은 누적이며 크기 상위 5개를 보인다', () => {
    const { box, projects, session, run } = setup()
    const live = join(box.root, 'live')
    mkdirSync(live)
    session('live', live)
    for (const [name, days, size] of [['g1', 1, 100], ['g5', 5, 1000], ['g10', 10, 10000], ['g40', 40, 100000], ['g20', 20, 100], ['g2', 2, 50]] as const) session(name, join(box.root, `gone-${name}`), days, size)
    const rows = run().stdout.split('\n')
    const start = rows.findIndex((l) => l.startsWith('## 워크트리가 사라진'))
    assert.equal(rows[start], `## 워크트리가 사라진 대화 기록 (${projects})`)
    const count = (line: string) => /^ *(\d+)일 넘은 것 +(\d+)개/.exec(line)!.slice(1, 3).map(Number)
    assert.deepEqual(rows.slice(start + 1, start + 5).map(count), [[3, 4], [7, 3], [14, 2], [30, 1]])
    assert.ok(rows[start + 5].startsWith('전체 6개 '), rows[start + 5])
    assert.ok(rows[start + 5].endsWith('. 크기 상위 5개:'))
    const tails = rows.slice(start + 6, start + 11).map((l) => l.split('일 전  ')[1])
    assert.deepEqual(tails, ['g40', 'g10', 'g5', 'g20', 'g1'].map((n) => join(box.root, `gone-${n}`)))
    assert.match(rows[start + 6], /^ +\d+\.\dKB +40일 전  /)
  })

  test('cwd 를 읽지 못한 폴더와 링크와 빈 폴더는 후보가 아니다', () => {
    const { box, projects, session, run } = setup()
    session('nocwd', null)
    mkdirSync(join(projects, 'empty'))
    write(join(projects, 'badjson', 'a.jsonl'), 'not json\n')
    write(join(projects, 'dirjsonl', 'a.jsonl', 'x'), '')
    const target = join(box.root, 'target')
    write(join(target, 'a.jsonl'), `${JSON.stringify({ cwd: join(box.root, 'gone') })}\n`)
    symlinkSync(target, join(projects, 'link'))
    const out = run().stdout
    assert.ok(out.endsWith(')\n없음\n'), out)
  })

  test('cwd 는 이름순으로 연 첫 jsonl 의 앞 50줄에서 처음 나온 문자열 값이다', () => {
    const { box, projects, run } = setup()
    const gone = join(box.root, 'gone')
    // 앞 50줄에 cwd 가 없으면 후보가 아니다
    write(join(projects, 'late', 'a.jsonl'), `${Array.from({ length: 50 }, () => '{"type":"x"}').join('\n')}\n${JSON.stringify({ cwd: gone })}\n`)
    // 깨진 줄과 cwd 가 아닌 값 뒤에 나오면 후보다
    write(join(projects, 'after', 'a.jsonl'), `garbage\n{"type":"x"}\n[1]\n{"cwd": 5}\n{"cwd": ""}\n${JSON.stringify({ cwd: gone })}\n`)
    // 이름순으로 a.jsonl 이 b.jsonl 보다 먼저 열린다
    write(join(projects, 'order', 'b.jsonl'), `${JSON.stringify({ cwd: join(box.root, 'b-gone') })}\n`)
    write(join(projects, 'order', 'a.jsonl'), `${JSON.stringify({ cwd: join(box.root, 'a-gone') })}\n`)
    const file = join(box.root, 'o.json')
    run(['--json-out', file])
    const data = JSON.parse(readFileSync(file, 'utf8')) as { orphans: { path: string; cwd: string }[] }
    assert.deepEqual(data.orphans.map((o) => [o.path.split('/').at(-1), o.cwd]).sort(), [['after', gone], ['order', join(box.root, 'a-gone')]])
  })

  test('폴더 안 가장 늦은 수정 시각과 전체 크기를 JSON 에 쓴다', () => {
    const { box, projects, now, age, session, run } = setup()
    const folder = session('a', join(box.root, 'gone'), 20, 100)
    const sub = write(join(folder, 'sub', 'b.txt'), 'hi')
    age(sub, 2)
    const file = join(box.root, 'o.json')
    const done = run(['--json-out', file])
    assert.equal(done.code, 0, done.stderr)
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^\{\n {2}"base": ".+\/\.claude\/projects",\n {2}"created": \d+\.\d+,\n {2}"orphans": \[\n {4}\{\n {6}"path": ".+\/projects\/a",\n {6}"cwd": ".+\/gone",\n {6}"newest_mtime": \d+\.0,\n {6}"size_bytes": \d+\n {4}\}\n {2}\]\n\}$/)
    const data = JSON.parse(text)
    assert.equal(data.base, projects)
    assert.equal(data.orphans[0].newest_mtime, now - 2 * DAY)
    assert.equal(data.orphans[0].size_bytes, 100 + JSON.stringify({ type: 'user', cwd: join(box.root, 'gone') }).length + 1 + 2)
  })

  test('후보가 없으면 orphans 는 빈 목록이고 파일 끝에 줄바꿈이 없다', () => {
    const { box, run } = setup()
    const file = join(box.root, 'o.json')
    run(['--json-out', file])
    assert.match(readFileSync(file, 'utf8'), /\n {2}"orphans": \[\]\n\}$/)
  })

  test('CLAUDE_CONFIG_DIR 가 있으면 그 아래 projects 를 본다', () => {
    const { box, session, run } = setup()
    const custom = join(box.root, 'cfg')
    session('a', join(box.root, 'gone'), 20, 10, join(custom, 'projects'))
    const out = box.run('survey_sessions', [], { env: box.env({ CLAUDE_CONFIG_DIR: custom }) }).stdout
    assert.ok(out.includes(`## 워크트리가 사라진 대화 기록 (${join(custom, 'projects')})\n`))
    assert.ok(out.includes('전체 1개 '))
    assert.ok(run().stdout.endsWith(')\n없음\n'))
  })

  test('--json-out 을 쓸 수 없으면 2 다', () => {
    const { box, run } = setup()
    const done = run(['--json-out', join(box.root, 'no/such/o.json')])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.startsWith('--json-out 을 쓸 수 없다: '))
    assert.equal(done.stdout, '')
  })
})

describe('--json', () => {
  test('sessions, helpers, logs 를 들여쓴 JSON 으로 내고 실수는 1.0 꼴이다', () => {
    const rows = [R(101, 1, '1-00:00:00', 'ttys001', 2048, '1.5', 'claude --x'), R(process.pid, 1, '00:30', '??', 10, '0', 'codex')]
    const { run } = setup(rows, { 101: '/work/a' })
    const done = run(['--json'])
    assert.equal(done.code, 0, done.stderr)
    const expected = `{
  "sessions": [
    {
      "pid": 101,
      "ppid": 1,
      "hours": 24.0,
      "tty": "ttys001",
      "rss_kb": 2048,
      "cpu": 1.5,
      "command": "claude --x",
      "cwd": "/work/a",
      "protected": false,
      "old": true
    },
    {
      "pid": ${process.pid},
      "ppid": 1,
      "hours": 0.01,
      "tty": "??",
      "rss_kb": 10,
      "cpu": 0.0,
      "command": "codex",
      "cwd": "?",
      "protected": true,
      "old": false
    }
  ],
  "helpers": [],
  "logs": []
}
`
    assert.equal(done.stdout, expected)
  })

  test('--json 이어도 --json-out 파일은 쓴다', () => {
    const { box, session, run } = setup()
    session('a', join(box.root, 'gone'))
    const file = join(box.root, 'o.json')
    const done = run(['--json', '--json-out', file])
    assert.ok(done.stdout.startsWith('{\n  "sessions"'))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).orphans.length, 1)
  })
})

describe('옵션', () => {
  test('모르는 옵션과 값 누락은 사용법 오류 2 다', () => {
    const { run } = setup()
    for (const args of [['--nope'], ['--min-age-hours'], ['--min-age-hours', 'x'], ['extra'], ['--json=1'], ['--json-out']]) assert.equal(run(args).code, 2, args.join(' '))
    const help = run(['-h'])
    assert.equal(help.code, 0)
    assert.ok(help.stdout.startsWith('usage: '))
  })
})
