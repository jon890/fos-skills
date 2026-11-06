#!/usr/bin/env node
// 레포 설정의 「문서 검사 명령」 을 spec·technical-design 단계 관문에서 돌린다.
//
// 저장소 문서 검사(ADR 링크 규칙 같은 것)가 구현 phase 커밋에서야 걸리지 않게, 스펙과 설계를 쓴 단계에서 함께 돌린다.
// 값의 이름과 형식은 references/monorepo.md 의 「스크립트가 직접 읽는 값」 이 소유한다.
//
// 사용법:
//     node scripts/run_doc_checks.ts --skill spec docs/features/run-cancel/spec.md
//     node scripts/run_doc_checks.ts --skill technical-design SPEC DESIGN
//
// cwd 는 대상 저장소 안이어야 한다. 경로는 저장소 루트 기준이며, 어느 하위 프로젝트의 오버레이를 읽을지 정하는 데만 쓴다.
// `--skill` 의 오버레이를 먼저 찾고, 없으면 spec 오버레이에서 찾는다. 값 칸의 인라인 코드 하나가 명령 하나다.
// 명령은 저장소 루트에서 bash 로 실행하고 출력은 그대로 보인다.
//
// 종료 코드
//     0  모든 명령이 통과했다. 오버레이에 명령이 없어도 0 이다
//     1  실패한 명령이 있다
//     2  실행하지 못했다. 저장소 밖이다

import { spawnSync } from 'node:child_process'
import { isMain, returncode, ValueError, write } from './io.ts'
import { type Spec, parseCli, UsageError } from './cli.ts'
import { codes, lookup, targets } from './overlay_values.ts'
import { repoRoot } from './overlay_paths.ts'

const NAME = '문서 검사 명령'

const USAGE = `usage: run_doc_checks.ts [-h] --skill {spec,technical-design} [paths ...]

레포 설정의 「문서 검사 명령」 을 spec·technical-design 단계 관문에서 돌린다.

positional arguments:
  paths        이번 단계가 쓴 문서 경로. 저장소 루트 기준

options:
  -h, --help   show this help message and exit
  --skill {spec,technical-design}
               부르는 단계의 스킬 이름
`

const SPEC: Spec = {
  options: [{ name: 'skill', value: true, required: true, choices: ['spec', 'technical-design'] }],
  positionals: [{ name: 'paths', nargs: '*' }],
}

// [명령, 찾은 파일] 목록이다. 같은 명령은 한 번만 낸다
export function commands(root: string, skill: string, paths: string[]): [string, string][] {
  const skills = skill === 'spec' ? [skill] : [skill, 'spec']
  const found: [string, string][] = []
  const seen = new Set<string>()
  for (const sub of targets(root, paths)) {
    const [value, source] = lookup(root, skills, NAME, sub)
    if (value === null) continue
    for (const command of codes(value)) {
      if (!seen.has(command)) {
        seen.add(command)
        found.push([command, source!])
      }
    }
  }
  return found
}

export function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseCli(argv, SPEC)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    write(2, `${USAGE.split('\n')[0]}\nrun_doc_checks.ts: error: ${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    write(1, USAGE)
    return 0
  }
  let root: string
  try {
    root = repoRoot(process.cwd())
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `실행하지 못했다: ${error.message}\n`)
    return 2
  }
  const found = commands(root, parsed.options.skill as string, parsed.positionals.paths as string[])
  if (found.length === 0) {
    write(1, `「${NAME}」 이 레포 설정에 없다. 저장소 문서 검사를 건너뛴다\n`)
    return 0
  }
  let failed = 0
  for (const [command, source] of found) {
    write(1, `실행: ${command} (출처: ${source})\n`)
    const code = returncode(spawnSync('bash', ['-c', command], { cwd: root, stdio: 'inherit' }))
    write(1, `${code === 0 ? '통과' : `실패(종료 코드 ${code})`}: ${command}\n`)
    if (code !== 0) failed++
  }
  write(1, `문서 검사 ${found.length}개 중 실패 ${failed}개\n`)
  return failed ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
