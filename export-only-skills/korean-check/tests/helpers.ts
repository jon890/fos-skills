// korean-check 명령 경계 테스트의 공용 helper. 임시 폴더, 명령 실행, 임시 git 저장소, 「명령 경계」 상수를 둔다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.
//
// 「명령 경계」 상수가 구현을 가린다. 테스트 사례는 이 상수만 보고 명령을 부르고, 구현을 바꿀 때 이 상수만 바꾼다.

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const SKILL_DIR = join(import.meta.dirname, '..')
export const SCRIPTS_DIR = join(SKILL_DIR, 'scripts')
export const RULES = join(SKILL_DIR, 'references', 'korean-style.md')

// 명령 경계. 실행 argv 의 앞부분이다
export const STYLE = ['python3', join(SCRIPTS_DIR, 'korean-style-check.py')]
export const READABILITY = ['python3', join(SCRIPTS_DIR, 'check-readability.py')]
export const DIFF = ['python3', join(SCRIPTS_DIR, 'check-diff.py')]
export const CHECK = ['bash', join(SCRIPTS_DIR, 'check.sh')]

export type Result = { code: number | null; stdout: string; stderr: string }
type T = { after(fn: () => void): void }

const roots: string[] = []
process.on('exit', () => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

export function tempDir(prefix = 'korean-check-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

// 개발자 환경의 설정이 결과를 바꾸지 않게 이 스킬이 읽는 환경 변수를 비운다
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['KOREAN_STYLE_RULES', 'KOREAN_CHECK_ALLOW', 'NODE_TEST_CONTEXT']) delete env[key]
  return { ...env, ...extra }
}

export function run(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; args?: string[] } = {}): Result {
  const done = spawnSync(argv[0], [...argv.slice(1), ...(opts.args ?? [])], { cwd: opts.cwd, env: opts.env ?? cleanEnv(), input: opts.input, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

export function write(path: string, text: string, mode = 0o644): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

// 임시 git 저장소. 커밋 환경 변수를 고정한다
export const GIT_ENV = cleanEnv({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' })

export function git(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout
}

export function initRepo(dir: string): string {
  git(dir, 'init', '-q', '-b', 'main')
  return dir
}

// 파일 하나를 검사해 발견 줄을 낸다. 줄마다 따로 보려고 표본을 빈 줄로 나눠 한 파일에 담는다
// (코드 블록과 frontmatter 처럼 줄 사이의 상태가 필요 없는 표본만 이렇게 묶는다). 표본 i 는 파일의 2*i+1 번째 줄이다
export function sampleFile(dir: string, samples: string[], name = 'samples.md'): string {
  return write(join(dir, name), samples.join('\n\n') + '\n')
}

export function lineOf(index: number): number {
  return 2 * index + 1
}

// 「경로:줄:」 로 시작하는 발견 줄을 줄 번호로 모은다
export function findingsByLine(stdout: string): Map<number, string[]> {
  const found = new Map<number, string[]>()
  for (const row of stdout.split('\n')) {
    const m = /^.+?:(\d+)[: ]/.exec(row)
    if (!m) continue
    found.set(Number(m[1]), [...(found.get(Number(m[1])) ?? []), row])
  }
  return found
}

export type { T }
