// plan 명령 경계 테스트의 공용 helper. 임시 폴더, 명령 실행, 임시 git 저장소, 계획 폴더 만들기, 「명령 경계」 상수를 둔다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.
//
// 「명령 경계」 상수가 구현을 가린다. 테스트 사례는 이 상수만 보고 명령을 부르고, 구현을 바꿀 때 이 상수만 바꾼다.

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const SKILL_DIR = join(import.meta.dirname, '..')
export const SCRIPTS_DIR = join(SKILL_DIR, 'scripts')

// 명령 경계. 실행 argv 의 앞부분이다
export const VERIFY = [process.execPath, join(SCRIPTS_DIR, 'verify_task.ts')]
export const FEATURE = [process.execPath, join(SCRIPTS_DIR, 'check_feature.ts')]
export const DOC_CHECKS = [process.execPath, join(SCRIPTS_DIR, 'run_doc_checks.ts')]
export const OVERLAY = [process.execPath, join(SCRIPTS_DIR, 'overlay_paths.ts')]
export const PLAN_NUMBER = [process.execPath, join(SCRIPTS_DIR, 'plan_number.ts')]

export type Result = { code: number | null; stdout: string; stderr: string }

const roots: string[] = []
process.on('exit', () => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

export function tempDir(prefix = 'plan-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

// 개발자 환경의 설정이 결과를 바꾸지 않게 git 설정을 고정하고 테스트 러너 표지를 지운다
export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return {
    ...env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  }
}

export function run(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; args?: string[] } = {}): Result {
  const done = spawnSync(argv[0], [...argv.slice(1), ...(opts.args ?? [])], { cwd: opts.cwd, env: opts.env ?? baseEnv(), input: opts.input, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

export function write(path: string, text = '', mode = 0o644): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

export function read(path: string): string {
  return readFileSync(path, 'utf8')
}

export function git(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout
}

// 임시 저장소. 파일을 쓰고 git 을 부른다
export class Repo {
  readonly root: string
  constructor(prefix = 'plan-repo-', init = false) {
    this.root = tempDir(prefix)
    if (init) this.git('init', '--quiet', '-b', 'main')
  }
  file(rel: string, text = ''): string {
    return write(join(this.root, rel), text)
  }
  git(...args: string[]): string {
    return git(this.root, ...args)
  }
  initGit(): void {
    this.git('init', '--quiet', '-b', 'main')
  }
  run(argv: string[], args: string[] = [], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Result {
    return run(argv, { cwd: this.root, args, ...opts })
  }
}

export type Entry = [rel: string, action: string]
export type Phase = { work?: string; command?: string; entries?: Entry[]; extra?: string; evidence?: string }

// 검사기가 요구하는 절을 갖춘 phase 본문. 사례가 보는 작업 항목, 검증 명령, 변경 파일만 바꾼다
export function phaseText(p: Phase = {}): string {
  const entries = p.entries ?? []
  const rows = entries.map(([rel, action]) => `| \`${rel}\` | ${action} |`).join('\n')
  return (
    `## 목표\n앱\n**범위 외**: 배포\n\n## 컨텍스트\n**근거 문서**: ${p.evidence ?? '`docs/flow.md`'}\n\n` +
    `## 작업 항목\n${p.work ?? '### 1. 작업'}\n\n## 검증\n\`\`\`bash\n${p.command ?? 'pytest'}\n\`\`\`\n\n` +
    `## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n${rows}\n${p.extra ?? ''}`
  )
}

export function indexJson(name: string, count: number, extra: Record<string, unknown> = {}): string {
  const phases = Array.from({ length: count }, (_, i) => ({ number: i + 1, file: `phase-${String(i + 1).padStart(2, '0')}.md`, execution_profile: 'standard' }))
  return JSON.stringify({ name, total_phases: count, phases, ...extra })
}

// 계획 폴더를 만든다. 반환은 폴더의 저장소 상대 경로다
export function writePlan(repo: Repo, name: string, phases: Phase[], opts: { tasksDir?: string; index?: Record<string, unknown> } = {}): string {
  const dir = `${opts.tasksDir ?? 'tasks'}/${name}`
  phases.forEach((phase, i) => repo.file(`${dir}/phase-${String(i + 1).padStart(2, '0')}.md`, phaseText(phase)))
  repo.file(`${dir}/index.json`, indexJson(name, phases.length, opts.index))
  return dir
}

export type Verified = { code: number | null; violations: string[]; warnings: string[]; stdout: string; stderr: string; summary: string }

// verify_task 의 출력을 위반, 경고, 끝 줄로 나눈다
export function verify(repo: Repo, args: string[]): Verified {
  const r = repo.run(VERIFY, args)
  const lines = r.stdout.split('\n').filter((line) => line !== '')
  const summary = lines.find((line) => /^위반 \d+건, 경고 \d+건$/.test(line)) ?? ''
  const rest = lines.filter((line) => line !== summary)
  return {
    code: r.code,
    violations: rest.filter((line) => !line.startsWith('경고: ')),
    warnings: rest.filter((line) => line.startsWith('경고: ')).map((line) => line.slice('경고: '.length)),
    stdout: r.stdout,
    stderr: r.stderr,
    summary,
  }
}

export type Extra = Partial<Phase> & { files?: Record<string, string>; git?: boolean; text?: (phase: string) => string; args?: string[] }

// 한 phase 를 만들어 --audit 로 검사한다. 구현 전 파일 상태는 대조하지 않아 phase 본문의 규칙만 보인다.
// extra.files 는 저장소에 미리 둘 파일, extra.text 는 만든 phase 본문을 고치는 함수다
export function inspect(work: string, command: string, entries: Entry[], extra: Extra = {}): Verified {
  const repo = new Repo()
  repo.file('docs/flow.md')
  for (const [rel, text] of Object.entries(extra.files ?? {})) repo.file(rel, text)
  if (extra.git) repo.initGit()
  const plan = 'plan1-x'
  const { files: _files, git: _git, text, args, ...phase } = extra
  const dir = writePlan(repo, plan, [{ work, command, entries, ...phase }])
  if (text) repo.file(`${dir}/phase-01.md`, text(phaseText({ work, command, entries, ...phase })))
  return verify(repo, [plan, '--audit', ...(args ?? [])])
}

export type Kind = 'test' | 'other' | 'unknown'

// 검증 절의 명령 줄이 테스트 실행으로 읽히는지 본다. unknown 은 판정하지 못한 실행기다
export function kind(command: string, files: Record<string, string> = {}): Kind {
  const result = inspect('### 1. 문서', command, [['docs/a.md', '수정']], { files })
  if (result.warnings.some((w) => w.includes('판정하지 못한'))) return 'unknown'
  return result.violations.some((line) => line.includes('검증 절에 테스트 실행 명령이 없다')) ? 'other' : 'test'
}

// 기능 스펙과 기술 설계의 올바른 예. check_feature 와 verify_task 의 계획 검사가 함께 쓴다
export const VALID = `# 취소
확인: 2026-11-02
## 목표
작업 취소
## 범위
소유자의 작업
## 요구사항과 인수 조건
| ID | 요구사항 | 인수 조건 |
| --- | --- | --- |
| R1 | 권한 | 타 사용자는 거부 |
| R2 | 멱등성 | 반복해도 부작용 없음 |
## 설계
실행 API 의 상태를 통합 테스트로 확인한다.
## 결정
| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| D1 | 취소 권한 | 소유자만 | 사용자 2026-11-02 | 대리 취소 요청이 없었다 |
| D2 | 반복 응답 | 200 | 작성자 | 기존 멱등 관례 |
`
export const UNCONFIRMED = VALID.replace('확인: 2026-11-02\n', '')
export const VALID_REQ = VALID.replaceAll('| R', '| REQ').replaceAll('| D', '| DECISION')
export const DESIGN = `# 기술 설계
## 요구사항 연결
| ID | 해결 방법 |
| --- | --- |
| REQ1 | 작업 모듈이 권한을 검사한다 |
| REQ2 | 조건부 상태 갱신을 사용한다 |
## 책임과 경계
작업 모듈이 상태를 소유한다.
## 인터페이스와 데이터
기존 API 와 저장소를 사용한다.
## 실패와 일관성
권한을 상태 변경 전에 검사한다.
## 검증 전략
API 와 저장 상태를 통합 검증한다.
## 결정
없음: 기존 구조를 유지한다.
`
