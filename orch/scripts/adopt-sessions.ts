// 이전 코디네이터의 살아 있는 dispatch 에 묶이지 않은 터미널을 발견해 이어 붙인다.
// 사용법: adopt-sessions.ts [--repo DIR] [--json] [--apply TERMINAL --run RUN [--spec FILE]]
// 기본은 읽기만 한다. 사람의 셸도 목록에는 보이지만 apply 는 확인된 에이전트의 빈 입력 대기/오류/중단 화면에만 허용한다.
// apply 는 모든 Run 과 현재 화면을 다시 읽고 worker-start --terminal --worktree 로 새 Task/dispatch 를 만든다.
// --spec 은 그 브랜치의 지시서 후보여야 한다. 후보가 하나면 자동 선택하고, 없거나 여럿이면 명시하도록 거부한다.
// CLI 에 재연결 기능이 없으면 임시 폴더에 이어받기 뼈대를 쓰고 수동 교체 방법만 안내한다. 닫거나 입력하지 않는다.
// worker-start 실패 뒤에는 재시도하지 않는다. receipt 의 실패 단계와 잔여 자원을 확인해야 하기 때문이다.
// 종료 코드: 0 목록/연결 성공, 1 조회/연결 실패, 2 사용법 오류, 3 안전하게 연결할 수 없거나 수동 이어받기가 필요함.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { mainCheckout } from './lib/git.ts'
import { orca } from './lib/orca.ts'
import { discoverSessions, handover } from './lib/sessions.ts'

const USAGE = '사용법: adopt-sessions.ts [--repo DIR] [--json] [--apply TERMINAL --run RUN [--spec FILE]]'
async function main(): Promise<number> {
  const options = { repo: { type: 'string' }, json: { type: 'boolean' }, apply: { type: 'string' }, run: { type: 'string' }, spec: { type: 'string' }, help: { type: 'boolean' } } as const
  let values
  try { values = parseArgs({ args: expandArgs(process.argv.slice(2), options), options }).values }
  catch (error) { process.stderr.write(`${USAGE}\n${(error as Error).message}\n`); return 2 }
  if (values.help) { console.log(USAGE); return 0 }
  if ((!values.apply && (values.run || values.spec)) || (values.apply && !values.run)) { console.error(USAGE); return 2 }
  const repo = mainCheckout(values.repo ?? process.cwd())
  try {
    const sessions = await discoverSessions(repo)
    if (!values.apply) {
      if (values.json) console.log(JSON.stringify({ repo, sessions }))
      else {
        if (!sessions.length) console.log('NO-SESSIONS 살아 있는 dispatch 에서 떨어진 터미널이 없다')
        for (const session of sessions) console.log(`SESSION ${session.terminal}\n${JSON.stringify(session, null, 2)}`)
      }
      return 0
    }
    // apply 직전 한 번 더 읽어 목록을 본 뒤 다른 세션이 가져간 터미널을 제외한다.
    const selected = (await discoverSessions(repo)).find((session) => session.terminal === values.apply)
    if (!selected || typeof selected.agent !== 'string' || !selected.agent || !['idle', 'error', 'interrupted'].includes(selected.state)) {
      console.error('ADOPT-REFUSED 대상이 없거나 살아 있는 dispatch, 사람의 셸, 작업/권한/초안 대기 화면이다'); return 3
    }
    const spec = values.spec ? resolve(values.spec) : selected.specs.length === 1 ? selected.specs[0] : null
    if (!spec || !selected.specs.includes(spec)) { console.error('ADOPT-REFUSED 해당 브랜치의 지시서를 --spec 으로 고른다'); return 3 }
    const help = orca(['orchestration', 'worker-start', '--help'])
    if (help.code !== 0) throw new Error('worker-start 기능을 확인하지 못했다')
    const file = join(mkdtempSync(join(tmpdir(), 'orch-adopt-')), 'handover.md')
    writeFileSync(file, handover(selected, spec))
    if (!help.stdout.includes('--terminal') || !help.stdout.includes('--worktree')) {
      console.log(`ADOPT-MANUAL ${file}\n현재 CLI 는 재연결을 지원하지 않는다. 사용자 확인 뒤 이 터미널을 정리하고 같은 워크트리에 이 지시서를 읽는 새 worker 를 띄운다.`)
      return 3
    }
    // 실패 receipt 의 잔여 자원과 request id 를 자르지 않는다. 연결이 이미 일어났을 수도 있어 자동 재시도하지 않는다.
    const result = orca(['orchestration', 'worker-start', '--spec', `지시서 ${JSON.stringify(file)} 를 끝까지 읽고 수행한다.`,
      '--terminal', selected.terminal, '--worktree', `path:${selected.worktree}`, '--run', values.run!, '--json'])
    if (result.code !== 0) throw new Error(`${result.stdout}\n${result.stderr}\n이어받기 지시서: ${file}. 자동 재시도하지 않고 receipt 를 확인한다`)
    const receipt = JSON.parse(result.stdout)
    if (receipt?.ok !== true || !receipt.result) throw new Error(`연결 결과를 확인하지 못했다: ${result.stdout}. 자동 재시도하지 않는다. 지시서: ${file}`)
    console.log(`ADOPTED ${selected.terminal} ${file}\n${JSON.stringify(receipt.result)}`)
    return 0
  } catch (error) { console.error(`ADOPT-ERROR ${(error as Error).message}`); return 1 }
}
process.exitCode = await main()
