// 테스트용 git 도우미. 전역 설정을 읽지 않는 환경과, 한 번 만든 템플릿 저장소를 복사해 쓰는 저장소 준비를 준다.

import { spawnSync } from 'node:child_process'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './temp.ts'

export type Repo = { origin: string; dir: string }

// 테스트가 띄우는 git 이 이 기계의 전역·시스템 설정을 읽지 않고, 자동 정리를 백그라운드로 돌리지 않게 하는 값이다.
// git 2.47 부터 commit, push(받는 쪽 receive-pack), fetch 가 부르는 `git maintenance run --auto` 는 기본으로 백그라운드 자식 프로세스로 돈다.
// git 2.56 은 git 이 돌아온 뒤에도 그 자식이 `objects/maintenance.lock` 을 쥐고 있다가 지운다. 그사이 테스트가 그 폴더를
// 복사하거나 지우면 cpSync 가 ENOENT, rmSync 가 ENOTEMPTY 로 가끔 실패했다. autoDetach 를 끄면 같은 정리가 git 안에서 끝난다.
// 작성자는 테스트마다 다를 수 있어 넣지 않는다. git 을 띄우는 테스트는 이 값을 env 에 펼친다
export const GIT_ISOLATION: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'maintenance.autoDetach',
  GIT_CONFIG_VALUE_0: 'false',
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
