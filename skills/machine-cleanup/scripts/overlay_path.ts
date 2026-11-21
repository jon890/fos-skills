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
// 다음 자리로 넘어가는 것은 그 자리에 아무것도 없을 때(ENOENT, ENOTDIR)뿐이다.
// 무언가 있는데 읽을 수 있는 파일이 아니면(깨진 링크 고리 ELOOP, 권한 EACCES, 폴더 등) 거기서 멈추고 종료 코드 3 과 그 경로, 원인을 표준 오류에 낸다.
// 그 자리를 건너뛰고 옛 자리나 기본값으로 가면, 새 오버레이가 빼라고 한 항목이 승인 묶음에 들어갈 수 있다.
//
// 종료 코드: 0 찾음, 1 없음(코어 기본값으로 진행), 2 사용법 오류, 3 오버레이 자리를 확인하지 못함(정리 후보를 만들기 전에 멈춘다).

import { homedir } from 'node:os'
import { join } from 'node:path'
import { accessSync, constants, statSync } from 'node:fs'
import { isMain, write } from './io.ts'

const USAGE = 'usage: overlay_path.ts [-h]\n'
const HELP = `${USAGE}
읽을 개인 오버레이 파일을 고른다. 새 자리, 옛 자리 순서로 보고 처음 있는 파일의 경로를 낸다.

options:
  -h, --help  show this help message and exit
`

export const CURRENT = '.claude/overlays/machine-cleanup.md'
export const LEGACY = ['.claude/overlays/mac-cleanup.md', '.claude/mac-cleanup-overlay.md']

export type Found = { path: string; legacy: boolean } | { path: string; error: string }

// 그 자리의 상태. 'absent' 는 아무것도 없다는 뜻이고, 그 밖의 문자열은 확인하지 못한 원인이다
function probe(path: string): 'file' | 'absent' | string {
  try {
    if (!statSync(path).isFile()) return '파일이 아니다'
    accessSync(path, constants.R_OK)
    return 'file'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    return code ?? String(error)
  }
}

// 처음 있는 오버레이의 경로와 옛 자리 여부, 또는 확인하지 못한 자리와 원인. 아무 자리에도 없으면 null
export function findOverlay(home: string): Found | null {
  for (const [i, rel] of [CURRENT, ...LEGACY].entries()) {
    const path = join(home, rel)
    const state = probe(path)
    if (state === 'file') return { path, legacy: i > 0 }
    if (state !== 'absent') return { path, error: state }
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
  if ('error' in found) {
    write(2, `오버레이 자리를 확인하지 못했다: ${found.path} (${found.error}). 고친 뒤 다시 돌린다\n`)
    return 3
  }
  write(1, `${found.path}\n`)
  if (found.legacy) write(2, `옛 자리의 오버레이를 읽는다. ${join(home, CURRENT)} 로 옮기면 이 줄이 사라진다\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
