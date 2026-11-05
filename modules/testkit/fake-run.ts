// 프로세스를 띄우지 않는 가짜 run(). 명령 이름으로 규칙 묶음을 골라 결과를 돌려준다.
// 규칙의 뜻은 fake-bin.ts 의 가짜 실행 파일과 같다(matchRule 을 함께 쓴다).

import { basename } from 'node:path'
import { matchRule, type FakeRule } from './fake-bin.ts'

export type FakeRunResult = { code: number; stdout: string; stderr: string; timedOut: false }
export type FakeRunCall = { argv: string[]; opts: unknown }

export function fakeRun(rulesByCommand: Record<string, FakeRule[]>) {
  const bundles: Record<string, FakeRule[]> = { ...rulesByCommand }
  const log: FakeRunCall[] = []
  const run = (argv: string[], opts?: unknown): FakeRunResult => {
    log.push({ argv, opts })
    const rule = matchRule(bundles[basename(argv[0])] ?? [], argv.slice(1))
    return { code: rule?.code ?? 0, stdout: rule?.stdout ?? '', stderr: rule?.stderr ?? '', timedOut: false }
  }
  return {
    run,
    calls: () => log.slice(),
    setRules: (command: string, rules: FakeRule[]) => {
      bundles[command] = rules
    },
  }
}
