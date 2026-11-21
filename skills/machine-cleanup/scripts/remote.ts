#!/usr/bin/env node
// 이 맥의 스킬 번들 스크립트를 홈서버로 보내 돌린다. 홈서버 checkout 을 갱신하지 않아도 이 맥의 스크립트로 돈다(스펙 REQ5).
//
// 사용법:
//   remote.ts --host HOST [--lock PATH] [--input FILE]... [--json-out FILE] SCRIPT [ARG...]
//
// SCRIPT 는 이 폴더의 스크립트 이름(예: hs_survey.ts)이다. 그 파일에서 상대 import 를 따라간 파일 전부와 --input 파일을
// ustar tar 로 묶어 ssh 표준 입력으로 보낸다. 홈서버는 `mktemp -d` 폴더에 풀어 `node scripts/SCRIPT ARG...` 로 돌리고,
// 끝나면 trap 으로 그 폴더를 지운다. 홈서버에 남는 파일이 없고 npm 패키지도 필요 없다.
// ARG 가운데 --input 으로 준 파일 경로와 똑같은 것은 홈서버 임시 폴더 안 사본 경로로 바뀐다.
// --lock 이 있으면 실행 전체를 `flock -E 75 -w 300 PATH env FOS_INFRA_LOCK_HELD=1 node ...` 로 감싼다.
// 지우기 직전의 사용 확인과 실제 삭제가 같은 잠금 안에서 일어나 배포와 엇갈리지 않는다. PATH 의 `~/` 는 홈서버 홈이다.
// --json-out 이 있으면 스크립트의 표준 출력을 이 맥의 그 파일에 쓰고 화면에는 내지 않는다. 표준 오류는 그대로 보인다.
//
// 종료 코드: 스크립트의 종료 코드를 그대로 돌려준다. 다만
//   255  ssh 접속 실패. 스크립트는 돌지 않았다
//   75   운영 작업 잠금을 300초 안에 얻지 못했다. 스크립트는 돌지 않았다(홈서버 스크립트는 75 를 쓰지 않는다)
//   70   홈서버 임시 폴더를 만들거나 풀지 못했다
//   2    사용법 오류

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isMain, write } from './io.ts'

export const LOCK_WAIT_SEC = 300
export const LOCK_FAILED = 75
export const SSH_FAILED = 255
export const SETUP_FAILED = 70

const SKILL_DIR = resolve(import.meta.dirname, '..')
const USAGE = 'usage: remote.ts --host HOST [--lock PATH] [--input FILE]... [--json-out FILE] SCRIPT [ARG...]\n'

const IMPORT_RE = /^\s*(?:import|export)\b[^'"]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm

// 스크립트에서 상대 import 를 따라간 파일 전부(스킬 폴더 기준 상대 경로)
export function importClosure(entry: string, root = SKILL_DIR): string[] {
  const seen = new Set<string>()
  const stack = [resolve(entry)]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT_RE)) stack.push(resolve(dirname(file), m[1]))
  }
  return [...seen].map((f) => {
    const rel = relative(root, f)
    if (rel.startsWith('..')) throw new Error(`스킬 폴더 밖의 import 는 보낼 수 없다: ${f}`)
    return rel
  }).sort()
}

// 셸 작은따옴표 인용
export const shq = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

// `~/` 로 시작하면 홈서버의 $HOME 아래로 푼다
export const shPath = (path: string): string => (path.startsWith('~/') ? `"$HOME"/${shq(path.slice(2))}` : shq(path))

// 홈서버에서 돌 셸 본문
export function remoteScript(script: string, args: string[], lock?: string): string {
  const run = ['node', shq(`scripts/${script}`), ...args.map(shq)].join(' ')
  const wrapped = lock ? `flock -E ${LOCK_FAILED} -w ${LOCK_WAIT_SEC} ${shPath(lock)} env FOS_INFRA_LOCK_HELD=1 ${run}` : run
  return [
    `d=$(mktemp -d) || exit ${SETUP_FAILED}`,
    `trap 'rm -rf "$d"' EXIT`,
    `tar -xf - -C "$d" || exit ${SETUP_FAILED}`,
    `cd "$d" || exit ${SETUP_FAILED}`,
    wrapped,
  ].join('\n')
}

type Values = { host?: string; lock?: string; input?: string[]; 'json-out'?: string; help?: boolean }

// SCRIPT 앞의 옵션만 읽는다. SCRIPT 뒤는 모두 스크립트의 인자다. 틀리면 오류 문장을 돌려준다
export function splitArgs(argv: string[]): { values: Values; positionals: string[] } | string {
  const values: Values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-h' || a === '--help') values.help = true
    else if (a === '--host' || a === '--lock' || a === '--input' || a === '--json-out') {
      const v = argv[i + 1]
      if (v === undefined) return `${a} 에 값이 없다`
      i += 1
      if (a === '--input') values.input = [...(values.input ?? []), v]
      else values[a.slice(2) as 'host' | 'lock' | 'json-out'] = v
    } else if (a.startsWith('-')) return `모르는 옵션: ${a}`
    else return { values, positionals: argv.slice(i) }
  }
  return { values, positionals: [] }
}

export function main(argv: string[]): number {
  const parsed = splitArgs(argv)
  if (typeof parsed === 'string') {
    write(2, `${USAGE}${parsed}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    write(1, USAGE)
    return 0
  }
  if (!values.host || positionals.length === 0) {
    write(2, `${USAGE}--host 와 SCRIPT 가 필요하다\n`)
    return 2
  }
  const [script, ...rest] = positionals
  if (script.includes('/') || !script.endsWith('.ts')) {
    write(2, `${USAGE}SCRIPT 는 scripts 폴더의 .ts 파일 이름이다: ${script}\n`)
    return 2
  }
  const entry = join(SKILL_DIR, 'scripts', script)
  let files: string[]
  try {
    files = importClosure(entry)
  } catch (error) {
    write(2, `보낼 파일을 모으지 못했다: ${(error as Error).message}\n`)
    return 2
  }

  const stage = mkdtempSync(join(tmpdir(), 'mc-remote-'))
  try {
    for (const rel of files) {
      mkdirSync(dirname(join(stage, rel)), { recursive: true })
      copyFileSync(join(SKILL_DIR, rel), join(stage, rel))
    }
    // 저장소 루트의 package.json 이 없는 곳에서도 ES module 로 읽게 한다
    writeFileSync(join(stage, 'package.json'), '{ "type": "module" }\n')
    const inputs = values.input ?? []
    const mapped = new Map<string, string>()
    for (const [i, local] of inputs.entries()) {
      const rel = `input/${i}-${basename(local)}`
      mkdirSync(join(stage, 'input'), { recursive: true })
      try {
        copyFileSync(local, join(stage, rel))
      } catch (error) {
        write(2, `입력 파일을 읽지 못했다: ${local} (${(error as NodeJS.ErrnoException).code ?? error})\n`)
        return 2
      }
      mapped.set(local, rel)
    }
    const args = rest.map((a) => mapped.get(a) ?? a)
    // ustar 는 확장 머리(xattr 등)를 담지 않아 GNU tar 가 경고하지 않는다. COPYFILE_DISABLE 는 macOS 의 ._ 파일을 막는다
    const tar = spawnSync('tar', ['--format', 'ustar', '-cf', '-', '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 256 * 1024 * 1024 })
    if (tar.status !== 0) {
      write(2, `tar 로 묶지 못했다: ${tar.stderr?.toString() ?? tar.error}\n`)
      return 2
    }
    const body = remoteScript(script, args, values.lock)
    const ssh = spawnSync('ssh', ['-o', 'BatchMode=yes', '-T', values.host, `sh -c ${shq(body)}`], {
      input: tar.stdout,
      stdio: ['pipe', values['json-out'] ? 'pipe' : 'inherit', 'inherit'],
      maxBuffer: 512 * 1024 * 1024,
    })
    // ssh 가 표준 입력을 읽기 전에 끝나면(접속 실패) EPIPE 가 함께 온다. 종료 코드가 있으면 그것으로 판단한다
    if (ssh.error && ssh.status === null) {
      write(2, `ssh 를 돌리지 못했다: ${ssh.error.message}\n`)
      return SSH_FAILED
    }
    const code = ssh.status ?? 1
    if (code === SSH_FAILED) {
      write(2, `홈서버에 접속하지 못함(ssh ${values.host}, 종료 코드 255). 스크립트는 돌지 않았다\n`)
      return code
    }
    if (values.lock && code === LOCK_FAILED) {
      write(2, `운영 작업 잠금을 ${LOCK_WAIT_SEC}초 안에 얻지 못함(${values.lock}). 스크립트는 돌지 않았고 아무것도 지우지 않았다\n`)
      return code
    }
    if (code === SETUP_FAILED) write(2, '홈서버 임시 폴더를 만들거나 풀지 못했다\n')
    if (values['json-out']) writeFileSync(values['json-out'], ssh.stdout ?? '')
    return code
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
