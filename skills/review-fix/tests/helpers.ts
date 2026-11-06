// review-fix 명령 경계 테스트의 공용 helper. 가짜 gh, ssh 를 PATH 앞에 두고 임시 git 저장소에서 명령을 돌린다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다. GitHub 에는 닿지 않는다.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Rule = { match?: string[]; stdout?: string; stderr?: string; code?: number; exec?: string[] }
export type Call = { argv: string[]; ghHost: string | null; cwd: string }
export type Result = { code: number | null; stdout: string; stderr: string }
type T = { after(fn: () => void): void }

// 인자가 match 의 낱말을 모두 가진 첫 규칙의 stdout, stderr, 종료 코드를 낸다. exec 가 있으면 먼저 그 명령을 돌린다(브랜치를 바꾸는 gh pr checkout 용)
const FAKE_BODY = `const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
const rules = JSON.parse(fs.readFileSync(process.argv[1] + '.rules.json', 'utf8'))
fs.appendFileSync(process.argv[1] + '.calls.jsonl', JSON.stringify({ argv, ghHost: process.env.GH_HOST ?? null, cwd: process.cwd() }) + '\\n')
const rule = rules.find((r) => !r.match || r.match.every((m) => argv.includes(m) || argv.some((a) => a.includes(m)))) || {}
if (rule.exec) spawnSync(rule.exec[0], rule.exec.slice(1), { stdio: 'ignore' })
const write = (fd, text) => {
  let buf = Buffer.from(text)
  while (buf.length) {
    try {
      buf = buf.subarray(fs.writeSync(fd, buf))
    } catch (e) {
      if (e.code !== 'EAGAIN') throw e
    }
  }
}
if (rule.stdout) write(1, rule.stdout)
if (rule.stderr) write(2, rule.stderr)
process.exitCode = rule.code ?? 0
`

const roots: string[] = []
process.on('exit', () => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

export function tempDir(prefix: string, t?: T): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  t?.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_EDITOR: 'false',
  }
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnv()): string {
  const done = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

export function run(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Result {
  const env = { ...(opts.env ?? process.env) }
  delete env.NODE_TEST_CONTEXT
  const done = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd, env, input: opts.input, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

function fake(bin: string, name: string, rules: Rule[]) {
  const path = join(bin, name)
  writeFileSync(path, `#!${process.execPath}\n${FAKE_BODY}`)
  chmodSync(path, 0o755)
  const rulesFile = `${path}.rules.json`
  const log = `${path}.calls.jsonl`
  const setRules = (next: Rule[]) => writeFileSync(rulesFile, JSON.stringify(next))
  setRules(rules)
  const calls = (): Call[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Call)
      : []
  return { setRules, calls }
}

// 임시 저장소(repo)와 가짜 gh, ssh. origin 을 주면 그 주소의 리모트를 건다. null 이면 리모트가 없다
export function setup(t: T, opts: { origin?: string | null } = {}) {
  const root = tempDir('review-fix-', t)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const gh = fake(bin, 'gh', [])
  const ssh = fake(bin, 'ssh', [{ stdout: 'hostname github.com\n' }])
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const env: NodeJS.ProcessEnv = { ...gitEnv(), PATH: `${bin}:${process.env.PATH}` }
  delete env.GH_HOST
  git(repo, ['init', '-q', '-b', 'main'], env)
  if (opts.origin !== null) git(repo, ['remote', 'add', 'origin', opts.origin ?? 'git@github.com:o/r.git'], env)
  const exec = (command: string[], args: string[], extra: NodeJS.ProcessEnv = {}, input?: string) => run([...command, ...args], { cwd: repo, env: { ...env, ...extra }, input })
  const write = (name: string, text: string) => {
    const file = join(root, name)
    writeFileSync(file, text)
    return file
  }
  return { root, repo, env, gh, ssh, exec, write }
}

// GraphQL 응답 꾸러미
export function threadsResponse(flags: boolean[], total?: number, patch: (node: Record<string, unknown>, index: number) => void = () => {}): string {
  const nodes = flags.map((resolved, i) => {
    const node: Record<string, unknown> = {
      id: `T${i}`,
      isResolved: resolved,
      isOutdated: false,
      path: 'a.py',
      line: i,
      comments: { nodes: [{ author: { login: 'bot' }, body: 'x' }] },
    }
    patch(node, i)
    return node
  })
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: total ?? nodes.length, nodes } } } } })
}

export function writeBody(dir: string, name: string, text: string): string {
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}
