#!/usr/bin/env node
// 작업 트리를 플러그인으로 설치해 보고, 설치 캐시에서 스킬과 경로 참조가 동작하는지 확인한다.
//
// 매니페스트 테스트는 파일만 보므로, 설치해야 드러나는 문제를 여기서 잡는다.
// 실제 ~/.claude 는 바꾸지 않는다. 임시 디렉터리를 CLAUDE_CONFIG_DIR 로 쓰고,
// 가짜 git 주소를 임시 저장소로 돌려 마켓플레이스를 등록한다. 네트워크는 쓰지 않는다.
//
// 사용법:
//   node scripts/test-plugin-install.ts           점검하고 임시 디렉터리를 지운다
//   node scripts/test-plugin-install.ts --keep    임시 디렉터리를 지우지 않고 경로를 출력한다
//
// 출력: 점검마다 `ok: <내용>` 또는 `FAIL: <내용>` 줄, 끝에 `통과` 또는 `실패 N 건`.
// 종료 코드: 0 통과, 1 점검 실패, 2 실행 불가(모르는 인자, claude·git·python3·bash 없음, 격리 실패)

import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { isDir } from './skill_paths.ts'
import { isMainModule } from './is-main.ts'

const REPO_DIR = join(import.meta.dirname, '..')
const FAKE_URL = 'https://marketplace.test/fos-skills.git'
const PLUGIN_ID = 'fos-skills@fos-skills'

function onPath(tool: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, tool), constants.X_OK)
      return true
    } catch {
      // 다음 폴더를 본다
    }
  }
  return false
}

type Run = { rc: number; out: string }

// 명령을 돌려 stdout 과 stderr 를 함께 받는다
function run(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const done = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { rc: done.status ?? 1, out: `${done.stdout ?? ''}${done.stderr ?? ''}${done.error ? done.error.message : ''}`.replace(/\n+$/, '') }
}

// git 이 추적하거나 추적 후보인 파일만 복사한다. 무시되는 worktrees/, .omc/, .orch/ 의 로컬 파일은 빠지고
// 아직 커밋하지 않은 새 파일은 들어간다. 작업 트리에서 지운 파일은 목록에서 뺀다
function copyTree(dest: string): void {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  for (const file of new Set(listed.stdout.split('\0'))) {
    if (!file) continue
    const src = join(REPO_DIR, file)
    let stat
    try {
      stat = lstatSync(src)
    } catch {
      continue
    }
    const target = join(dest, file)
    mkdirSync(dirname(target), { recursive: true })
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(src), target)
    else copyFileSync(src, target) // 권한 비트도 함께 옮긴다
  }
}

function links(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) found.push(path)
    else if (stat.isDirectory()) found.push(...links(path))
  }
  return found
}

function isExecutableFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile() && !existsSync(path)) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function main(argv: string[]): number {
  let keep = false
  for (const arg of argv) {
    if (arg === '--keep') keep = true
    else {
      process.stderr.write(`알 수 없는 인자: ${arg}\n`)
      return 2
    }
  }
  for (const tool of ['claude', 'git', 'python3', 'bash']) {
    if (!onPath(tool)) {
      process.stderr.write(`실행 불가: ${tool} 없음\n`)
      return 2
    }
  }

  const T = realpathSync(mkdtempSync('/tmp/fos-skills-plugin.'))
  if (keep) process.stdout.write(`임시 디렉터리를 남긴다: ${T}\n`)
  try {
    return check(T)
  } finally {
    if (!keep) rmSync(T, { recursive: true, force: true })
  }
}

function check(T: string): number {
  const src = join(T, 'src')
  copyTree(src)
  const gitInit = (args: string[]) => spawnSync('git', ['-C', src, ...args], { stdio: 'ignore' })
  gitInit(['init', '-q'])
  gitInit(['add', '-A'])
  gitInit(['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', 'commit', '-q', '-m', 'install test'])

  const config = join(T, 'config')
  // 실제 ~/.claude 에 가짜 마켓플레이스가 등록되지 않게 claude 를 부르기 전에 격리를 확인한다
  if (!config.startsWith(`${T}/`)) {
    process.stderr.write('실행 불가: CLAUDE_CONFIG_DIR 격리 실패\n')
    return 2
  }
  mkdirSync(config, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: config,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${src}.insteadOf`,
    GIT_CONFIG_VALUE_0: FAKE_URL,
  }
  delete env.NODE_TEST_CONTEXT

  let fails = 0
  const ok = (message: string) => process.stdout.write(`ok: ${message}\n`)
  const fail = (message: string, detail?: string) => {
    process.stdout.write(`FAIL: ${message}\n`)
    if (detail !== undefined) process.stdout.write(`${detail}\n`)
    fails++
  }

  // 기대하는 스킬 이름은 매니페스트의 skills 배열에서 읽는다
  const manifest = JSON.parse(readFileSync(join(src, '.claude-plugin/plugin.json'), 'utf8'))
  const strip = (skill: string) => (skill.startsWith('./') ? skill.slice(2) : skill)
  const skills: string[] = manifest.skills.map(strip).filter(Boolean)
  const expected = skills.length

  // 내보내기 전용 원본만 배열에서 빠질 수 있다. 다른 스킬 누락은 설치 전에 잡는다
  let r = run([process.execPath, '--test', join(src, 'scripts/tests/plugin-manifest.spec.ts')], { cwd: src, env })
  if (r.rc === 0) ok('매니페스트 시험: 내보내기 전용 원본만 스킬 목록에서 제외된다')
  else fail('매니페스트 시험이 실패했다', r.out)

  const exportOnly: string[] = JSON.parse(readFileSync(join(src, 'scripts/export-only-skills.json'), 'utf8')).map(strip).filter(Boolean)

  // 검증: 매니페스트 오류와 경고가 없어야 한다
  r = run(['claude', 'plugin', 'validate', '.', '--json'], { cwd: src, env })
  let valid = false
  try {
    const result = JSON.parse(r.out)
    const m = result.manifest ?? {}
    const paths = (m.warnings ?? []).map((w: { path?: string }) => w.path)
    valid = r.rc === 0 && result.success === true && !(m.errors && m.errors.length) && paths.length === 0
  } catch {
    valid = false
  }
  if (valid) ok('claude plugin validate 가 오류와 경고 없이 통과한다')
  else fail('claude plugin validate 결과가 기대와 다르다', r.out)

  r = run(['claude', 'plugin', 'marketplace', 'add', FAKE_URL], { env })
  if (r.rc !== 0) fail(`마켓플레이스 등록이 실패했다 (종료 코드 ${r.rc})`, r.out)
  r = run(['claude', 'plugin', 'install', PLUGIN_ID], { env })
  if (r.rc !== 0) fail(`플러그인 설치가 실패했다 (종료 코드 ${r.rc})`, r.out)

  // 설치 상태
  r = run(['claude', 'plugin', 'list'], { env })
  if (r.rc === 0 && r.out.includes(PLUGIN_ID) && r.out.includes('enabled')) ok(`설치 상태: ${PLUGIN_ID} 가 enabled 이다`)
  else fail(`설치 상태: claude plugin list 에 ${PLUGIN_ID} 와 enabled 가 없다`, r.out)

  // 스킬 인식
  r = run(['claude', 'plugin', 'details', PLUGIN_ID], { env })
  const skillsLine = r.out.split('\n').find((line) => /Skills \([0-9]+\)/.test(line)) ?? ''
  // 옛 sed 의 탐욕 매칭처럼 줄의 마지막 Skills (N) 을 고른다
  const count = /.*Skills \(([0-9]+)\)/.exec(skillsLine)?.[1] ?? ''
  const missing = skills.filter((name) => !skillsLine.includes(basename(name)))
  if (r.rc === 0 && count === String(expected) && missing.length === 0) ok(`스킬 인식: ${count}개가 모두 인식된다`)
  else fail(`스킬 인식: 기대 ${expected}개, 인식 ${count || '없음'}개, 빠진 이름:${missing.length ? missing.map((n) => ` ${n}`).join('') : ' 없음'}`, r.out)

  // 캐시 디렉터리
  const cacheRoot = join(config, 'plugins/cache/fos-skills/fos-skills')
  // 옛 셸의 "$CACHE_ROOT"/* 와 [ -d ] 다. 점으로 시작하는 이름은 빼고 링크는 따라간다
  const caches = existsSync(cacheRoot) ? readdirSync(cacheRoot).filter((name) => !name.startsWith('.') && isDir(join(cacheRoot, name))).sort() : []
  const version = manifest.version
  let cache = ''
  if (caches.length === 1 && caches[0] === version) {
    cache = join(cacheRoot, caches[0])
    ok(`캐시 디렉터리: ${caches[0]}`)
  } else {
    fail(`캐시 디렉터리: ${cacheRoot} 아래에 plugin.json version(${version}) 이름의 디렉터리가 하나여야 한다 (발견 ${caches.length}개)`)
  }

  if (!cache) {
    // 캐시가 없으면 이후 검사는 의미가 없다
    fail('스킬 파일, 형제 참조, 검사기 탐색, 도구, 스크립트 실행, 링크 없음 검사를 할 수 없다')
  } else {
    // 내보내기 전용 원본은 캐시에 남지만 스킬로 인식되면 안 된다
    for (const name of exportOnly) {
      if (existsSync(join(cache, name, 'SKILL.md'))) ok(`내보내기 전용 원본: ${name}/SKILL.md 가 캐시에 남는다`)
      else fail(`내보내기 전용 원본: ${name}/SKILL.md 가 캐시에 없다`)
      if (skillsLine.includes(basename(name))) fail(`내보내기 전용 원본: ${name} 이 스킬로 인식됐다`)
      else ok(`내보내기 전용 원본: ${name} 이 스킬 목록에 없다`)
    }

    // 스킬 파일
    const noSkillMd = skills.filter((name) => !existsSync(join(cache, name, 'SKILL.md')))
    if (noSkillMd.length === 0) ok(`스킬 파일: ${expected}개 모두 SKILL.md 가 있다`)
    else fail(`스킬 파일: SKILL.md 가 없는 스킬:${noSkillMd.map((n) => ` ${n}`).join('')}`)

    // 형제 참조
    if (existsSync(join(cache, 'export-only-skills/content-preview/../korean-check/references/review-axes.md'))) {
      ok('형제 참조: content-preview 에서 export-only-skills/korean-check/references/review-axes.md 로 닿는다')
    } else {
      fail('형제 참조: content-preview/../korean-check/references/review-axes.md 가 없다')
    }

    // 검사기 탐색
    const expectCheck = realpathSync(join(cache, 'export-only-skills/korean-check'))
    r = run([process.execPath, join(cache, 'export-only-skills/content-preview/scripts/style-check.ts'), '--where'], { env: { ...env, KOREAN_CHECK: '' } })
    let where = ''
    try {
      where = realpathSync(r.out)
    } catch {
      where = ''
    }
    if (r.rc === 0 && where === expectCheck) ok('검사기 탐색: style-check.ts --where 가 설치된 korean-check 를 가리킨다')
    else fail(`검사기 탐색: 기대 ${expectCheck}, 실제 '${r.out}' (종료 코드 ${r.rc})`)

    // 도구
    if (isExecutableFile(join(cache, 'skills/browser/browser-driver/browser_driver.ts'))) ok('도구: skills/browser/browser-driver/browser_driver.ts 가 있고 실행 권한이 있다')
    else fail('도구: skills/browser/browser-driver/browser_driver.ts 가 없거나 실행 권한이 없다')
    if (isExecutableFile(join(cache, 'tools/browser-driver/browser_driver.py'))) ok('도구: 옛 이름 진입 tools/browser-driver/browser_driver.py 가 있고 실행 권한이 있다')
    else fail('도구: 옛 이름 진입 tools/browser-driver/browser_driver.py 가 없거나 실행 권한이 없다')

    // 스크립트 실행
    r = run([process.execPath, join(cache, 'skills/plan/scripts/verify_task.ts'), '--help'], { env })
    if (r.rc === 0) ok('스크립트 실행: skills/plan/scripts/verify_task.ts --help 가 종료 코드 0 이다')
    else fail(`스크립트 실행: verify_task.ts --help 가 종료 코드 ${r.rc} 로 끝났다`, r.out)

    // 확장 기능의 상대 모듈과 스킬 참조도 설치 캐시에서 실행한다
    r = run([process.execPath, join(cache, 'extensions/work-board/bin/board.ts'), '--help'], { env })
    if (r.rc === 0) ok('보드 명령: 설치 캐시에서 --help 가 실행된다')
    else fail(`보드 명령: 종료 코드 ${r.rc}`, r.out)
    r = run([process.execPath, '--input-type=module', '-e', 'await import(process.argv[1])', join(cache, 'extensions/work-board/hooks/register.js')], { env })
    if (r.rc === 0) ok('보드 훅: 설치 캐시에서 모듈을 읽는다')
    else fail(`보드 훅: 종료 코드 ${r.rc}`, r.out)

    // 링크 없음
    const found = links(cache)
    if (found.length === 0) ok('링크 없음: 캐시에 심볼릭 링크가 없다')
    else fail('링크 없음: 캐시에 심볼릭 링크가 있다', found.join('\n'))
  }

  if (fails > 0) {
    process.stdout.write(`실패 ${fails} 건\n`)
    return 1
  }
  process.stdout.write('통과\n')
  return 0
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
const isMain = isMainModule(import.meta.url, import.meta.main)
if (isMain) process.exitCode = main(process.argv.slice(2))
