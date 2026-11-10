// 머지 큐의 출력과 명령 실행 도우미.

import { statSync } from 'node:fs'
import type { FireResult } from '../../lib/events.ts'
import type { Rule } from '../../lib/output.ts'
import { emit } from '../../lib/output.ts'
import type { RunResult } from '../../lib/proc.ts'
import { NO_LIMIT_MS, run, stopping } from '../../lib/proc.ts'
import { pyJson } from '../../lib/py.ts'
import type { StepContext } from './model.ts'
import { Stop } from './model.ts'

// 짧은 출력(진입점의 orch queue run, merge-with-finish 가 이어 준 신호)의 줄 규칙. 시각 붙은 진행 줄은 머지 결과만 남긴다.
// 상주 루프는 이 스크립트를 경로로 불러 로그 끝 줄을 읽으므로 지금 출력 그대로다(lib/output.ts 머리 주석)
const SHORT_RULES: Rule[] = [
  [/^\d\d:\d\d (\d+) (?:이미 )?MERGED$/, (m) => `MERGED ${m[1]}`],
  [/^\d\d:\d\d /, () => null],
  [/^경고: (.*)/, (m) => `WARN ${m[1]}`],
]

export function now(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export function out(line: string): void {
  emit(line, SHORT_RULES)
}
export function log(message: string): void {
  out(`${now()} ${message}`)
}
// Python 의 rstrip("\n") 과 같다. 끝의 줄바꿈만 지운다
export function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}
export function nap(stepContext: StepContext, seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * stepContext.sleepScale * 1000))
}
export function stop(message: string): never {
  throw new Stop(message)
}
// 이름 목록을 jq 배열 리터럴로 바꾼다
export function namesJson(names: readonly string[]): string {
  return pyJson(names)
}
// `--required A,B` 처럼 쉼표로 이은 값을 이름으로 나눈다. 쉼표가 든 이름 하나는 나누지 않는 `--required-check` 로 받는다
export function splitNames(value: string): string[] {
  return value.split(',').filter((x) => x)
}
export function isDigits(text: string): boolean {
  return /^[0-9]+$/.test(text)
}
export function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}
export function git(...args: string[]): RunResult {
  return run(['git', ...args], { timeoutMs: NO_LIMIT_MS })
}
// 결과 줄과 STOP 이유에 쓰는 실패 표시. 종료 코드가 없으면 시간 초과나 잠금 실패다
export function failLabel(r: FireResult): string {
  if (r.code !== null) return String(r.code)
  return r.result === 'timeout' ? 'timeout' : 'lock'
}
export function failed(r: FireResult): boolean {
  return r.result === 'fail' || r.result === 'timeout'
}
// 신호를 받아 끝내는 중이면 쓰는 호출을 하지 않고 그 PR 을 멈춘다. 처리기가 자식을 끊는 유예 동안에도 큐는 이어 돌아,
// TERM 을 받고 0 으로 끝난 핸들러 뒤에 머지가 나갈 수 있기 때문이다
export function refuseWhenStopping(n: string): void {
  const signal = stopping()
  if (signal) stop(`${n} ${signal} 를 받아 끝내는 중이라 멈춘다`)
}
