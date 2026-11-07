#!/usr/bin/env node
// 지침이 금지하는 대상을 다른 수단이 실제로 막는지 판정한다.
//
// 사용법:
//     check_enforcement.ts <repo> gitignore <경로>
//     check_enforcement.ts <repo> lint <probe 파일 경로> '<probe 내용>' '<검사 명령>'
//     check_enforcement.ts <repo> grep <probe 파일 경로> '<probe 내용>' '<검사 명령>'
//     check_enforcement.ts <repo> tools <agent 정의 파일>
//
// 종료 코드:
//     0  그 수단이 막는다. 같은 내용의 문장 지침은 지울 수 있다
//     1  막지 못한다. 문장 지침을 남긴다
//     2  사용법 오류
//
// 「이미 lint 가 잡으니 문장 지침은 지워도 된다」 는 판단은 자주 틀린다.
// 막는다고 믿은 수단에 구멍이 있으면, 유일한 지침을 지운 셈이 된다.
//
// `lint` 와 `grep` 은 절차가 같고 종료 코드를 읽는 방향만 반대다. 관례가 정반대이기 때문이다.
// 린터는 위반이 있으면 non-zero 로 끝나고, 문서의 검증 grep 은 위반을 찾으면 히트라서 0 으로 끝난다.
// 방향을 잘못 고르면 「이미 막힌다」 를 「안 막힌다」 로 뒤집어 읽는다.
//

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { capture, isMain, readTextReplace, write } from './io.ts'
import { pySplitLines, pyStrip } from './kit/py.ts'
import { isDir, isFile, NOT_WORD_AFTER, NOT_WORD_BEFORE, pathParent, pjoin, pyPath, pyre } from './pylike.ts'

const USAGE = `지침이 금지하는 대상을 다른 수단이 실제로 막는지 판정한다.

사용법:
    check_enforcement.ts <repo> gitignore <경로>
    check_enforcement.ts <repo> lint <probe 파일 경로> '<probe 내용>' '<검사 명령>'
    check_enforcement.ts <repo> grep <probe 파일 경로> '<probe 내용>' '<검사 명령>'
    check_enforcement.ts <repo> tools <agent 정의 파일>

종료 코드:
    0  그 수단이 막는다. 같은 내용의 문장 지침은 지울 수 있다
    1  막지 못한다. 문장 지침을 남긴다
    2  사용법 오류

「이미 lint 가 잡으니 문장 지침은 지워도 된다」 는 판단은 자주 틀린다.
막는다고 믿은 수단에 구멍이 있으면, 유일한 지침을 지운 셈이 된다.

\`lint\` 와 \`grep\` 은 절차가 같고 종료 코드를 읽는 방향만 반대다. 관례가 정반대이기 때문이다.
린터는 위반이 있으면 non-zero 로 끝나고, 문서의 검증 grep 은 위반을 찾으면 히트라서 0 으로 끝난다.
방향을 잘못 고르면 「이미 막힌다」 를 「안 막힌다」 로 뒤집어 읽는다.
`

// 파일을 고칠 수 있는 우회 경로. Write 와 Edit 만 막아도 이들 중 하나가 남으면 못 막는다
const BYPASS_TOOLS = ['Bash', 'Agent', 'Task', 'NotebookEdit']

const ALLOW_KEY = pyre(/^(tools|allowed-tools):(.*)$/iu)
const DENY_KEY = pyre(/^disallowedTools:(.*)$/iu)
const ANY_KEY = pyre(/^(tools|disallowedTools|allowed-tools):/iu)

function usage(code = 2): number {
  write(2, `${USAGE}\n`)
  return code
}

function git(repo: string, ...args: string[]) {
  const done = capture(['git', ...args], { cwd: repo })
  if (done.missing) throw new Error('git 을 찾을 수 없다')
  return done
}

function modeGitignore(repo: string, target: string): number {
  let out = `대상: ${target}\n`
  const done = git(repo, 'check-ignore', '-v', target)
  if (done.code === 0) {
    out += `막힌다 — ${pyStrip(done.stdout + done.stderr)}\n`
    out += '판정: gitignore 가 강제한다. 같은 내용의 문장 지침은 지울 수 있다.\n'
    write(1, out)
    return 0
  }
  out += '막히지 않는다 (git check-ignore 히트 없음)\n'
  out += '판정: gitignore 가 강제하지 않는다. 문장 지침을 남기거나 gitignore 를 고친다.\n'
  write(1, out)
  return 1
}

// probe 를 심고 검사 명령을 돌려, 그 검사가 probe 를 잡는지 본다
function modeProbe(repo: string, mode: string, probe: string, body: string, cmd: string): number {
  const path = pjoin(repo, probe)
  if (existsSync(path)) {
    write(2, `이미 있는 파일이다 — 다른 경로를 쓰라: ${probe}\n`)
    return 2
  }

  const signal = mode === 'grep' ? 'exit 0 히트' : 'non-zero'
  let out = `모드: ${mode} (검출 신호 = ${signal})\nprobe: ${probe}\n명령: ${cmd}\n---\n`

  // probe 는 검사가 실제로 훑는 위치에 놓아야 한다. 설정의 include 범위 밖이면 통과가 당연하다.
  mkdirSync(pathParent(path), { recursive: true })
  writeFileSync(path, `${body}\n`)
  let done
  try {
    done = capture(['/bin/sh', '-c', cmd], { cwd: repo })
  } finally {
    rmSync(path, { force: true })
  }

  const text = done.stdout + done.stderr
  const tail = pySplitLines(text).slice(-30)
  if (tail.length) out += `${tail.join('\n')}\n`
  out += '---\n'
  out += `exit code: ${done.code}\n`

  const detected = mode === 'grep' ? done.code === 0 : done.code !== 0
  if (detected) {
    out += '판정: 검사가 probe 를 잡는다. 같은 내용의 문장 지침은 지울 수 있다.\n'
    write(1, out)
    return 0
  }
  out += '판정: 검사가 통과시킨다. 규칙이 없거나 probe 위치가 검사 범위 밖이다.\n'
  out += '      모드를 반대로 고르지 않았는지 먼저 확인하고, 규칙 설정을 본다.\n'
  out += '      규칙이 없으면 문장 지침을 남긴다.\n'
  write(1, out)
  return 1
}

// 첫 `---` 쌍 사이의 줄
function frontmatter(text: string): string[] {
  const lines = pySplitLines(text)
  if (!lines.length || pyStrip(lines[0]) !== '---') return []
  for (let i = 1; i < lines.length; i++) {
    if (pyStrip(lines[i]) === '---') return lines.slice(1, i)
  }
  return []
}

const toolPattern = (tool: string) => new RegExp(`${NOT_WORD_BEFORE}${tool}${NOT_WORD_AFTER}`, 'u')

function modeTools(repo: string, agent: string): number {
  const path = pjoin(repo, agent)
  if (!isFile(path)) {
    write(2, `파일이 없다: ${agent}\n`)
    return 2
  }
  let out = `대상: ${agent}\n`

  const fm = frontmatter(readTextReplace(path))
  const declared = fm.filter((line) => ANY_KEY.test(line))
  out += declared.length ? `${declared.join('\n')}\n` : '  (도구 제한 선언 없음 — 전체 도구 사용 가능)\n'
  out += '---\n'

  // 허용 목록과 금지 목록을 모두 본다. 허용 목록만 보고 판정하면 반대 결론이 난다.
  let allow = ''
  let deny = ''
  for (const line of fm) {
    const a = ALLOW_KEY.exec(line)
    if (a) allow += a[2]
    const d = DENY_KEY.exec(line)
    if (d) deny += d[1]
  }

  const bypass: string[] = []
  for (const tool of BYPASS_TOOLS) {
    if (allow && !allow.includes('*') && !toolPattern(tool).test(allow)) continue // 허용 목록 밖이면 애초에 못 쓴다
    if (toolPattern(tool).test(deny)) continue
    bypass.push(tool)
    out += `  우회 가능: ${tool}\n`
  }

  out += '---\n'
  if (!bypass.length) {
    out += '판정: 파일을 고칠 도구가 남아 있지 않다. 도구 제한이 강제한다.\n'
    write(1, out)
    return 0
  }
  out += '판정: 위 도구로 우회할 수 있어 도구 제한이 파일 수정을 막지 못한다.\n'
  out += '      (예: Bash 의 리다이렉트로 Write 없이 파일을 덮어쓸 수 있다)\n'
  out += '      문장 지침을 지우지 않는다.\n'
  write(1, out)
  return 1
}

export function main(argv: string[]): number {
  if (argv.length < 2) return usage()
  const repo = pyPath(argv[0])
  const mode = argv[1]
  const rest = argv.slice(2)
  if (!isDir(repo)) {
    write(2, `대상 저장소가 없다: ${repo}\n`)
    return 2
  }

  if (mode === 'gitignore') return rest.length ? modeGitignore(repo, rest[0]) : usage()
  if (mode === 'lint' || mode === 'grep') return rest.length >= 3 ? modeProbe(repo, mode, rest[0], rest[1], rest[2]) : usage()
  if (mode === 'tools') return rest.length ? modeTools(repo, rest[0]) : usage()

  write(2, `알 수 없는 모드: ${mode}\n`)
  return usage()
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
