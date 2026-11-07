// harness-cleanup 명령 경계 테스트의 공용 helper. 임시 폴더, 명령 실행, 임시 git 저장소, 「명령 경계」 상수를 둔다.
// 이 스킬은 팀으로 내보내지 않아 modules/testkit 을 쓴다.
//
// 「명령 경계」 상수(IMPL)가 구현을 가린다. 테스트 사례는 이 상수만 보고 명령을 부르고, 구현을 바꿀 때 이 상수만 바꾼다.

import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runCommand } from '../../../modules/testkit/command.ts'
import { git, gitEnv } from '../../../modules/testkit/git.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'

export const SCRIPTS_DIR = join(import.meta.dirname, '..', 'scripts')

// 명령 경계. 실행기와 확장자다
// PATH 를 비운 환경에서도 실행기를 찾도록 절대 경로로 둔다
const PYTHON = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
export const IMPL = { argv: [PYTHON], ext: '.py' }

export type Result = { code: number | null; stdout: string; stderr: string }

export function command(name: string): string[] {
  return [...IMPL.argv, join(SCRIPTS_DIR, `${name}${IMPL.ext}`)]
}

export function run(name: string, args: string[] = [], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Result {
  const argv = command(name)
  const done = runCommand([...argv, ...args], { cwd: opts.cwd, env: opts.env ?? gitEnv(), input: opts.input })
  return { code: done.code, stdout: done.stdout, stderr: done.stderr }
}

export function write(path: string, text = '', mode = 0o644): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode })
  return path
}

export class Repo {
  readonly root: string
  constructor(prefix = 'hc-', gitInit = false) {
    this.root = tempDir(prefix)
    if (gitInit) git(this.root, ['init', '-q', '-b', 'main'])
  }
  file(rel: string, text = ''): string {
    return write(join(this.root, rel), text)
  }
  link(rel: string, target: string): void {
    mkdirSync(dirname(join(this.root, rel)), { recursive: true })
    symlinkSync(target, join(this.root, rel))
  }
  git(...args: string[]): string {
    return git(this.root, args)
  }
  commitAll(message = 'c'): void {
    this.git('add', '-A')
    this.git('commit', '-q', '-m', message)
  }
  run(name: string, args: string[] = [], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Result {
    return run(name, args, { cwd: opts.cwd ?? this.root, env: opts.env })
  }
}

// HOME 을 가짜로 바꾼 환경. 설치된 스킬 이름과 홈 경로 검사가 이 홈을 본다
export function homeEnv(home: string): NodeJS.ProcessEnv {
  return gitEnv({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: undefined } as NodeJS.ProcessEnv)
}
