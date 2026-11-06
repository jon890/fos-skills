#!/usr/bin/env node
// 스킬과 도구가 가진 kit 복사본(<단위>/scripts/kit/<파일>.ts)을 원본(modules/kit/<파일>.ts)과 바이트까지 같게 맞춘다.
//
// 왜 복사본을 두나: 스킬의 .ts 는 자기 폴더와 Node 내장 모듈만 import 한다. 팀 저장소와 플러그인 설치 캐시에서
//   폴더 밖 경로가 깨지기 때문이다(docs/features/node-runtime/design.md 「공통 꼴 모듈 kit」). 원본은 modules/kit/ 한 곳이다.
//   원본의 위치는 scripts/runtime-policy.json 의 kit_sources 가 갖는다.
//
// 복사본의 자리: skills/<이름>/scripts/kit/, export-only-skills/<이름>/scripts/kit/, tools/<이름>/scripts/kit/ 아래의 .ts.
//   복사본은 필요한 파일만 가진다. 이름이 같은 원본이 없으면 오류다.
//
// 사용법 (cwd: 저장소 안 어디서나)
//   node scripts/sync-kit.ts                         모든 복사본을 원본으로 덮어쓴다. 바꾼 파일을 한 줄씩 낸다
//   node scripts/sync-kit.ts --check                 다른 복사본을 낸다. 있으면 1
//   node scripts/sync-kit.ts --add <단위 폴더> <파일>...   복사본이 없던 파일을 그 단위의 scripts/kit/ 에 만든다
//                                                    예: --add skills/implementation args.ts
//
// 출력 줄
//   다름 <복사본 경로>     --check 일 때 원본과 다른 복사본
//   갱신 <복사본 경로>     덮어쓴 복사본
//   추가 <복사본 경로>     --add 가 만든 복사본
//
// 종료 코드
//   0  모두 같다(또는 맞췄다)
//   1  --check 에서 다른 복사본이 있다
//   2  실행하지 못했다. 모르는 인자, 원본이 없다, 정책 파일을 읽지 못했다

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(import.meta.dirname, '..')
const UNIT_ROOTS = ['skills', 'export-only-skills', 'tools']

export type KitCopy = { copy: string; source: string }

// 정책 파일의 kit_sources(원본 폴더, 저장소 상대 경로)
export function kitSources(root: string): string[] {
  const policy = JSON.parse(readFileSync(join(root, 'scripts/runtime-policy.json'), 'utf8')) as { kit_sources?: unknown }
  if (!Array.isArray(policy.kit_sources) || policy.kit_sources.length === 0 || policy.kit_sources.some((s) => typeof s !== 'string')) {
    throw new Error('scripts/runtime-policy.json 의 kit_sources 가 문자열 배열이 아니다')
  }
  return policy.kit_sources as string[]
}

function sourceFolder(root: string, name: string): string | null {
  for (const folder of kitSources(root)) if (existsSync(join(root, folder, name))) return join(folder, name)
  return null
}

// 모든 복사본의 저장소 상대 경로와 그 원본. 원본이 없는 복사본은 던진다
export function kitCopies(root: string): KitCopy[] {
  const found: KitCopy[] = []
  for (const unitRoot of UNIT_ROOTS) {
    const base = join(root, unitRoot)
    if (!existsSync(base)) continue
    for (const unit of readdirSync(base).sort()) {
      const dir = join(base, unit, 'scripts', 'kit')
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.ts')) continue
        const copy = relative(root, join(dir, file))
        const source = sourceFolder(root, file)
        if (!source) throw new Error(`${copy} 의 원본이 kit_sources 에 없다`)
        found.push({ copy, source })
      }
    }
  }
  return found
}

export function differing(root: string): KitCopy[] {
  return kitCopies(root).filter(({ copy, source }) => !readFileSync(join(root, copy)).equals(readFileSync(join(root, source))))
}

export function syncKit(root: string): string[] {
  return differing(root).map(({ copy, source }) => {
    writeFileSync(join(root, copy), readFileSync(join(root, source)))
    return copy
  })
}

export function addCopies(root: string, unit: string, files: string[]): string[] {
  const added: string[] = []
  for (const file of files) {
    const source = sourceFolder(root, file)
    if (!source) throw new Error(`원본이 없다: ${file}`)
    const copy = join(unit, 'scripts', 'kit', file)
    mkdirSync(dirname(join(root, copy)), { recursive: true })
    writeFileSync(join(root, copy), readFileSync(join(root, source)))
    added.push(copy)
  }
  return added
}

export function main(argv: string[], root: string = REPO_ROOT): number {
  try {
    if (argv.length === 0) {
      for (const copy of syncKit(root)) process.stdout.write(`갱신 ${copy}\n`)
      return 0
    }
    if (argv.length === 1 && argv[0] === '--check') {
      const bad = differing(root)
      for (const { copy } of bad) process.stdout.write(`다름 ${copy}\n`)
      return bad.length ? 1 : 0
    }
    if (argv[0] === '--add' && argv.length >= 3) {
      for (const copy of addCopies(root, argv[1].replace(/\/+$/, ''), argv.slice(2))) process.stdout.write(`추가 ${copy}\n`)
      return 0
    }
    process.stderr.write('사용법: node scripts/sync-kit.ts [--check | --add <단위 폴더> <파일>...]\n')
    return 2
  } catch (error) {
    process.stderr.write(`sync-kit: ${(error as Error).message}\n`)
    return 2
  }
}

const isMain = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
