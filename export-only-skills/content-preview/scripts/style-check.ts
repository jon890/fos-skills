#!/usr/bin/env node
// 본문 파일을 korean-check 의 검사기로 검사한다.
//
// 판정 기준과 검사기는 korean-check 스킬이 소유한다. 여기서는 그것을 찾아 부른다.
// 절대경로를 박지 않는 이유는 저장소마다 스킬 배치가 달라서다.
// 이 저장소는 export-only-skills/ 아래, 설치본은 스킬 폴더 아래라 어느 쪽이든
// korean-check 가 형제 디렉터리에 온다.
//
// 사용법:
//   node style-check.ts <파일.md> [<파일.md>...]
//   node style-check.ts --text "<제목>"
//
// 종료 코드는 korean-check 의 check.sh 와 같다.
//   0  통과
//   1  위반 발견
//   2  검사기를 찾지 못했거나 돌지 못함
//
// --where 를 그대로 넘기면 찾은 korean-check 의 경로를 낸다.
// 검토 단계가 그 스킬의 references/ 를 열어야 하므로, 경로를 여기서 받아 간다.
//
// 찾는 순서는 KOREAN_CHECK 환경 변수, 이 스킬의 형제 디렉터리, 개인 스킬 디렉터리(~/.claude/skills/korean-check)다.
// korean-check 는 아직 셸 스크립트(scripts/check.sh)라 옛 꼴 그대로 실행 파일로 부른다.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import { isMain, write } from './io.ts'

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function main(argv: string[]): number {
  if (argv.length === 0) {
    write(2, '검사할 파일이나 --text 가 필요하다\n')
    return 2
  }

  // 스킬 디렉터리가 심링크라 논리 경로로는 저장소 밖으로 나가므로 실체 경로를 잡는다
  const skillDir = realpathSync(join(import.meta.dirname, '..'))
  const sibling = join(dirname(skillDir), 'korean-check')

  let check = ''
  let found = ''
  for (const cand of [`${process.env.KOREAN_CHECK ?? ''}/scripts/check.sh`, join(sibling, 'scripts/check.sh'), `${process.env.HOME ?? ''}/.claude/skills/korean-check/scripts/check.sh`]) {
    if (cand === '/scripts/check.sh') continue
    if (!isFile(cand)) continue
    found = cand
    // 실행 권한이 빠진 사본을 「찾지 못했다」로 보고하면 엉뚱한 곳을 고치게 된다
    if (isExecutable(cand)) {
      check = cand
      break
    }
  }

  if (!check && found) {
    write(2, `찾았으나 실행 권한이 없다: ${found}\nchmod +x 로 권한을 준다.\n`)
    return 2
  }

  // 조용히 통과시키지 않는다. 검사기가 돌지 않은 것이 통과로 보이는 상황이 가장 위험하다
  if (!check) {
    write(
      2,
      'korean-check 를 찾지 못해 표기 검사를 돌리지 못했다.\n' +
        '찾은 곳은 셋이다. KOREAN_CHECK, 이 스킬의 형제 디렉터리, 개인 스킬 디렉터리다.\n' +
        'korean-check 를 함께 받거나 KOREAN_CHECK 로 경로를 준다.\n',
    )
    return 2
  }

  const done = spawnSync(check, argv, { stdio: 'inherit' })
  if (done.error) {
    write(2, `${check}: ${done.error.message}\n`)
    return 126
  }
  if (done.signal) return 128 + (osConstants.signals[done.signal] ?? 0)
  return done.status ?? 1
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
