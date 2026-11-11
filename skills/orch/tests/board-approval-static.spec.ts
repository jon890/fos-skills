import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const root = fileURLToPath(new URL('../../../', import.meta.url))
function sources(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? e.name === 'tests' ? [] : sources(join(dir, e.name)) : /\.(ts|js)$/.test(e.name) ? [join(dir, e.name)] : [])
}
const code = (line: string) => !line.trimStart().startsWith('//')
// 상태 값 approved 는 어디서든, revise 는 같은 줄에 state 가 있을 때만 상태로 센다. 창과 스크립트는 동작 이름 approve, revise 를 쓴다.
function stateLiterals(source: string): number[] {
  return source.split('\n').flatMap((line, i) => code(line) && (/['"]approved['"]/.test(line) || (/['"]revise['"]/.test(line) && /state/.test(line))) ? [i + 1] : [])
}
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const lines = (path: string) => read(path).split('\n').filter(code).join('\n')
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length
test('승인 상태 문자열은 core 밖에서 만들지 않는다', () => {
  const problems: string[] = []
  for (const dir of ['skills/orch/scripts', 'skills/orch/hooks', 'extensions/work-board/bin', 'extensions/work-board/hooks']) {
    for (const file of sources(join(root, dir))) {
      if (file.endsWith('/core/approvals.ts')) continue
      for (const line of stateLiterals(readFileSync(file, 'utf8'))) problems.push(`${file}:${line}`)
    }
  }
  assert.deepEqual(problems, [])
})
test('조건식·대괄호·변수 초기화로 만든 승인 상태도 잡는다', () => {
  for (const source of ["state: action === 'approve' ? 'approved' : 'revise'", "entry['state'] = 'approved'", "const next = 'approved'; const entry = { state: next }", "entry.state = 'revise'"]) assert.deepEqual(stateLiterals(source), [1])
  assert.deepEqual(stateLiterals("// state: 'approved'\nconst state = fromCore()"), [])
})
test('동작 이름 revise 는 상태로 세지 않는다', () => {
  for (const source of ["await pressApproval($, entry, 'revise', value)", "action === 'revise' ? subject : other", "const action = 'approve'"]) assert.deepEqual(stateLiterals(source), [])
})
test('승인 기록을 쓰는 길은 한 줄기다: applyPress → recordPress → bin/approvals.ts press → register.js 의 pressApproval', () => {
  const callers = (name: string) => ['skills/orch/scripts', 'skills/orch/hooks', 'extensions/work-board/bin', 'extensions/work-board/hooks']
    .flatMap(dir => sources(join(root, dir))).filter(file => !file.endsWith('/core/approvals.ts') && new RegExp(`\\b${name}\\(`).test(lines(file.slice(root.length))))
    .map(file => file.slice(root.length))
  assert.deepEqual(callers('applyPress'), ['skills/orch/scripts/lib/approvals.ts'])
  assert.deepEqual(callers('recordPress').filter(file => !file.endsWith('lib/approvals.ts')), ['extensions/work-board/bin/approvals.ts'])
  const register = lines('extensions/work-board/hooks/register.js')
  assert.equal(count(register, /'press',\s*entry\.id/g), 1, "register.js 에서 press 동작을 부르는 인자를 만드는 곳은 approvalArgv 하나다")
  assert.equal(count(register, /\bapprovalArgv\(/g), 2, 'approvalArgv 는 정의 하나와 호출 하나(pressApproval)다')
  const body = register.slice(register.indexOf('async function pressApproval'))
  assert.ok(body.slice(0, body.indexOf('\n}\n')).includes('approvalArgv('), '호출은 pressApproval 안에 있다')
  // 사람이 누른 이벤트 처리(onPress, onSubmit 의 처리 함수)만 pressApproval 을 부른다
  const callLines = register.split('\n').filter(line => /\bpressApproval\(/.test(line) && !/async function pressApproval/.test(line))
  assert.ok(callLines.length >= 1 && callLines.every(line => /pressApproval\(\$, entry, 'approve'|onSubmit:/.test(line)), `pressApproval 호출: ${callLines.join(' | ')}`)
  const approve = register.slice(register.indexOf('async function approveApproval'))
  assert.ok(approve.slice(0, approve.indexOf('\n}\n')).includes('pressApproval('), 'approve 호출은 approveApproval 안에 있다')
  assert.equal(count(register, /\bapproveApproval\(/g), 2, 'approveApproval 은 정의 하나와 버튼 onPress 하나에서만 쓴다')
  assert.ok(/onPress: \(event\) => \{ void approveApproval\(/.test(register), 'approveApproval 은 버튼 onPress 안에서 부른다')
  assert.ok(!register.includes('$.fs.write'), '창은 승인 파일을 직접 쓰지 않는다')
})
test('orch 명령 표에 승인·고쳐 달라를 기록하는 동작이 없다', () => {
  const table = lines('skills/orch/scripts/lib/commands.ts')
  assert.ok(!/verb: 'approval (?:press|approve|revise)/.test(table))
  assert.ok(!/board-approval\.ts', prepend: \['(?:press|approve|revise)'\]/.test(table))
})
