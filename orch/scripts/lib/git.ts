// git 호출의 한 벌이다. 주 checkout 찾기, 기준 브랜치 판정, merge-tree 충돌 판정을 한 곳에 둔다.

import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { run } from './proc.ts'
import type { RunOptions, RunResult } from './proc.ts'

export function git(repo: string, args: string[], opts?: RunOptions): RunResult {
  return run(['git', '-C', repo, ...args], opts)
}

function real(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

// repo 의 주 checkout. git 밖이거나 bare 저장소면 받은 폴더(realpath)다.
export function mainCheckout(repo: string): string {
  const self = real(repo)
  const common = git(self, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const commonDir = common.stdout.trim()
  if (common.code !== 0 || !commonDir) return self
  const commonReal = real(commonDir)
  if (basename(commonReal) === '.git') return dirname(commonReal)
  const top = git(self, ['rev-parse', '--show-toplevel'])
  const topDir = top.stdout.trim()
  return top.code === 0 && topDir ? real(topDir) : self
}

// origin/HEAD 가 가리키는 브랜치 이름(예: main). 읽지 못하면 null 이다.
// main 으로 가정하지 않는다. 기본 브랜치가 main 이 아닌 저장소에서 엉뚱한 브랜치와 비교하게 되기 때문이다.
// null 이면 부르는 쪽이 --base 를 요구하거나 설정값을 쓴다.
export function defaultBase(repo: string): string | null {
  const done = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const ref = done.stdout.trim()
  if (done.code !== 0 || !ref.startsWith('origin/')) return null
  return ref.slice('origin/'.length) || null
}

// base 와 head 를 합쳐 본다. 종료 코드 0 은 충돌 없음, 1 은 충돌이고 첫 줄(트리 id)을 뺀 줄이 파일 목록이다.
// GitHub 의 mergeable 은 계산이 늦어 UNKNOWN 이 자주 나오므로 쓰지 않는다.
export function conflicts(repo: string, base: string, head: string): { ok: true; conflict: boolean; files: string[] } | { ok: false; error: string } {
  const done = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head])
  if (done.code === 0) return { ok: true, conflict: false, files: [] }
  // merge-tree 는 없는 커밋을 받아도 1 로 끝난다. 그때는 첫 줄에 트리 id 가 없으므로 그것으로 충돌과 가른다(git 2.50 실측).
  const lines = done.stdout.split('\n')
  if (done.code === 1 && /^[0-9a-f]{40,64}$/.test(lines[0])) {
    const files = [...new Set(lines.slice(1).filter((line) => line))].sort()
    return { ok: true, conflict: true, files }
  }
  return { ok: false, error: `${base} 와 ${head} 를 합쳐 보지 못했다(종료 코드 ${done.code}): ${done.stderr.trim()}` }
}
