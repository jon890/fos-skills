#!/usr/bin/env node
// static_check.ts 를 하위 프로세스로 돌리고 종료 코드와 판정을 표로 낸다.
//
// 파이프 뒤 `echo $?` 로 돌리면 종료 코드가 뒤 명령의 것이 되어 통과로 잘못 읽는다.
// 종료 코드의 뜻은 static_check.ts 의 머리 주석이 소유한다. 여기서는 그 뜻을 판정 낱말로만 옮긴다.
//
// 사용법 (검사 대상 저장소 루트에서 실행한다):
//   node "$SKILL_DIR/scripts/run_static_check.ts" [ADR_DIR] [DOC_SCOPE]
//
// 인자는 static_check.ts 에 그대로 넘긴다.
//
// 출력은 표가 먼저고, 이어 표준 출력과 표준 오류를 그대로 붙인다.
// 판정 낱말은 다음과 같다.
//     통과        종료 코드 0 이고 WARN 줄이 없다
//     통과 (경고 N줄)  종료 코드 0 이고 WARN 줄이 N 줄이다. 리포트의 Warning 후보로 올린다
//     발견        종료 코드 1. 걸린 줄을 모두 발견으로 올리거나 유지 유형으로 분류해야 한다
//     실행 실패   종료 코드 2 이거나 알 수 없는 코드. 통과가 아니다
//
// 종료 코드
//     0  통과
//     1  발견이 있다
//     2  실행 실패

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { isMain, rstrip, splitLines, strip, write } from './text.ts'

const STATIC_CHECK = join(import.meta.dirname, 'static_check.ts')

export function verdict(code: number, out: string): string {
  if (code === 1) return '발견'
  if (code !== 0) return '실행 실패'
  const warns = splitLines(out).filter((line) => line.includes(': WARN ')).length
  return warns ? `통과 (경고 ${warns}줄)` : '통과'
}

export function main(argv: string[]): number {
  const done = spawnSync(process.execPath, [STATIC_CHECK, ...argv], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['inherit', 'pipe', 'pipe'] })
  const code = done.status ?? -1
  const stdout = done.stdout ?? ''
  const stderr = done.stderr ?? ''
  let out = '| 검사 | 종료 코드 | 판정 | 출력 줄 수 |\n| --- | --- | --- | --- |\n'
  out += `| static_check | ${code} | ${verdict(code, stdout)} | ${splitLines(stdout).length} |\n\n`
  out += `${rstrip(stdout) || '(표준 출력 없음)'}\n`
  if (strip(stderr)) out += `\n표준 오류:\n${rstrip(stderr)}\n`
  write(1, out)
  return code === 0 || code === 1 ? code : 2
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
