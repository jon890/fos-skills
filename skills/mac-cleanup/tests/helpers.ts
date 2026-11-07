// mac-cleanup 명령 경계 테스트의 공용 helper. 임시 홈, 가짜 실행 파일, 명령 실행, 임시 git 저장소, 「명령 경계」 상수를 둔다.
// 이 스킬은 팀으로 내보내지 않아 modules/testkit 을 쓴다.
//
// 「명령 경계」 상수(IMPL)가 구현을 가린다. 테스트 사례는 이 상수만 보고 명령을 부르고, 구현을 바꿀 때 이 상수만 바꾼다.
//
// 이 스킬의 명령은 파일과 컨테이너 자원을 지우는 명령을 부른다. 그래서 테스트는 임시 홈과 임시 저장소, PATH 맨 앞의 가짜 실행 파일만 쓴다.
// 자식의 PATH 는 가짜 폴더와, 실제 실행 파일을 링크한 폴더 하나로 한정한다. 이 머신의 docker, gh, colima 가 섞이지 않는다.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { runCommand } from '../../../modules/testkit/command.ts'
import { fakeBin, linkBin, type FakeBin, type FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { git, gitEnv } from '../../../modules/testkit/git.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'

export const SCRIPTS_DIR = join(import.meta.dirname, '..', 'scripts')

// PATH 에서 실행 파일의 실제 경로를 찾는다
export function findExecutable(name: string, searchPath = process.env.PATH ?? ''): string {
  for (const dir of searchPath.split(delimiter)) {
    const candidate = join(dir, name)
    if (dir && existsSync(candidate)) return candidate
  }
  throw new Error(`${name} 을 PATH 에서 찾지 못했다`)
}

const PYTHON = execFileSync(findExecutable('python3'), ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()

// 명령 경계. 실행기와 확장자다. survey_gradle 만 셸 스크립트다
export const IMPL = {
  main: { argv: [PYTHON], ext: '.py' },
  shell: { argv: ['/bin/bash'], ext: '.sh' },
}

export type Result = { code: number | null; stdout: string; stderr: string }

export function command(name: string): string[] {
  const impl = name === 'survey_gradle' ? IMPL.shell : IMPL.main
  return [...impl.argv, join(SCRIPTS_DIR, `${name}${impl.ext}`)]
}

export function write(path: string, text = '', mode = 0o644): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode })
  return path
}

// 임시 홈과 가짜 실행 파일 폴더. env 의 PATH 는 가짜 폴더와 링크 폴더뿐이다
export class Sandbox {
  readonly root: string
  readonly home: string
  readonly fakes: string
  readonly tools: string

  constructor(prefix = 'mc-', realTools: string[] = ['git', 'du']) {
    this.root = tempDir(prefix)
    this.home = join(this.root, 'home')
    this.fakes = join(this.root, 'fakes')
    this.tools = join(this.root, 'tools')
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.fakes, { recursive: true })
    mkdirSync(this.tools, { recursive: true })
    for (const name of realTools) symlinkSync(findExecutable(name), join(this.tools, name))
  }

  fake(name: string, rules: FakeRule[], opts: { recordEnv?: string[] } = {}): FakeBin {
    return fakeBin(this.fakes, name, rules, opts)
  }

  // 본문을 직접 쓰는 가짜 실행 파일(호출 사이에 상태가 바뀌는 경우)
  script(name: string, body: string): string {
    return linkBin(this.fakes, name, body)
  }

  env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return gitEnv({
      PATH: [this.fakes, this.tools].join(delimiter),
      HOME: this.home,
      LANG: 'C',
      LC_ALL: 'C',
      PYTHONUTF8: '1',
      TZ: 'UTC',
      ...extra,
    } as NodeJS.ProcessEnv)
  }

  run(name: string, args: string[] = [], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Result {
    const done = runCommand([...command(name), ...args], { cwd: opts.cwd, env: opts.env ?? this.env(), input: opts.input, timeoutMs: opts.timeoutMs })
    return { code: done.code, stdout: done.stdout, stderr: done.stderr }
  }
}

// 임시 git 저장소. 커밋은 빈 커밋이고 필요하면 날짜를 고정한다
export class Repo {
  readonly dir: string
  constructor(dir: string, init = true) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    if (init) this.git('init', '-q', '-b', 'main')
  }
  git(...args: string[]): string {
    return git(this.dir, args)
  }
  commit(message: string, epoch?: number): string {
    const env = epoch === undefined ? gitEnv() : gitEnv({ ...process.env, GIT_COMMITTER_DATE: `${epoch} +0000`, GIT_AUTHOR_DATE: `${epoch} +0000` })
    git(this.dir, ['commit', '-q', '--allow-empty', '-m', message], env)
    return this.git('rev-parse', 'HEAD')
  }
  has(branch: string): boolean {
    try {
      this.git('rev-parse', '-q', '--verify', `refs/heads/${branch}`)
      return true
    } catch {
      return false
    }
  }
}

export const lines = (text: string): string[] => text.split('\n')
