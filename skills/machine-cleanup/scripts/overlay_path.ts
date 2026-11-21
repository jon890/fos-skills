#!/usr/bin/env node
// 읽을 개인 오버레이 파일을 고른다. 읽기 전용이다.
//
// 사용법:
//   overlay_path.ts
//
// HOME 아래에서 아래 순서로 보고 처음 있는 파일의 절대경로를 한 줄 낸다.
//   1. ~/.claude/overlays/machine-cleanup.md   지금 자리
//   2. ~/.claude/overlays/mac-cleanup.md       옛 이름의 자리
//   3. ~/.claude/mac-cleanup-overlay.md        그보다 옛 자리
// 옛 자리에서 찾았으면 표준 오류에 새 자리로 옮기라는 한 줄을 낸다. 옛 자리는 계속 읽는다(스펙 REQ2, DECISION21).
//
// 종료 코드: 0 찾음, 1 없음(코어 기본값으로 진행), 2 사용법 오류.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { isMain, write } from './io.ts'

const USAGE = 'usage: overlay_path.ts [-h]\n'
const HELP = `${USAGE}
읽을 개인 오버레이 파일을 고른다. 새 자리, 옛 자리 순서로 보고 처음 있는 파일의 경로를 낸다.

options:
  -h, --help  show this help message and exit
`

export const CURRENT = '.claude/overlays/machine-cleanup.md'
export const LEGACY = ['.claude/overlays/mac-cleanup.md', '.claude/mac-cleanup-overlay.md']

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// 처음 있는 오버레이의 경로와 옛 자리 여부. 없으면 null
export function findOverlay(home: string): { path: string; legacy: boolean } | null {
  for (const [i, rel] of [CURRENT, ...LEGACY].entries()) {
    const path = join(home, rel)
    if (isFile(path)) return { path, legacy: i > 0 }
  }
  return null
}

export function main(argv: string[]): number {
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
    write(1, HELP)
    return 0
  }
  if (argv.length) {
    write(2, `${USAGE}overlay_path.ts: error: unrecognized arguments: ${argv.join(' ')}\n`)
    return 2
  }
  const home = process.env.HOME || homedir()
  const found = findOverlay(home)
  if (!found) return 1
  write(1, `${found.path}\n`)
  if (found.legacy) write(2, `옛 자리의 오버레이를 읽는다. ${join(home, CURRENT)} 로 옮기면 이 줄이 사라진다\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
