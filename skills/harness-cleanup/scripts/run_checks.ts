#!/usr/bin/env node
// harness-cleanup 2단계의 정적 검사를 모두 따로 돌리고 스크립트별 종료 코드와 판정을 표로 낸다.
//
// 파이프 뒤 `echo $?` 로 돌리면 종료 코드가 뒤 명령의 것이 되어 통과로 잘못 읽는다.
// 이 스크립트는 각 검사를 하위 프로세스로 따로 돌려 종료 코드를 그대로 읽는다.
// 종료 코드의 뜻은 각 검사 스크립트의 머리 주석이 소유한다. 여기서는 그 뜻을 판정 낱말로만 옮긴다.
//
// 사용법:
//     run_checks.ts ROOT [--scope PATH] [--base COMMIT] [--min-run N]
//
// ROOT 는 감사 대상 저장소 루트다.
// collect_targets, check_references, check_facts, check_duplication, check_rename_drift 를 돌린다.
// --min-run 은 check_duplication 의 최소 연속 줄 수(기본 5)다.
// --base 가 없으면 check_rename_drift 는 HEAD 와 작업 트리를 비교한다.
// docs-audit 2단계는 그 스킬의 `scripts/run_static_check.ts` 가 같은 방식으로 맡는다. 두 스킬의 배포 경로가 달라 스크립트를 나눴다.
//
// 출력은 표가 먼저고, 이어 검사마다 표준 출력과 표준 오류를 그대로 붙인다.
// 판정 낱말은 다음과 같다.
//     통과        종료 코드 0 이고 출력으로 따로 구분할 것이 없다
//     출력 판정   종료 코드가 판정을 말하지 않는다. 출력을 읽고 판정한다 (check_facts)
//     발견        종료 코드 1. 출력의 걸린 자리를 모두 처리해야 한다
//     해당 없음   검사가 볼 대상이 없어 돌지 않았다 (check_rename_drift 의 2)
//     실행 실패   종료 코드 2 이거나 알 수 없는 코드. 통과가 아니다. 대상 파일이 0 인 경우도 여기다
//
// 종료 코드
//     0  실행 실패와 발견이 하나도 없다
//     1  발견이 있다
//     2  실행 실패가 있다. 인자 오류도 여기다
//

import { capture, isMain, write } from './io.ts'
import { PY_SPACE, pySplitLines, pyStrip } from './kit/py.ts'
import { parsePyInt, pjoin, pyPath } from './pylike.ts'
import { type Spec, parseCli, UsageError } from './cli.ts'

const HERE = import.meta.dirname

const DESCRIPTION = `harness-cleanup 2단계의 정적 검사를 모두 따로 돌리고 스크립트별 종료 코드와 판정을 표로 낸다.

파이프 뒤 \`echo $?\` 로 돌리면 종료 코드가 뒤 명령의 것이 되어 통과로 잘못 읽는다.
이 스크립트는 각 검사를 하위 프로세스로 따로 돌려 종료 코드를 그대로 읽는다.
종료 코드의 뜻은 각 검사 스크립트의 머리 주석이 소유한다. 여기서는 그 뜻을 판정 낱말로만 옮긴다.

사용법:
    run_checks.ts ROOT [--scope PATH] [--base COMMIT] [--min-run N]

ROOT 는 감사 대상 저장소 루트다.
collect_targets, check_references, check_facts, check_duplication, check_rename_drift 를 돌린다.
--min-run 은 check_duplication 의 최소 연속 줄 수(기본 5)다.
--base 가 없으면 check_rename_drift 는 HEAD 와 작업 트리를 비교한다.
docs-audit 2단계는 그 스킬의 \`scripts/run_static_check.ts\` 가 같은 방식으로 맡는다. 두 스킬의 배포 경로가 달라 스크립트를 나눴다.

출력은 표가 먼저고, 이어 검사마다 표준 출력과 표준 오류를 그대로 붙인다.
판정 낱말은 다음과 같다.
    통과        종료 코드 0 이고 출력으로 따로 구분할 것이 없다
    출력 판정   종료 코드가 판정을 말하지 않는다. 출력을 읽고 판정한다 (check_facts)
    발견        종료 코드 1. 출력의 걸린 자리를 모두 처리해야 한다
    해당 없음   검사가 볼 대상이 없어 돌지 않았다 (check_rename_drift 의 2)
    실행 실패   종료 코드 2 이거나 알 수 없는 코드. 통과가 아니다. 대상 파일이 0 인 경우도 여기다

종료 코드
    0  실행 실패와 발견이 하나도 없다
    1  발견이 있다
    2  실행 실패가 있다. 인자 오류도 여기다
`

const USAGE = 'usage: run_checks.ts [-h] [--scope SCOPE] [--base BASE] [--min-run MIN_RUN]\n                     root\n'

const SPEC: Spec = {
  options: [
    { name: 'scope', value: true },
    { name: 'base', value: true },
    { name: 'min-run', value: true, int: true },
  ],
  positionals: [{ name: 'root', nargs: 1 }],
}

const HELP = `${USAGE}
${DESCRIPTION}

positional arguments:
  root

options:
  -h, --help         show this help message and exit
  --scope SCOPE
  --base BASE
  --min-run MIN_RUN
`

// 검사 이름 → 종료 코드 → 판정. 뜻의 출처는 각 스크립트 머리 주석의 「종료 코드」다.
const VERDICTS: Record<string, Record<number, string>> = {
  collect_targets: { 0: '통과' },
  check_references: { 0: '통과', 1: '발견' },
  check_facts: { 0: '출력 판정' },
  check_duplication: { 0: '통과', 1: '발견' },
  check_rename_drift: { 0: '통과', 1: '발견', 2: '해당 없음' },
}

export const verdict = (name: string, code: number): string => VERDICTS[name][code] ?? '실행 실패'

type Result = [string, number, string, string]

function commands(root: string, scope: string | undefined, base: string | undefined, minRun: number): [string, string[]][] {
  const scopeArgs = scope ? ['--scope', scope] : []
  const drift = [root, ...(base ? [base] : []), ...scopeArgs]
  const script = (name: string) => pjoin(HERE, `${name}.ts`)
  return [
    ['collect_targets', [script('collect_targets'), root, ...scopeArgs]],
    ['check_references', [script('check_references'), root, ...scopeArgs]],
    ['check_facts', [script('check_facts'), root, ...scopeArgs]],
    ['check_duplication', [script('check_duplication'), root, String(minRun), ...scopeArgs]],
    ['check_rename_drift', [script('check_rename_drift'), ...drift]],
  ]
}

function run(found: [string, string[]][]): Result[] {
  return found.map(([name, argv]) => {
    const done = capture([process.execPath, ...argv])
    return [name, done.code, done.stdout, done.stderr]
  })
}

const TRAILING = new RegExp(`${PY_SPACE}+$`)

function render(results: Result[]): string {
  const lines = ['| 검사 | 종료 코드 | 판정 | 출력 줄 수 |', '| --- | --- | --- | --- |']
  for (const [name, code, out] of results) lines.push(`| ${name} | ${code} | ${verdict(name, code)} | ${pySplitLines(out).length} |`)
  for (const [name, code, out, err] of results) {
    lines.push('', `### ${name} (종료 코드 ${code})`, '')
    lines.push(out.replace(TRAILING, '') || '(표준 출력 없음)')
    if (pyStrip(err)) lines.push('', '표준 오류:', err.replace(TRAILING, ''))
  }
  return lines.join('\n')
}

export function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseCli(argv, SPEC)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    write(2, `${USAGE}run_checks.ts: error: ${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    write(1, HELP)
    return 0
  }
  const minRun = parsed.options['min-run'] === undefined ? 5 : parsePyInt(parsed.options['min-run'] as string)
  const root = pyPath(parsed.positionals.root as string)
  const results = run(commands(root, parsed.options.scope as string | undefined, parsed.options.base as string | undefined, minRun))
  write(1, `${render(results)}\n`)

  const verdicts = results.map(([name, code]) => verdict(name, code))
  if (verdicts.includes('실행 실패')) return 2
  return verdicts.includes('발견') ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
