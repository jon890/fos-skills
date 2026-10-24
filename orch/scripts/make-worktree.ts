// 지시서의 브랜치로 워크트리를 만들거나 완료한 워크트리를 검사한다.
//
// 사용법:
//     make-worktree.ts --repo DIR --spec FILE --name NAME [--base BRANCH] [--resume-remote]
//     make-worktree.ts --check DIR --spec FILE
//
//     지시서의 줄 머리 `브랜치:` 줄은 하나여야 한다. 판정은 lib/spec.ts 의 branchesOf 가 소유한다.
//     만들기: <저장소 최상위>/worktrees/<저장소 이름>/<NAME> 에 만들고 그 경로 한 줄을 낸다.
//       기본 동작은 기존 로컬, 원격 브랜치를 거부하고 origin/<기준 브랜치> 위에 upstream 없는 브랜치를 만든다.
//       push 전에 upstream 이 있으면 원격 브랜치가 gone 으로 보여 정리가 머지된 것으로 읽는다.
//       기준 브랜치는 --base(앞의 origin/ 는 뗀다), 없으면 origin/HEAD, 그것도 없으면 main 이다.
//       --resume-remote 는 기존 origin 브랜치의 최신 커밋에서 만들고 upstream 을 연결한다.
//       Orca 의 externalWorktreeVisibility 가 hide 면 만들지 않는다. 그 워크트리를 Orca 가 숨겨 worker-start 가 찾지 못한다.
//       만든 뒤 /worktrees/ 를 info/exclude 에 더하고, 저장소의 .claude/settings.local.json 을 복사하고,
//       worktree-deny.ts 로 deny 규칙을 더한다. deny 규칙을 더하지 못해도 워크트리는 낸다(경고 한 줄).
//     검사(--check): 워크트리의 브랜치, upstream, 원격 끝이 지시서 브랜치와 HEAD 에 맞는지 본다.
//       맞으면 `일치: <브랜치> (HEAD <sha>)`, 아니면 어긋난 것마다 `불일치: <항목> <실제>, 지시서 <기대>` 를 stdout 에 낸다.
//
// 종료 코드: 0 성공, 1 거부, 불일치, git 실패, 2 사용법 오류, 지시서 오류
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { isFile, real } from './lib/fs.ts'
import { defaultBase, git } from './lib/git.ts'
import { repoVisibility, repoVisibilityActions } from './lib/orca.ts'
import { run, scriptCommand } from './lib/proc.ts'
import { branchesOf } from './lib/spec.ts'

const USAGE = [
  '사용법: make-worktree.ts --repo DIR --spec FILE --name NAME [--base BRANCH] [--resume-remote]',
  '        make-worktree.ts --check DIR --spec FILE',
].join('\n')
const DENY_SCRIPT = fileURLToPath(new URL('./worktree-deny.ts', import.meta.url))
// fetch 와 worktree add 는 큰 저장소에서 기본 60초를 넘길 수 있다
const GIT_LONG_MS = 600_000

class UsageError extends Error {}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function check(worktree: string, branch: string): number {
  const read = (args: string[]) => git(worktree, args).stdout.trim()
  const head = read(['rev-parse', 'HEAD'])
  const checks: [string, string, string][] = [
    ['브랜치', read(['branch', '--show-current']), branch],
    ['upstream', read(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), `origin/${branch}`],
    ['원격 끝', read(['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0], head],
  ]
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) out(`불일치: ${label} ${actual || '(없음)'}, 지시서 ${expected}`)
  }
  if (checks.every(([, actual, expected]) => actual === expected)) {
    out(`일치: ${branch} (HEAD ${head})`)
    return 0
  }
  return 1
}

function create(opts: { repo: string; name: string; base: string; resumeRemote: boolean; branch: string }): number {
  const { name, resumeRemote, branch } = opts
  const top = git(opts.repo, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) throw new UsageError(`git 저장소가 아니다: ${opts.repo}`)
  const repo = real(top.stdout.trim())
  const g = (args: string[], timeoutMs?: number) => git(repo, args, { timeoutMs })
  if (repoVisibility(repo) === 'hide') {
    err(
      '거부: 이 저장소는 externalWorktreeVisibility 가 hide 라 git worktree add 로 만든 워크트리를 Orca 가 숨긴다. ' +
        `워크트리를 만들기 전에 사용자가 아래 중 하나를 한다(스크립트는 설정을 바꾸지 않는다)\n${repoVisibilityActions(repo)}`,
    )
    return 1
  }
  if (g(['fetch', '-q', 'origin'], GIT_LONG_MS).code !== 0) {
    err('git fetch origin 실패')
    return 1
  }
  const base = opts.base ? opts.base.replace(/^origin\//, '') : (defaultBase(repo) ?? 'main')
  const exists = (ref: string) => g(['rev-parse', '--verify', '-q', ref]).code === 0
  if (!exists(`refs/remotes/origin/${base}`) && !resumeRemote) {
    err(`origin/${base} 가 없다`)
    return 1
  }
  const wt = join(repo, 'worktrees', basename(repo), name)
  let reason = ''
  if (existsSync(wt)) reason = `경로가 이미 있다: ${wt}. 이어서 하는 일이면 --worktree path: 로 띄운다`
  else if (exists(`refs/heads/${branch}`)) reason = `로컬 브랜치 ${branch} 가 이미 있다. 이어서 하는 일이면 그 워크트리에 띄운다`
  const remoteExists = exists(`refs/remotes/origin/${branch}`)
  if (!reason && remoteExists !== resumeRemote) {
    reason = remoteExists ? `원격 브랜치 origin/${branch} 가 이미 있다` : `이어 받을 원격 브랜치 origin/${branch} 가 없다`
  }
  if (reason) {
    err(`거부: ${reason}`)
    return 1
  }
  if (resumeRemote) {
    // 일반 fetch 는 삭제된 원격 브랜치의 tracking ref 를 남길 수 있다.
    // 브랜치를 명시해 다시 받아 서버의 존재 여부와 현재 tip 을 확인한다.
    const got = g(['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], GIT_LONG_MS)
    if (got.code !== 0) {
      err(`거부: 이어 받을 원격 브랜치 origin/${branch} 를 받지 못했다\n${got.stderr}`)
      return 1
    }
  }
  const added = g(
    ['worktree', 'add', '-q', resumeRemote ? '--track' : '--no-track', '-b', branch, wt, `origin/${resumeRemote ? branch : base}`],
    GIT_LONG_MS,
  )
  if (added.code !== 0) {
    err(added.stderr)
    return 1
  }
  if (g(['check-ignore', '-q', relative(repo, wt)]).code !== 0) {
    const common = g(['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()
    const exclude = join(common, 'info/exclude')
    mkdirSync(join(common, 'info'), { recursive: true })
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    appendFileSync(exclude, `${!text || text.endsWith('\n') ? '' : '\n'}/worktrees/\n`, 'utf8')
  }
  const settings = join(repo, '.claude/settings.local.json')
  if (isFile(settings)) {
    mkdirSync(join(wt, '.claude'), { recursive: true })
    copyFileSync(settings, join(wt, '.claude/settings.local.json'))
  }
  if (run(scriptCommand(DENY_SCRIPT, [wt])).code !== 0) err(`경고: deny 규칙을 더하지 못했다: ${wt}/.claude/settings.local.json`)
  out(wt)
  return 0
}

function main(argv: string[]): number {
  let values
  try {
    const options = {
      repo: { type: 'string', default: '' },
      name: { type: 'string', default: '' },
      base: { type: 'string', default: '' },
      check: { type: 'string', default: '' },
      spec: { type: 'string' },
      'resume-remote': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
  } catch (e) {
    err(`${USAGE}\nmake-worktree: ${(e as Error).message}`)
    return 2
  }
  if (values.help) {
    out(USAGE)
    return 0
  }
  try {
    if (!values.spec) throw new UsageError('--spec 이 필요하다')
    let text: string
    try {
      text = readFileSync(values.spec, 'utf8')
    } catch {
      throw new UsageError(`지시서가 없다: ${values.spec}`)
    }
    const branches = branchesOf(text)
    if (branches.length !== 1) {
      throw new UsageError(
        branches.length > 0
          ? `지시서에 줄 머리 \`브랜치:\` 줄이 둘 이상이다: ${branches.join(', ')}`
          : '지시서에 줄 머리 `브랜치:` 줄이 없다',
      )
    }
    const branch = branches[0]
    if (run(['git', 'check-ref-format', '--branch', branch]).code !== 0) throw new UsageError(`브랜치 이름이 올바르지 않다: ${branch}`)
    if (values.check) return check(values.check, branch)
    if (!values.repo || !values.name) throw new UsageError('--repo 와 --name 이 필요하다')
    return create({ repo: values.repo, name: values.name, base: values.base as string, resumeRemote: values['resume-remote'] as boolean, branch })
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    err(`${USAGE}\nmake-worktree: ${e.message}`)
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))
