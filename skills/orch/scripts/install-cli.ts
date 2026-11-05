// `orch doctor install-cli`. 이 번들의 플러그인 루트 실행기 `bin/orch` 를 `~/.local/bin/orch` 에 복사해, Claude 세션 밖의 셸(Codex, 사람)에서도
// `orch` 를 부르게 한다. Claude 세션의 Bash 는 플러그인 bin/ 이 PATH 에 들어가 이 설치가 필요 없다.
// 실행기는 설치 기록을 따라가므로 사본은 한 번만 깔면 된다. 실행기 자체가 바뀌면 doctor 가 CLI-STALE 로 다시 깔라고 알린다.
//
// 사용법:
//     install-cli.ts [--target FILE]
//     --target  복사할 곳. 기본 ~/.local/bin/orch. 폴더가 없으면 만든다
//
// 출력(stdout 한 줄):
//     CLI-INSTALLED <경로>   새로 깔았다
//     CLI-UPDATED <경로>     표지(fos-skills orch launcher)가 있는 기존 사본을 덮어 갱신했다
//     CLI-CURRENT <경로>     이미 같은 내용이다
//     CLI-CONFLICT <경로>    표지가 없는 다른 orch 가 있어 덮지 않았다. 종료 코드 1
// 셸 PATH 에 그 폴더가 없으면 stderr 에 PATH 에 더하라고 한 줄 남긴다.
//
// 종료 코드: 0 깔았거나 이미 같다, 1 CLI-CONFLICT 나 쓰기 실패, 2 사용법 오류

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { LAUNCHER_MARK as MARK } from './lib/commands.ts'

const USAGE = '사용법: install-cli.ts [--target FILE]'
const LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'orch')

function main(argv: string[]): number {
  let values
  try {
    const options = { target: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
  } catch (e) {
    process.stderr.write(`${USAGE}\ninstall-cli: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!existsSync(LAUNCHER)) {
    process.stderr.write(`install-cli: 이 번들에 실행기가 없다: ${LAUNCHER}\n`)
    return 1
  }
  const target = resolve(values.target ?? join(homedir(), '.local', 'bin', 'orch'))
  const source = readFileSync(LAUNCHER, 'utf8')
  let verdict = 'CLI-INSTALLED'
  let link = false
  try {
    link = lstatSync(target).isSymbolicLink()
  } catch {
    // 없으면 새로 깐다
  }
  // 대상이 없는 링크도 existsSync 는 false 라 lstat 으로 먼저 본다
  if (link) {
    // 링크를 따라가 덮으면 그 대상(다른 체크아웃의 파일일 수 있다)을 고친다
    process.stdout.write(`CLI-CONFLICT ${target}\n`)
    process.stderr.write(`install-cli: ${target} 는 심볼릭 링크다. 덮지 않는다. 링크를 지운 뒤 다시 부른다\n`)
    return 1
  }
  if (existsSync(target)) {
    let current = ''
    try {
      current = readFileSync(target, 'utf8')
    } catch {
      // 읽지 못하는 파일은 실행기가 아니다
    }
    if (!current.slice(0, 400).includes(MARK)) {
      process.stdout.write(`CLI-CONFLICT ${target}\n`)
      process.stderr.write(`install-cli: ${target} 는 다른 orch 다. 덮지 않는다. 지우거나 --target 으로 다른 곳을 준다\n`)
      return 1
    }
    if (current === source) {
      process.stdout.write(`CLI-CURRENT ${target}\n`)
      return 0
    }
    verdict = 'CLI-UPDATED'
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(LAUNCHER, target)
    chmodSync(target, 0o755)
  } catch (e) {
    process.stderr.write(`install-cli: ${target} 에 쓰지 못했다: ${(e as Error).message}\n`)
    return 1
  }
  process.stdout.write(`${verdict} ${target}\n`)
  if (!(process.env.PATH ?? '').split(delimiter).includes(dirname(target))) {
    process.stderr.write(`install-cli: ${dirname(target)} 가 PATH 에 없다. 셸 설정에 export PATH="${dirname(target)}:$PATH" 를 더한다\n`)
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
