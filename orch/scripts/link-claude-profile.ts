// Orca 의 Claude 계정 프로필을 플러그인과 설정이 갖춰진 기준 프로필과 같은 모양으로 맞춘다.
//
// 사용법:
//     link-claude-profile.ts [TARGET] [--from ID] [--include-state] [--apply]
//
//     TARGET           맞출 프로필 id. 없으면 지금 선택된 프로필(selected-host)이다
//     --from           기준 프로필 id. 없으면 plugins 링크와 settings.json 이 있는 프로필 가운데 settings.json 을 가장 최근에 고친 것이다
//     --include-state  세션 상태도 백업하고 링크한다. 그 계정의 세션을 모두 끈 뒤에만 쓴다
//     --apply          실제로 바꾼다. 없으면 바꿀 목록만 낸다(dry-run)
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// 무엇을 옮기고 무엇을 두는지, 백업 이름은 lib/claude-profile.ts 머리 주석이 소유한다.
// ORCA_CLAUDE_PROFILES 로 프로필 폴더를 바꾼다.
//
// 종료 코드: 0 맞췄다(또는 dry-run, 바꿀 것 없음), 1 대상이나 기준 프로필이 없다, 2 사용법 오류

import { statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { apply, homeOf, pickSource, plan, profilesRoot, selectedProfile, stamp } from './lib/claude-profile.ts'

const USAGE = '사용법: link-claude-profile.ts [TARGET] [--from ID] [--include-state] [--apply]'

const OPTIONS = {
  from: { type: 'string' },
  'include-state': { type: 'boolean', default: false },
  apply: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' },
} as const

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: true })
  } catch (e) {
    err(`${USAGE}\nlink-claude-profile: ${(e as Error).message}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    out(USAGE)
    return 0
  }
  if (positionals.length > 1) {
    err(`${USAGE}\nlink-claude-profile: 대상 프로필은 하나만 준다`)
    return 2
  }
  const root = profilesRoot()
  const selected = positionals[0] ?? selectedProfile(root)
  if (selected === null || selected === 'outside') {
    err(`link-claude-profile: 선택된 Orca 프로필이 없다(${root}/selected-host). 대상 프로필 id 를 준다`)
    return 1
  }
  const target = homeOf(root, selected)
  if (!isDir(target)) {
    err(`link-claude-profile: 대상 프로필이 없다: ${target}`)
    return 1
  }
  const sourceId = values.from ?? pickSource(root, selected)
  if (!sourceId) {
    err('link-claude-profile: 기준으로 쓸 프로필이 없다(settings.json 과 plugins 링크가 있는 프로필)')
    return 1
  }
  const source = homeOf(root, sourceId)
  if (!isDir(source) || sourceId === selected) {
    err(`link-claude-profile: 기준 프로필로 쓸 수 없다: ${source}`)
    return 1
  }
  let result
  try {
    result = plan(source, target, values['include-state'] as boolean)
  } catch (e) {
    err(`link-claude-profile: 기준 프로필에 plugins 링크가 없다: ${source} (${(e as Error).message})`)
    return 1
  }
  out(`기준 ${sourceId} → 대상 ${selected}: ${result.steps.length}건`)
  for (const name of result.skipped) out(`  건너뜀 ${name}: 세션 상태가 있다. 그 계정의 세션을 끈 뒤 --include-state 로 다시 돌린다`)
  for (const step of result.steps) {
    out(`  ${step.kind === 'link' ? '링크' : '복사'} ${step.name} ← ${step.origin}${step.replaces ? ' (있던 것은 백업)' : ''}`)
  }
  if (!values.apply) {
    out('dry-run 이다. --apply 를 주면 바꾼다')
    return 0
  }
  apply(target, result.steps, stamp())
  out('적용했다. 그 계정의 Claude 세션을 다시 시작하면 반영된다')
  return 0
}

process.exitCode = main(process.argv.slice(2))
