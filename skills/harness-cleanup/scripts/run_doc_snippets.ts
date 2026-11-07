#!/usr/bin/env node
// 문서에 적힌 bash 코드 블록을 그대로 추출해 bash 와 zsh 양쪽에서 돌린다.
//
// 사용법:
//     run_doc_snippets.ts <파일> ["<블록 앞에 오는 머리말>"]
//     run_doc_snippets.ts <파일> --list
//     run_doc_snippets.ts <파일> --block <번호>
//
// 문서대로 실행했을 때 실제로 동작하는지 확인하는 것이 목적이다.
//
// 머리말을 생략하면 그 파일의 실행 가능한 블록을 처음부터 끝까지 전부 돈다.
// `SKILL.md` 2단계가 요구하는 것이 그것이다. 머리말을 주면 그 뒤 첫 블록 하나만 돈다.
//
// `--list` 는 블록을 실행하지 않고 번호, 시작 줄, 앞 머리말, 첫 줄을 낸다.
// 저장소나 외부에 닿는 명령(`RISKY` 상수)이 든 블록에는 `[위험]` 과 해당 명령을 붙인다.
// 표시는 읽을 블록을 고르는 단서이고 안전 보증이 아니다. 표시가 없어도 블록을 읽는다.
// `--block N` 은 `--list` 의 번호 N 블록 하나만 돈다.
//
// 종료 코드:
//     0  블록을 찾아 실행했다
//     2  파일이 없거나 인자가 모자란다
//     3  돌릴 bash 블록을 찾지 못했다(`--block` 번호가 범위 밖인 경우 포함)
//
// **판정은 출력으로 한다.** 블록에 문법 오류가 있어도 이 스크립트는 0 으로 끝난다.
// 셸마다 결과가 다르면 배열 확장 같은 셸 차이를 의심한다.
// 결과가 0건이면 음성 대조까지 해야 한다. 검사를 안 해서 0건일 수 있다.
//

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture, isMain, readTextReplace, which, write } from './io.ts'
import { pyHead, pySplitLines, pyStrip } from './kit/py.ts'
import { escapeRegExp, isFile, NOT_WORD_AFTER, NOT_WORD_BEFORE as B, parsePyInt, pyPath, pyre, WORD } from './pylike.ts'

const USAGE = `문서에 적힌 bash 코드 블록을 그대로 추출해 bash 와 zsh 양쪽에서 돌린다.

사용법:
    run_doc_snippets.ts <파일> ["<블록 앞에 오는 머리말>"]
    run_doc_snippets.ts <파일> --list
    run_doc_snippets.ts <파일> --block <번호>

문서대로 실행했을 때 실제로 동작하는지 확인하는 것이 목적이다.

머리말을 생략하면 그 파일의 실행 가능한 블록을 처음부터 끝까지 전부 돈다.
\`SKILL.md\` 2단계가 요구하는 것이 그것이다. 머리말을 주면 그 뒤 첫 블록 하나만 돈다.

\`--list\` 는 블록을 실행하지 않고 번호, 시작 줄, 앞 머리말, 첫 줄을 낸다.
저장소나 외부에 닿는 명령(\`RISKY\` 상수)이 든 블록에는 \`[위험]\` 과 해당 명령을 붙인다.
표시는 읽을 블록을 고르는 단서이고 안전 보증이 아니다. 표시가 없어도 블록을 읽는다.
\`--block N\` 은 \`--list\` 의 번호 N 블록 하나만 돈다.

종료 코드:
    0  블록을 찾아 실행했다
    2  파일이 없거나 인자가 모자란다
    3  돌릴 bash 블록을 찾지 못했다(\`--block\` 번호가 범위 밖인 경우 포함)

**판정은 출력으로 한다.** 블록에 문법 오류가 있어도 이 스크립트는 0 으로 끝난다.
셸마다 결과가 다르면 배열 확장 같은 셸 차이를 의심한다.
결과가 0건이면 음성 대조까지 해야 한다. 검사를 안 해서 0건일 수 있다.
`

const RULE = '─'.repeat(37)
const SHELLS = ['bash', 'zsh']

const BLOCK = /```(?:bash|sh)\n(.*?)```/gsu

// 저장소나 외부에 닿는 명령. `--list` 가 이 패턴이 든 블록에 위험 표시를 붙인다.
// Python 의 \b 는 한글도 글자로 보므로 앞뒤 lookaround 로 옮겼다
const E = NOT_WORD_AFTER
const RISKY = [
  `${B}git\\s+(?:-C\\s+\\S+\\s+)?(?:push|commit|reset|clean|checkout|merge|rebase)${E}`,
  `${B}gh\\s`,
  `${B}orca\\s`,
  `${B}nhncloud\\s+configure${E}`,
  `--apply${E}`,
  `${B}rm\\s+-${WORD}*[rf]`,
  `${B}kill(?:all)?${E}`,
  `${B}pkill${E}`,
].map((source) => pyre(new RegExp(source, 'u')))

// 머리말 뒤 첫 bash 블록의 본문
function extract(text: string, marker: string): string | null {
  const m = new RegExp(`${escapeRegExp(marker)}.*?\`\`\`(?:bash|sh)\\n(.*?)\`\`\``, 'su').exec(text)
  return m ? m[1] : null
}

// 파일에 있는 bash 블록 전부
const extractAll = (text: string): string[] => [...text.matchAll(BLOCK)].map((m) => m[1])

type Row = [number, number, string, string, string[]]

// 블록마다 (번호, 시작 줄, 머리말, 첫 줄, 위험 명령 목록)을 낸다. 실행하지 않는다
function listBlocks(text: string): Row[] {
  const rows: Row[] = []
  let number = 0
  for (const m of text.matchAll(BLOCK)) {
    number++
    const line = [...text.slice(0, m.index)].filter((ch) => ch === '\n').length + 1
    const before = pySplitLines(text.slice(0, m.index)).map(pyStrip).filter((x) => x)
    const heading = before.length ? before[before.length - 1] : ''
    const body = m[1]
    const first = pySplitLines(body).map(pyStrip).find((x) => x) ?? ''
    const risky = RISKY.map((p) => p.exec(body)).filter((hit) => hit).map((hit) => pyStrip(hit![0]))
    rows.push([number, line, heading, first, risky])
  }
  return rows
}

// 문법 검사를 먼저 하고, 통과하면 실행해 출력을 낸다
let noticedMissing = false

function runIn(shell: string, path: string): string {
  if (!which(shell)) {
    // 셸이 없으면 한 번만 알리고 있는 셸만 돈다. zsh 가 없는 환경(CI 포함)에서도 bash 결과는 나온다
    if (noticedMissing) return ''
    noticedMissing = true
    return `${shell} 없음, ${SHELLS.filter((s) => s !== shell).join(', ')} 만\n`
  }
  const syntax = capture([shell, '-n', path])
  if (syntax.code !== 0) {
    let out = `[${shell}] 문법 오류\n`
    for (const line of pySplitLines(syntax.stdout + syntax.stderr)) out += `    ${line}\n`
    return out
  }
  const done = capture([shell, path])
  const text = done.stdout + done.stderr
  const lines = pySplitLines(text).filter((x) => pyStrip(x))
  let out = `[${shell}] 문법 OK / 출력 ${lines.length}줄\n`
  for (const line of pySplitLines(text).slice(0, 10)) out += `    ${line}\n`
  return out
}

function runBlock(block: string, label: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'snippet-'))
  const snippet = join(dir, 'snippet.sh')
  try {
    writeFileSync(snippet, block)
    write(1, `${label} (${pySplitLines(block).length}줄)\n${RULE}\n`)
    for (const shell of SHELLS) write(1, runIn(shell, snippet))
    write(1, `${RULE}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function main(argv: string[]): number {
  let args = [...argv]
  const listOnly = args.includes('--list')
  args = args.filter((a) => a !== '--list')
  let blockNo: number | null = null
  const at = args.indexOf('--block')
  if (at >= 0) {
    try {
      if (at + 1 >= args.length) throw new Error('값 없음')
      blockNo = parsePyInt(args[at + 1])
    } catch {
      write(2, '--block 에 블록 번호가 필요하다\n')
      return 2
    }
    args.splice(at, 2)
  }
  if (!args.length) {
    write(2, `${USAGE}\n`)
    return 2
  }
  const path = pyPath(args[0])
  const marker = args.length > 1 ? args[1] : null
  if (!isFile(path)) {
    write(2, `파일이 없다: ${path}\n`)
    return 2
  }

  const text = readTextReplace(path)
  if (listOnly) {
    const rows = listBlocks(text)
    if (!rows.length) {
      write(2, 'bash 블록을 찾지 못했다\n')
      return 3
    }
    let out = ''
    for (const [number, line, heading, first, risky] of rows) {
      const flag = risky.length ? `  [위험: ${risky.join(', ')}]` : ''
      out += `${String(number).padStart(3)}  ${line}행  ${pyHead(heading, 50)}  |  ${pyHead(first, 70)}${flag}\n`
    }
    write(1, out)
    return 0
  }
  if (blockNo !== null) {
    const blocks = extractAll(text)
    if (!(blockNo >= 1 && blockNo <= blocks.length)) {
      write(2, `블록 ${blockNo} 이 없다 (블록 ${blocks.length}개)\n`)
      return 3
    }
    runBlock(blocks[blockNo - 1], `블록 ${blockNo}/${blocks.length}`)
  } else if (marker === null) {
    const blocks = extractAll(text)
    if (!blocks.length) {
      write(2, 'bash 블록을 찾지 못했다\n')
      return 3
    }
    write(1, `블록 ${blocks.length}개를 돈다\n`)
    blocks.forEach((block, index) => runBlock(block, `블록 ${index + 1}/${blocks.length}`))
  } else {
    const block = extract(text, marker)
    if (block === null) {
      write(2, `"${marker}" 뒤에서 bash 블록을 찾지 못했다\n`)
      return 3
    }
    runBlock(block, '추출한 블록')
  }

  write(1, '출력이 0줄이면 음성 대조를 하라 — 검사 대상 경로에 탐지 대상을 심고\n')
  write(1, '같은 블록이 그것을 잡아내는지 확인한다. 잡지 못하면 검사가 도는 것이 아니다.\n')
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
