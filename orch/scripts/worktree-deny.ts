// 워크트리의 `.claude/settings.local.json` 에 다른 worker 의 자원을 빼앗는 명령과 PR 머지의 deny 규칙을 더한다.
//
// 한 머신에서 worker 여럿이 같은 이름의 프로세스와 같은 브라우저를 쓴다.
// 하위 에이전트가 `pkill -f 'node server/local-host.cjs'` 로 자기 호스트를 끄다 다른 worker 의 호스트까지 껐고,
// `browser-driver reset` 이 다른 worker 의 탭을 닫았다(실측 5건). 지시서 문장으로는 하위 에이전트까지 닿지 않아
// 권한 규칙으로 막는다. 자기가 띄운 프로세스는 PID 로 `kill` 한다.
// `gh pr merge` 도 막는다. 머지는 코디네이터가 하는데, 지시서에 「머지하지 않는다」 를 적어도 worker 가 PR 다섯 개를
// 직접 머지했다(실측). 코디네이터는 기본 체크아웃에서 머지 큐로 머지하므로 이 규칙에 닿지 않는다.
//
// 사용법:
//     worktree-deny.ts <워크트리>
//
//     기존 설정의 다른 키와 규칙은 그대로 두고, 없는 deny 규칙만 더한다. 몇 번을 돌려도 같다.
//     그 파일을 git 이 추적하면 쓰지 않고 종료 코드 1 을 낸다. 고치면 워크트리가 dirty 해져 정리가 거부된다.
//     새로 만든 설정 파일은 git 이 무시하게 공통 git 폴더의 info/exclude 에 한 줄을 더한다.
//     untracked 로 남으면 remove-worktree 가 커밋 안 된 변경으로 거부하기 때문이다.
//
// 종료 코드: 0 썼거나 이미 있다, 1 추적되는 파일이라 쓰지 않았다, 2 사용법 오류나 JSON 을 읽지 못했다
//
// `--help` 는 고유 접두(`--he`)로 줄여 쓸 수 있다(lib/args.ts).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expandArgs } from './lib/args.ts'
import { isFile } from './lib/fs.ts'
import { git } from './lib/git.ts'

const USAGE = '사용법: worktree-deny.ts <워크트리>'
const DENY = ['Bash(pkill:*)', 'Bash(killall:*)', 'Bash(browser-driver reset:*)', 'Bash(gh pr merge:*)']
const REL = '.claude/settings.local.json'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function main(raw: string[]): number {
  // 옵션이 --help 하나라 접두가 겹칠 일이 없다
  const argv = expandArgs(raw, { help: { type: 'boolean' } })
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (argv.length !== 1) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  const wt = argv[0]
  if (git(wt, ['ls-files', '--error-unmatch', REL]).code === 0) {
    process.stderr.write(`worktree-deny: ${REL} 를 git 이 추적해 쓰지 않는다. deny 규칙은 저장소 설정에 둔다\n`)
    return 1
  }
  const file = join(wt, REL)
  let settings: unknown = {}
  if (isFile(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      process.stderr.write(`worktree-deny: ${file} 를 JSON 으로 읽지 못했다: ${(e as Error).message}\n`)
      return 2
    }
  }
  if (!isObject(settings)) {
    process.stderr.write(`worktree-deny: ${file} 의 최상위가 객체가 아니다\n`)
    return 2
  }
  const permissions = settings.permissions ?? (settings.permissions = {})
  if (!isObject(permissions)) {
    process.stderr.write(`worktree-deny: ${file} 의 permissions 가 객체가 아니다\n`)
    return 2
  }
  const deny = permissions.deny ?? (permissions.deny = [])
  if (!Array.isArray(deny)) {
    process.stderr.write(`worktree-deny: ${file} 의 permissions.deny 가 목록이 아니다\n`)
    return 2
  }
  const added = DENY.filter((rule) => !deny.includes(rule))
  if (added.length > 0) {
    deny.push(...added)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  }
  if (git(wt, ['check-ignore', '-q', REL]).code !== 0) {
    const common = git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()
    // git 밖이면 무시할 곳이 없다. 빈 값으로 상대경로 info/exclude 를 만들면 작업 디렉터리에 엉뚱한 파일이 생긴다
    if (!common) return 0
    const exclude = join(common, 'info', 'exclude')
    mkdirSync(dirname(exclude), { recursive: true })
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    appendFileSync(exclude, `${!text || text.endsWith('\n') ? '' : '\n'}/${REL}\n`, 'utf8')
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
