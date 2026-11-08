// 커밋 메시지를 korean-check 의 검사기로 점검하고, 금지어가 있으면 커밋을 막는다. 진입은 같은 이름의 확장자 없는 파일이다.
//
// 왜 필요한가 (실측):
//     커밋을 만든 뒤에 메시지를 점검하면 금지어가 걸렸을 때 rebase 로 이력을 다시 써야 했다.
//     push 뒤면 force push 까지 든다. 커밋 전에 막으면 메시지만 고쳐 다시 커밋하면 된다.
//
// 검사기는 `.md` 파일만 읽으므로 메시지를 임시 `.md` 파일로 옮겨 넘긴다.
// `--verbose` 의 잘라내기 줄 아래(diff)는 검사하지 않는다.
// `#` 주석 줄은 검사한다. `-m` 과 `-F` 로 준 메시지는 git 이 주석 줄을 지우지 않아 그대로 커밋에 남는다.
// 검사기가 없거나 돌지 못하면(종료 코드 2) 알리기만 하고 막지 않는다. 도구 고장으로 모든 커밋이 막히지 않게 한다.
//
// 종료 코드: 0 커밋한다, 1 금지어가 있어 막는다
// 설치: node scripts/install-hooks.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeNewlines, pySplitLines, pyStrip } from '../modules/kit/py.ts'
import { isFile } from '../scripts/skill_paths.ts'

const SCISSORS = '------------------------ >8 ------------------------'

// 잘라내기 줄 위만 낸다. 그 아래는 git 이 커밋에 남기지 않는 diff 다
export function messageText(text: string): string {
  const kept: string[] = []
  for (const line of pySplitLines(text)) {
    if (line.includes(SCISSORS)) break
    kept.push(line)
  }
  return kept.join('\n') + '\n'
}

export function main(argv: string[]): number {
  if (argv.length < 1) return 0
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim() ?? ''
  const checker = join(root, 'export-only-skills', 'korean-check', 'scripts', 'korean-style-check.ts')
  if (!isFile(checker)) return 0
  const text = messageText(normalizeNewlines(readFileSync(argv[0], 'utf8')))
  const tmp = mkdtempSync(join(tmpdir(), 'commit-msg-'))
  let done
  const msg = join(tmp, 'COMMIT_EDITMSG.md')
  try {
    writeFileSync(msg, text)
    done = spawnSync(process.execPath, [checker, msg], { encoding: 'utf8' })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const report = pyStrip(((done.stdout ?? '') + (done.stderr ?? '')).replaceAll(msg, '커밋 메시지'))
  if (done.status === 1) {
    process.stderr.write(`${report}\n`)
    process.stderr.write('커밋 메시지에 금지어가 있어 커밋하지 않았다. 메시지를 고쳐 다시 커밋한다.\n')
    process.stderr.write(`쓴 메시지: ${argv[0]}\n`)
    return 1
  }
  if (done.status !== 0) process.stderr.write(`commit-msg: 한국어 검사기가 돌지 못해 점검을 건너뛴다.\n${report || (done.error?.message ?? '')}\n`)
  else if (report) process.stderr.write(`${report}\n`)
  return 0
}
