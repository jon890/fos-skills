// 테스트용 git 도우미. 전역 설정을 읽지 않는 환경과, 한 번 만든 템플릿 저장소를 복사해 쓰는 저장소 준비를 준다.

import { spawnSync } from 'node:child_process'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './temp.ts'

export type Repo = { origin: string; dir: string }

// 테스트가 띄우는 git 이 이 기계의 전역·시스템 설정을 읽지 않고, 자동 정리를 백그라운드로 돌리지 않게 하는 값이다.
// 전역 설정은 이 폴더의 gitconfig 하나로 바꾼다. 그 파일이 `maintenance.autoDetach=false` 를 갖는다.
// GIT_CONFIG_COUNT 로 넣지 않는 이유: 로컬 경로로 push 하면 git 이 받는 쪽 receive-pack 의 환경에서 그 변수를 지운다.
//   전역 설정 파일은 그대로 읽혀 받는 저장소의 자동 정리에도 걸린다. 호출자가 넘긴 GIT_CONFIG_COUNT 도 덮지 않는다.
// 관측(git 2.56.1): commit 과 push 가 부르는 `git maintenance run --auto` 가 백그라운드로 남아, git 이 돌아온 뒤에도
//   `objects/maintenance.lock` 을 쥐고 있다가 지운다. 그사이 폴더를 복사하면 목록의 파일이 사라져 cpSync 가 ENOENT 로 실패할 수 있다.
//   CI 에서 본 rmSync 의 ENOTEMPTY 도 같은 원인으로 보지만 재현하지 못한 가설이다.
// 작성자는 테스트마다 다를 수 있어 넣지 않는다. git 을 띄우는 테스트는 이 값을 env 에 펼친다
export const GIT_CONFIG_FILE = fileURLToPath(new URL('./gitconfig', import.meta.url))

export const GIT_ISOLATION: Record<string, string> = {
  GIT_CONFIG_GLOBAL: GIT_CONFIG_FILE,
  GIT_CONFIG_NOSYSTEM: '1',
}

export function gitEnv(base: NodeJS.ProcessEnv = process.env, opts: { ceiling?: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...GIT_ISOLATION,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  if (opts.ceiling) env.GIT_CEILING_DIRECTORIES = opts.ceiling
  return env
}

// 종료 코드가 0 이 아니면 던진다. 0 이면 stdout 을 trim 해 돌려준다
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnv()): string {
  const done = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} 실패 (종료 ${done.status}): ${done.stderr}`)
  return done.stdout.trim()
}

let template: Repo | null = null

// origin 과 clone 을 프로세스마다 한 번 만들고 다음 호출은 같은 값을 돌려준다
export function templateRepo(): Repo {
  if (!template) {
    const root = tempDir('testkit-template-')
    const origin = join(root, 'origin.git')
    const dir = join(root, 'work')
    git(root, ['init', '-q', '--bare', '-b', 'main', origin])
    git(root, ['clone', '-q', origin, dir])
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'init'])
    git(dir, ['push', '-q', '-u', 'origin', 'main'])
    template = { origin, dir }
  }
  return template
}

// 템플릿을 `<dest>-origin.git` 과 `<dest>` 로 복사하고 origin 주소를 사본으로 바꾼다
export function copyRepo(dest: string, source: Repo = templateRepo()): Repo {
  const origin = `${dest}-origin.git`
  cpSync(source.origin, origin, { recursive: true })
  cpSync(source.dir, dest, { recursive: true })
  git(dest, ['remote', 'set-url', 'origin', origin])
  return { origin, dir: dest }
}
