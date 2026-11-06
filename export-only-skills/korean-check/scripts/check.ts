#!/usr/bin/env node
// 한국어 산출물을 두 검사기로 한 번에 검사한다.
//
// 검사기를 따로 부르면 앞의 것이 실패해도 뒤의 것이 그대로 돌아,
// 호출한 쪽이 종료 코드를 하나만 읽고 통과로 판단한다. 여기서 둘을 합쳐 낸다.
//
// 사용법:
//   node check.ts <파일.md> [<파일.md>...]
//   node check.ts --text "<제목이나 커밋 메시지>"
//   node check.ts --diff [<기준>] [-- <파일.md>...]
//                                          git diff 로 더한 줄의 발견만 판정한다.
//                                          기준 기본값은 HEAD. 인자와 출력은 check-diff.ts 가 소유한다
//   node check.ts --where                  이 스킬 디렉터리 경로를 낸다
//
// 종료 코드:
//   0  통과. 경고만 있어도 0 이다
//   1  매핑 표의 금지어 발견. 실패로 막는 것은 이것뿐이다
//   2  검사기가 돌지 못함. 대상이 없거나 확장자가 .md 가 아니거나,
//      검사기나 매핑 표를 찾지 못한 경우다
//
// 종료 코드는 둘 중 큰 값을 낸다. 뒤에 돈 검사기의 값으로 덮으면
// "검사기가 돌지 못함" 이 "위반 발견" 으로 내려가고, 호출한 쪽은 보고된 위반만 고치고 넘어간다.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { isMain, write } from './io.ts'

const HERE = realpathSync(import.meta.dirname)
const STYLE = join(HERE, 'korean-style-check.ts')
const READABILITY = join(HERE, 'check-readability.ts')
const DIFF = join(HERE, 'check-diff.ts')

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// 자식 명령을 돌려 종료 코드를 낸다. 신호로 끝나면 셸처럼 128 + 신호 번호다
function runScript(script: string, args: string[], stdio: 'inherit' | ['inherit', 'pipe', 'inherit'] = 'inherit') {
  const done = spawnSync(process.execPath, [script, ...args], { stdio, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const code = done.signal ? 128 + (constants.signals[done.signal] ?? 0) : (done.status ?? 1)
  return { code, stdout: typeof done.stdout === 'string' ? done.stdout : '' }
}

// 명령 본체. stdout 과 stderr 에 직접 쓰고 종료 코드를 돌려준다. argv 는 명령 이름 뒤의 인자다.
export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--where') {
    write(1, `${dirname(HERE)}\n`)
    return 0
  }

  // --diff 는 파일 전체를 검사한 뒤 발견을 이번 변경과 기존 줄로 나눈다. 종료 코드는 이번 변경 몫만 본다.
  if (argv[0] === '--diff') {
    const rest = argv.slice(1)
    let base = 'HEAD'
    if (rest.length > 0 && rest[0] !== '--') base = rest.shift() as string
    if (rest[0] === '--') rest.shift()
    return runScript(DIFF, ['--base', base, ...rest]).code
  }

  if (argv.length === 0) {
    write(2, '검사할 파일이나 --text 나 --diff 가 필요하다\n')
    return 2
  }

  for (const f of [STYLE, READABILITY]) {
    if (!isFile(f)) {
      write(2, `검사기가 없다: ${f}\n`)
      return 2
    }
  }

  let status = 0
  // 둘 중 큰 값을 남긴다. 2 는 1 을 덮고, 1 은 0 을 덮는다.
  const worst = (code: number) => {
    if (code > status) status = code
  }

  // --text 는 파일이 아니라 문자열을 검사한다. 제목과 커밋 메시지가 이 경로로 들어온다.
  // 금지어 검사기는 파일만 받으므로 문자열을 임시 .md 로 만들어 함께 검사한다.
  if (argv[0] === '--text') {
    const words = argv.slice(1)
    if (words.length === 0) {
      write(2, '--text 뒤에 검사할 문자열이 필요하다\n')
      return 2
    }

    // 금지어 검사기는 확장자가 .md 인 파일만 보므로 디렉터리를 만들어 그 안에 둔다.
    let tmpdir: string
    try {
      tmpdir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'korean-check.'))
    } catch {
      write(2, '임시 디렉터리를 만들지 못했다\n')
      return 2
    }
    try {
      const tmp = join(tmpdir, 'text.md')
      try {
        writeFileSync(tmp, `${words.join(' ')}\n`)
      } catch {
        write(2, `임시 파일에 쓰지 못했다: ${tmp}\n`)
        return 2
      }

      // 임시 경로를 그대로 보이면 사용자가 열 수 없는 경로가 출력에 남는다.
      const style = runScript(STYLE, [tmp], ['inherit', 'pipe', 'inherit'])
      write(1, style.stdout.split('\n').map((row) => (row.startsWith(tmp) ? `(문자열)${row.slice(tmp.length)}` : row)).join('\n'))
      worst(style.code)
      worst(runScript(READABILITY, ['--text', words.join(' ')]).code)
    } finally {
      rmSync(tmpdir, { recursive: true, force: true })
    }

    if (status === 0) write(1, '표기 검사 통과: 문자열. 의미 점검은 별도\n')
    return status
  }

  // 대상이 없거나 확장자가 다르면 검사기 한쪽만 돌아 절반만 검사된다.
  // 실측으로, 없는 경로 둘을 주면 "통과: 2개 파일" 을 내며 0 으로 끝났고,
  // .txt 를 주면 금지어 검사기가 건너뛰어 같은 내용이 통과로 나왔다.
  for (const f of argv) {
    if (f.startsWith('-')) {
      write(2, `다루지 않는 옵션이다: ${f}\n`)
      return 2
    }
    if (!isFile(f)) {
      write(2, `대상이 없다: ${f}\n`)
      return 2
    }
    if (!f.endsWith('.md')) {
      write(2, `확장자가 .md 가 아니라 절반만 검사된다: ${f}\n`)
      return 2
    }
  }

  worst(runScript(STYLE, argv).code)
  worst(runScript(READABILITY, argv).code)

  if (status === 0) write(1, `표기 검사 통과: ${argv.length}개 파일. 의미 점검은 별도\n`)
  return status
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = await main(process.argv.slice(2))
