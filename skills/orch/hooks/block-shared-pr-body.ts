// PreToolUse(Bash): gh pr create/edit 에서 공유 임시 폴더 바로 아래의 본문 파일을 거부한다.
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { hookCommand, mask, pieces, stripHeredocs } from './shell-text.ts'

const PR_COMMAND = /^\s*(?:(?:[\w]+=[^\s]+|command|env)\s+)*(?:[^\s]*\/)?gh\s+pr\s+(?:create|edit)(?=\s|$)/
const BODY_FILE = /(?:^|\s)(?:--body-file|-F)(?:=|\s+)(\S+)/g

function canonical(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    return resolve(directory)
  }
}

function inSharedRoot(argument: string): boolean {
  const root = tmpdir()
  const expand = (value: string) => value.replace(/^\$(?:\{TMPDIR\}|TMPDIR(?!\w))(?=\/|$)/, () => root)
  // "$TMPDIR/file" 과 "${TMPDIR}"/file 모두 받는다. 작은따옴표 안의 변수는 셸도 펼치지 않는다.
  const file = argument.replace(/^"([^"]*)"|^'([^']*)'|^[^'"]+/, (part, double, single) =>
    single ?? expand(double ?? part))
  if (!isAbsolute(file)) return false
  const parent = canonical(dirname(resolve(file)))
  return [root, '/tmp', '/var/tmp'].some((directory) => canonical(directory) === parent)
}

function unsafeBody(command: string): boolean {
  const text = stripHeredocs(command)
  const masked = mask(text)
  for (const { start, end } of pieces(masked)) {
    const segment = masked.slice(start, end)
    const prefix = PR_COMMAND.exec(segment)
    if (!prefix) continue
    for (const match of segment.slice(prefix[0].length).matchAll(BODY_FILE)) {
      const argumentStart = start + prefix[0].length + match.index + match[0].length - match[1].length
      if (inSharedRoot(text.slice(argumentStart, argumentStart + match[1].length))) return true
    }
  }
  return false
}

const command = hookCommand()
if (command !== null && unsafeBody(command)) {
  const decision = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'orch: 공유 임시 폴더 바로 아래에 둔 PR 본문은 다른 세션이 덮어쓸 수 있다. `orch paths tmp` 로 고유 폴더를 만들고 그 안의 파일을 --body-file 로 넘긴다.',
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + '\n')
}
