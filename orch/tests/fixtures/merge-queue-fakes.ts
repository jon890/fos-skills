// 실제 시간 대신 틱마다 상태를 바꾸는 가짜 gh 는 응답 캐시를 쓰지 않는다.
process.env.ORCH_GH_CACHE = '0'

// merge-queue.spec.ts 와 merge-queue-overlap.spec.ts 가 함께 쓰는 가짜 gh, git 과 실행 helper 다. GitHub 에는 닿지 않는다.
//
// 가짜 gh 는 FAKE_STATE 의 JSON 상태로 움직이고 받은 인자를 FAKE_LOG 에 한 줄씩 적는다.
// 머지 큐가 넘기는 --jq 식을 그대로 확인하려고 진짜 jq 로 평가한다. 그래서 jq 가 없으면 두 테스트를 건너뛴다.
// 상태 키: <번호> 마다 PR 필드(state, statusCheckRollup, mergeable, url, headRefName, baseRefName, headRefOid,
//   isCrossRepository, mergeStateStatus)와 흉내 칸(appear, update_fails(true 나 stderr 문구), after_update, after_update_head),
//   그리고 _behind, _behind_after_update, _api_fails, _rules, _rules_error, _view_fails, _remote_head, _base_head, _ls_remote_fails.
//   쌓인 PR 칸: _based(`pr list --base` 가 내는 열린 PR 목록. `pr edit <n> --base` 가 그 PR 을 뺀다), _list_fails,
//   _edit_fails, _user(`api user` 의 login. 기본 me).
// 가짜 git 은 rev-parse --verify 와 ls-remote 만 상태로 답하고 나머지는 0 으로 끝난다. 그 밖의 rev-parse 는 저장소 밖처럼
// 128 로 끝난다. 이벤트 실행기가 주 checkout 을 찾을 때 --repo 를 그대로 쓰게 하기 위해서다. merge-queue.spec.ts 만 쓰고,
// merge-queue-overlap.spec.ts 는 진짜 git 과 임시 저장소를 쓴다.
// 확장자 없는 실행 파일은 타입 제거 대상이 아니라 타입 문법을 쓰지 않는다. 출력은 파이프가 비동기인 macOS 에서도
// 끝나기 전에 다 나가도록 fs.writeSync 로 쓴다.

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FAKE_GH = `const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const say = (text) => fs.writeSync(1, text + '\\n')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, args.join(' ') + '\\n')
const jq = (filter, data) => {
  const done = spawnSync('jq', ['-r', filter], { input: JSON.stringify(data), encoding: 'utf8' })
  if (done.stdout) fs.writeSync(1, done.stdout)
  if (done.stderr) fs.writeSync(2, done.stderr)
  process.exit(done.status ?? 1)
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const pr = state[args[2]]
  const at = args.indexOf('--match-head-commit')
  if (at >= 0 && args[at + 1] === pr.headRefOid) {
    pr.state = 'MERGED'
    if (pr.merge_delay) pr.merge_pending = pr.merge_delay
    save()
    say('merged')
    process.exit(0)
  }
  say('head mismatch')
  process.exit(1)
}
if (args[0] === 'pr' && args[1] === 'list') {
  if (state._list_fails) process.exit(1)
  say(JSON.stringify(state._based ?? []))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'edit') {
  if (state._edit_fails) process.exit(1)
  state._based = (state._based ?? []).filter((pr) => String(pr.number) !== args[2])
  save()
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'user') {
  const at = args.indexOf('--jq')
  jq(at >= 0 ? args[at + 1] : '.', { login: state._user ?? 'me' })
}
if (args[0] === 'api') {
  const path = args.slice(1).find((a) => a.startsWith('repos/'))
  if (path.includes('update-branch')) {
    const parts = path.split('/')
    const pr = state[parts[parts.length - 2]]
    if (pr.update_fails) {
      // 문자열이면 gh 가 stderr 에 내는 이유다(충돌 같은 것)
      if (typeof pr.update_fails === 'string') fs.writeSync(2, pr.update_fails + '\\n')
      process.exit(1)
    }
    if (pr.after_update_delay) pr.pending_head = { old: pr.headRefOid, left: pr.after_update_delay }
    pr.headRefOid = pr.after_update_head ?? 'new'
    pr.statusCheckRollup = []
    pr.appear = { left: 2, checks: pr.after_update ?? [] }
    state._behind = state._behind_after_update ?? 0
    state._remote_head = 'new'
    save()
    process.exit(0)
  }
  if (state._api_fails) process.exit(1)
  const rules = path.includes('/rules/branches/')
  if (rules && state._rules_error) {
    fs.writeSync(2, state._rules_error)
    process.exit(1)
  }
  const at = args.indexOf('--jq')
  jq(at >= 0 ? args[at + 1] : '.', rules ? state._rules ?? [] : { behind_by: state._behind ?? 0 })
}
if (args[0] === 'pr' && args[1] === 'view') {
  // 앞의 몇 번은 일시 실패를 흉내 낸다
  if (state._view_fails) {
    state._view_fails -= 1
    save()
    process.exit(1)
  }
  const pr = state[args[2]]
  // 쓰기 성공 뒤 조회 API 에 상태가 늦게 반영되는 경우다.
  if (args[args.indexOf('--json') + 1] === 'state' && pr.merge_pending) {
    pr.merge_pending -= 1
    save()
    jq(args[args.indexOf('--jq') + 1], { ...pr, state: 'OPEN' })
  }
  if (args[args.indexOf('--json') + 1] === 'headRefOid' && pr.pending_head?.left) {
    pr.pending_head.left -= 1
    save()
    jq(args[args.indexOf('--jq') + 1], { ...pr, headRefOid: pr.pending_head.old })
  }
  // 체크가 나중에 나타나는 PR 을 흉내 낸다. 조회할 때마다 left 가 줄고 0 이 되면 체크가 붙는다
  if (pr.appear) {
    pr.appear.left -= 1
    if (pr.appear.left <= 0) {
      pr.statusCheckRollup.push(...pr.appear.checks)
      delete pr.appear
    }
    save()
  }
  jq(args[args.indexOf('--jq') + 1], pr)
}
process.exit(3)
`

export const FAKE_GIT = `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, 'git ' + args.join(' ') + '\\n')
if (args[0] === 'rev-parse' && !args.includes('--verify')) process.exit(128)
if (args[0] === 'rev-parse' || args[0] === 'ls-remote') {
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
  if (args[0] === 'ls-remote' && state._ls_remote_fails) process.exit(2)
  const head = state._remote_head ?? process.env.FAKE_REMOTE_HEAD ?? ''
  const base = state._base_head ?? head
  const baseRef = args[0] === 'ls-remote' || args.some((a) => a.endsWith('origin/main'))
  fs.writeSync(1, (args[0] === 'ls-remote' ? base + '\\trefs/heads/main' : baseRef ? base : head) + '\\n')
}
process.exit(0)
`

export const HAS_TOOLS = ['jq', 'bash'].every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0)

// 이 테스트를 도는 node 를 shebang 에 박는다. PATH 의 node 가 버전 관리 도구의 shim 이면 호출마다 느려진다
export function writeNodeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!${process.execPath}\n${body}`)
  chmodSync(path, 0o755)
  return path
}

export type Done = { code: number | null; stdout: string; stderr: string }

// 자식을 띄워 끝날 때까지 기다린다. 비동기라 한 파일 안의 테스트를 함께 돌릴 수 있다
export function spawnDone(argv: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
  })
}
