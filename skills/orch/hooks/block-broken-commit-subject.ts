// PreToolUse(Bash): commit 메시지와 push 전 미전송 커밋의 첫 줄만 검사한다.
// 글자 \n\n 과 코드로 시작하는 제목을 거부한다. 본문의 코드와 낱개 \n 은 허용한다.
// shell-text 로 인용·주석·heredoc 을 가려 명령을 찾고 원문에서 인자를 읽는다.
// 셸 확장·stdin 메시지는 실행 전 알 수 없어 건너뛴다. push 조회가 실패해도 통과한다.
// Git 조회 전체에 2초를 쓰며 eval 이나 셸 실행으로 인자를 풀지 않는다.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mask, pieces, stripHeredocs } from './shell-text.ts'

function broken(message: string): boolean {
  const subject = message.split(/\r?\n/, 1)[0]
  return subject.includes('\\n\\n') || /^(?:cat\s+<<|python3?\s|gh\s|EOF\s*$)/.test(subject.trimStart())
}

// 따옴표 조각을 합치되 동적인 값은 null 로 둔다. 단일 인용의 $ 와 역슬래시는 그대로다.
function words(text: string): (string | null)[] {
  return (text.match(/(?:[^\s()"'\\]|\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')+/g) ?? []).map(raw => {
    let value = ''
    let dynamic = false
    for (const part of raw.matchAll(/'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|([^'"\\]+)/g)) {
      if (part[1] !== undefined) value += part[1]
      else if (part[2] !== undefined) {
        if (/(?<!\\)[$`]/.test(part[2])) dynamic = true
        value += part[2].replace(/\\([$`"\\\n])/g, (_, ch) => ch === '\n' ? '' : ch)
      } else if (part[3] !== undefined) value += part[3]
      else {
        if (/[$`]/.test(part[4])) dynamic = true
        value += part[4]
      }
    }
    return dynamic ? null : value
  })
}

const deadline = Date.now() + 2_000
function git(cwd: string, prefix: string[], args: string[]): string | null {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return null
  const result = spawnSync('git', [...prefix, ...args], { cwd, encoding: 'utf8', timeout: remaining, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  return result.status === 0 ? result.stdout : null
}

function unpushedBroken(cwd: string, prefix: string[]): boolean {
  let base = git(cwd, prefix, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])?.trim()
  if (!base) {
    base = git(cwd, prefix, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim()
    // 기준 브랜치를 확인하지 못하면 다른 브랜치로 추측하지 않는다.
    if (!base) return false
  }
  const log = git(cwd, prefix, ['log', '--format=%H%x00%B%x00', `${base}..HEAD`, '--'])
  if (log === null) return false
  const fields = log.split('\0')
  for (let i = 1; i < fields.length; i += 2) if (broken(fields[i])) return true
  return false
}

function rejection(command: string, initialCwd: string): string | null {
  const text = stripHeredocs(command)
  const masked = mask(text)
  let cwd: string | null = initialCwd
  for (const { start, end } of pieces(masked)) {
    const args = words(text.slice(start, start + masked.slice(start, end).trimEnd().length))
    // 환경 변수, command/env, 셸 제어문 앞부분만 벗긴다. echo 의 git 문구는 명령이 아니다.
    while (args.length && (/^[A-Za-z_]\w*=/.test(args[0] ?? '') || ['command', 'env', 'exec', 'if', 'then', 'else', '!', 'time'].includes(args[0] ?? ''))) args.shift()
    if (args[0] === 'cd' || args[0] === 'pushd') {
      const target = args[1] === '--' ? args[2] : args[1]
      cwd = cwd && target && !target.startsWith('-') ? resolve(cwd, target) : null
      continue
    }
    if (!/(?:^|\/)git$/.test(args.shift() ?? '')) continue
    const prefix: string[] = []
    let gitCwd = cwd
    while (args[0]?.startsWith('-')) {
      const flag = args.shift()!
      if (flag === '-C') {
        const dir = args.shift()
        gitCwd = gitCwd && dir !== null && dir !== undefined ? resolve(gitCwd, dir) : null
      } else if (flag === '-c' || flag === '--git-dir' || flag === '--work-tree') {
        const value = args.shift()
        if (value == null) { gitCwd = null; break }
        prefix.push(flag, value)
      } else if (/^(?:--git-dir|--work-tree)=/.test(flag)) prefix.push(flag)
      else { gitCwd = null; break }
    }
    const action = args.shift()
    if (action === 'push' && gitCwd && unpushedBroken(gitCwd, prefix)) {
      return 'orch: 미전송 커밋의 제목에 글자 \\n\\n 이나 셸·파이썬 코드가 있다. ' +
        '메시지를 파일로 쓰고 `git commit --amend -F <파일>` 이나 `git rebase` 로 고친 뒤 push 한다.'
    }
    if (action !== 'commit') continue
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (flag === '--') break
      if (['--author', '--date', '--cleanup', '--trailer', '--fixup', '--squash', '-C', '-c', '--reuse-message', '--reedit-message', '-t', '--template', '--pathspec-from-file'].includes(flag ?? '')) {
        i++ // 다른 옵션의 값에 든 -m 이나 -F 는 메시지 옵션이 아니다.
        continue
      }
      if (flag === '-m' || flag === '--message' || flag?.startsWith('--message=') || /^-[aAnqsv]*m/.test(flag ?? '')) {
        const attached = flag!.startsWith('--message=') ? flag!.slice(10) : /^-[aAnqsv]*m([\s\S]+)$/.exec(flag!)?.[1]
        const message = attached ?? args[i + 1]
        if (message != null && broken(message)) return commitReason
        break // 첫 -m 만 제목이다. 뒤 -m 은 본문이다.
      }
      if (flag === '-F' || flag === '--file' || flag?.startsWith('--file=') || flag?.startsWith('-F')) {
        const file = flag!.startsWith('--file=') ? flag!.slice(7) : flag === '-F' || flag === '--file' ? args[i + 1] : flag!.slice(2)
        if (file && file !== '-' && gitCwd) {
          try { if (broken(readFileSync(resolve(gitCwd, file), 'utf8'))) return commitReason } catch { /* 실행 전 읽을 수 없는 파일은 건너뛴다 */ }
        }
        break
      }
    }
  }
  return null
}

const commitReason = 'orch: 커밋 제목에 글자 \\n\\n 이나 셸·파이썬 코드가 있다. 메시지를 파일로 쓰고 `git commit -F <파일>` 로 다시 한다. 본문의 코드 예시와 낱개 \\n 은 허용한다.'
// cwd 는 Claude 가 넘긴 작업 폴더를 우선한다. hook 프로세스의 cwd 와 다를 수 있다.
let reason: string | null = null
try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input?.tool_name === 'Bash' && typeof input.tool_input?.command === 'string') {
    reason = rejection(input.tool_input.command, typeof input.cwd === 'string' ? input.cwd : process.cwd())
  }
} catch { /* 읽지 못한 입력이나 조회 오류는 호출을 막지 않는다 */ }
if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n')
