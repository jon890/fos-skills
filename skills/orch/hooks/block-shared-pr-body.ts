// PreToolUse(Bash): gh pr create/edit 에서 공유 임시 폴더 바로 아래의 본문 파일을 거부한다.
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { hookInvocation, mask, pieces, stripHeredocs } from './shell-text.ts'

const REPO_OPTION = /(?:(?:--repo(?:=|\s+)|-R(?:=|\s+)?)\S+\s+)*/
const PR_COMMAND = new RegExp(
  /^\s*(?:(?:\w+=\S+|command|env)\s+)*(?:\S*\/)?gh\s+/.source
  + REPO_OPTION.source + /pr\s+/.source + REPO_OPTION.source + /(?:create|edit)(?=\s|$)/.source,
)
const BODY_FILE = /(?:^|\s)(?:--body-file(?:=|\s+)|-F(?:=|\s+)?)(\S+)/g

function canonical(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    return resolve(directory)
  }
}

function inSharedRoot(argument: string, cwd: string): boolean {
  const root = tmpdir()
  const expand = (value: string) => value.replace(/^\$(?:\{TMPDIR\}|TMPDIR(?!\w))(?=\/|$)/, () => root)
  // "$TMPDIR/file" 과 "${TMPDIR}"/file 모두 받는다. 작은따옴표 안의 변수는 셸도 펼치지 않는다.
  const file = argument.replace(/^"([^"]*)"|^'([^']*)'|^[^'"]+/, (part, double, single) =>
    single ?? expand(double ?? part))
  if (file === '-' || file.includes('$') || file.includes('`')) return false
  const parent = canonical(dirname(resolve(cwd, file)))
  return [root, '/tmp', '/var/tmp'].some((directory) => canonical(directory) === parent)
}

function unsafeBody(command: string, cwd: string): boolean {
  const text = stripHeredocs(command)
  const masked = mask(text)
  for (const { start, end } of pieces(masked)) {
    const segment = masked.slice(start, end)
    const prefix = PR_COMMAND.exec(segment)
    if (!prefix) continue
    for (const match of segment.slice(prefix[0].length).matchAll(BODY_FILE)) {
      const argumentStart = start + prefix[0].length + match.index + match[0].length - match[1].length
      if (inSharedRoot(text.slice(argumentStart, argumentStart + match[1].length), cwd)) return true
    }
  }
  return false
}

const invocation = hookInvocation()
if (invocation && unsafeBody(invocation.command, invocation.cwd)) {
  const decision = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'orch: 공유 임시 폴더 바로 아래에 둔 PR 본문은 다른 세션이 덮어쓸 수 있다. `orch paths tmp` 로 고유 폴더를 만들고 그 안의 파일을 --body-file 로 넘긴다.',
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + '\n')
}
