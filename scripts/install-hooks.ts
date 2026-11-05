#!/usr/bin/env node
// 이 저장소의 git 훅을 .git/hooks 에 건다.
//
// .git/hooks 는 커밋되지 않는다. 훅을 거기에만 두면 다시 clone 했을 때 조용히 사라진다.
// 실물은 githooks/ 에 두고 이 명령으로 연결한다. githooks/ 의 확장자 없는 파일(훅 진입)만 걸고,
// 진입이 부르는 본체(<훅>.ts)는 걸지 않는다.
//
// 워크트리에서 실행해도 맞게 걸리도록 git 에게 경로를 물어 받는다. 이 저장소는 worktrees/ 를 실제로 쓴다.
//   - 워크트리의 .git 은 디렉터리가 아니라 파일이라 <워크트리>/.git/hooks 는 만들 수 없다.
//   - .git/hooks 는 워크트리끼리 공유하므로, 링크 대상도 워크트리가 아닌 원본 체크아웃이어야 한다.
//     임시 워크트리를 가리키면 그것을 지우는 순간 훅이 끊긴다.
//
// 사용: node scripts/install-hooks.ts
// 출력: 건 훅마다 `  걸었다: <이름>`
// 종료 코드: 0 걸었다, 1 git 이 공용 폴더를 알려 주지 못했다, 2 원본 체크아웃에 githooks/ 가 없다

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDir, isFile } from './skill_paths.ts'

const HERE = join(import.meta.dirname, '..')

export function main(): number {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: HERE, encoding: 'utf8' })
  if (common.error || common.status !== 0) {
    process.stderr.write(`git 공용 폴더를 찾지 못했다: ${common.stderr ?? common.error}\n`)
    return 1
  }
  const commonDir = common.stdout.trim()
  const src = join(dirname(commonDir), 'githooks')
  const dst = join(commonDir, 'hooks')
  if (!isDir(src)) {
    process.stderr.write(`githooks/ 가 없다: ${src}\n`)
    return 2
  }
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src).sort()) {
    const hook = join(src, name)
    if (name.startsWith('.') || name.includes('.') || !isFile(hook)) continue
    rmSync(join(dst, name), { force: true })
    symlinkSync(hook, join(dst, name))
    process.stdout.write(`  걸었다: ${name}\n`)
  }
  return 0
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
const isMain = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main()
