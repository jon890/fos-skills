// git 호출의 한 벌이다. 주 checkout 찾기, --repo 인자 검사, 기준 브랜치 판정, merge-tree 충돌 판정을 한 곳에 둔다.

import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { real } from './fs.ts'
import { run } from './proc.ts'
import type { RunOptions, RunResult } from './proc.ts'

export function git(repo: string, args: string[], opts?: RunOptions): RunResult {
  return run(['git', '-C', repo, ...args], opts)
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

// gh 의 --repo 값(owner/name)처럼 보이는지. 점이나 / 로 시작하는 상대·절대 경로는 아니다
const GH_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/

// --repo 로 받은 값이 git 작업 트리 안의 디렉터리인지 본다. 맞으면 null, 아니면 사용법 오류의 이유 한 줄이다.
// 명령은 인자를 읽은 직후, 폴더나 파일을 만들기 전에 부르고 이유가 있으면 종료 코드 2 로 멈춘다.
// 없는 경로를 그대로 쓰면 설정 파일을 찾지 못해 빈 설정으로 돌고(lib/config.ts 의 loadConfig 는 {} 다),
// 큐와 로그 폴더를 <작업 디렉터리>/<값>/.orch 아래에 새로 만든다.
// gh 의 --repo 와 이름이 같아 owner/name 을 주기 쉬워, 그 모양이면 로컬 경로라고 알린다.
export function repoArgProblem(value: string): string | null {
  const hint = GH_REPO.test(value) ? ` --repo 는 로컬 경로다. ${value} 는 GitHub 의 owner/name 모양이다. 저장소 체크아웃 경로를 준다` : ''
  let isDir = false
  try {
    isDir = statSync(value).isDirectory()
  } catch {
    // 없거나 읽지 못하는 경로다. 아래에서 디렉터리가 아니라고 알린다
  }
  if (!isDir) return `--repo 가 디렉터리가 아니다: ${value}.${hint}`
  const done = git(value, ['rev-parse', '--is-inside-work-tree'])
  if (done.code !== 0 || done.stdout.trim() !== 'true') return `--repo 가 git 작업 트리가 아니다: ${value}.${hint}`
  return null
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
  // merge-tree 는 없는 커밋을 받아도 1 로 끝난다. 그때는 첫 줄에 트리 id 가 없으므로 그것으로 충돌과 구분한다(git 2.50 실측).
  const lines = done.stdout.split('\n')
  if (done.code === 1 && /^[0-9a-f]{40,64}$/.test(lines[0])) {
    const files = [...new Set(lines.slice(1).filter((line) => line))].sort()
    return { ok: true, conflict: true, files }
  }
  return { ok: false, error: `${base} 와 ${head} 를 합쳐 보지 못했다(종료 코드 ${done.code}): ${done.stderr.trim()}` }
}
