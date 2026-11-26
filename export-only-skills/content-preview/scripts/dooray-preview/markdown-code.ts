// 링크 검사에서 코드 예제를 가린다. 원문에서 표시 글을 다시 읽을 수 있도록 길이와 줄바꿈을 보존한다.
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u
const QUOTE = /^ {0,3}> ?/u
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?: {1,4}(?=\S)| |(?=\r?$))/u
const HEADING_OR_BREAK = /^ {0,3}(?:#{1,6}(?: |\r?$)|(?:\* *){3,}\r?$|(?:- *){3,}\r?$|(?:_ *){3,}\r?$)/u
const INLINE_CODE = /(?<![`\\])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu

type Container = { kind: 'quote' } | { kind: 'list'; indent: number }
type Fence = { line: number; delimiter: string }

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, ' ')
}

function expandTabs(line: string): string {
  let extra = 0
  return line.replace(/\t/gu, (_, index: number) => {
    const width = 4 - (index + extra) % 4
    extra += width - 1
    return ' '.repeat(width)
  })
}

function continueContainer(line: string, container: Container): string | undefined {
  if (container.kind === 'quote') {
    const quote = QUOTE.exec(line)
    return quote ? line.slice(quote[0].length) : undefined
  }
  if (!line.trim() || line.startsWith(' '.repeat(container.indent))) return line.slice(container.indent)
}

function startContainer(line: string): { container: Container; width: number } | undefined {
  const quote = QUOTE.exec(line)
  if (quote) return { container: { kind: 'quote' }, width: quote[0].length }
  if (HEADING_OR_BREAK.test(line)) return
  const item = LIST_ITEM.exec(line)
  if (item) {
    const width = item[0].length
    return { container: { kind: 'list', indent: item[0].endsWith(' ') ? width : width + 1 }, width }
  }
}

export function maskCode(md: string): string {
  const lines = md.split(/(?<=\n)/u)
  const containers: Container[] = []
  const blockStarts = new Set<number>()
  let fence: Fence | undefined
  let paragraph = false

  for (const [index, line] of lines.entries()) {
    let content = expandTabs(line)
    let depth = 0
    for (const container of containers) {
      const rest = continueContainer(content, container)
      if (rest === undefined) break
      content = rest
      depth++
    }
    if (depth !== containers.length) {
      containers.length = depth
      fence = undefined
      paragraph = false
      blockStarts.add(index)
    }

    if (fence) {
      blockStarts.add(index)
      const end = FENCE.exec(content)
      if (end && end[1][0] === fence.delimiter[0] && end[1].length >= fence.delimiter.length && !end[2].trim()) {
        for (let row = fence.line; row <= index; row++) lines[row] = blank(lines[row])
        fence = undefined
        blockStarts.add(index + 1)
      }
      continue
    }

    let next = startContainer(content)
    if (next) blockStarts.add(index)
    while (next) {
      containers.push(next.container)
      content = content.slice(next.width)
      paragraph = false
      next = startContainer(content)
    }

    if (!content.trim()) {
      paragraph = false
      blockStarts.add(index + 1)
      continue
    }
    if (!paragraph && content.startsWith('    ')) {
      lines[index] = blank(line)
      blockStarts.add(index + 1)
      continue
    }

    const start = FENCE.exec(content)
    if (start && (start[1][0] !== '`' || !start[2].includes('`'))) {
      fence = { line: index, delimiter: start[1] }
      paragraph = false
      blockStarts.add(index)
      // 닫는 줄이 없으면 본문을 검사한다. 여는 기호만 인라인 코드 검사에서 뺀다.
      const markerStart = line.indexOf(start[1])
      lines[index] = line.slice(0, markerStart) + blank(start[1]) + line.slice(markerStart + start[1].length)
      continue
    }
    paragraph = !HEADING_OR_BREAK.test(content)
    if (!paragraph) {
      blockStarts.add(index)
      blockStarts.add(index + 1)
    }
  }

  // 인라인 코드의 백틱은 같은 블록 안에서만 짝짓는다.
  blockStarts.add(lines.length)
  let start = 0
  const blocks: string[] = []
  for (const end of blockStarts) {
    blocks.push(lines.slice(start, end).join('').replace(INLINE_CODE, blank))
    start = end
  }
  return blocks.join('')
}
