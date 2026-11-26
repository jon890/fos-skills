// PreToolUse(Bash): gh pr create/edit 에서 공유 임시 폴더 바로 아래의 본문 파일을 거부한다.
import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { hookInvocation, mask, pieces, stripHeredocs } from './shell-text.ts'

const REPO_OPTION = /(?:(?:--repo(?:=|\s+)|-R(?:=|\s+)?)\S+\s+)*/
const PR_COMMAND = new RegExp(
  /^\s*(?:(?:\w+=\S+|command|env)\s+)*(?:\S*\/)?gh\s+/.source
  + REPO_OPTION.source + /pr\s+/.source + REPO_OPTION.source + /(?:create|edit)(?=\s|$)/.source,
)
const BODY_FILE = /(?:^|\s)(?:--body-file(?:=|\s+)|-F(?:=|\s+)?)(\S+)/g
const CD = /^\s*cd\s+(?:--\s+)?(\S+)\s*$/

function canonical(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    return resolve(directory)
  }
}

function literalPath(argument: string): string | null {
  const root = tmpdir()
  const expand = (value: string) => value.replace(/^\$(?:\{TMPDIR\}|TMPDIR(?!\w))(?=\/|$)/, () => root)
  // "$TMPDIR/file" 과 "${TMPDIR}"/file 모두 받는다. 작은따옴표 안의 변수는 셸도 펼치지 않는다.
  const file = argument.replace(/^"([^"]*)"|^'([^']*)'|^[^'"]+/, (part, double, single) =>
    single ?? expand(double ?? part))
  if (file === '-' || /[$`]/.test(file)) return null
  return file
}

function inSharedRoot(argument: string, cwd: string): boolean {
  const file = literalPath(argument)
  if (!file) return false
  const root = tmpdir()
  const parent = canonical(dirname(resolve(cwd, file)))
  return [root, '/tmp', '/var/tmp'].some((directory) => canonical(directory) === parent)
}

function changedDirectory(argument: string, cwd: string): string {
  const directory = literalPath(argument)
  if (!directory) return cwd
  try {
    const next = realpathSync(resolve(cwd, directory))
    return statSync(next).isDirectory() ? next : cwd
  } catch {
    return cwd
  }
}

function unsafeBody(command: string, cwd: string): boolean {
  const text = stripHeredocs(command)
  const masked = mask(text)
  const segments = pieces(masked)
  for (const [index, { start, end }] of segments.entries()) {
    const segment = masked.slice(start, end)
    const cd = CD.exec(segment)
    if (cd) {
      const next = segments[index + 1]?.join
      if (next === '&&' || next === ';' || next === '\n') {
        const argumentStart = start + segment.indexOf(cd[1], cd[0].indexOf('cd') + 2)
        cwd = changedDirectory(text.slice(argumentStart, argumentStart + cd[1].length), cwd)
      }
      continue
    }
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
