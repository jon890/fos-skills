#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { check, parseHtml } from './check-report.ts'

const MERMAID_CLI = '@mermaid-js/mermaid-cli@12.2.0'
function findBlocks(html: string) {
  const blocks: { start: number; end: number; line: number; source: string }[] = []
  let pre: { start: number; line: number; source: string; state: 'before' | 'inside' | 'after' } | undefined
  parseHtml(html, {
    start(tag, attrs, line, offset) {
      if (tag === 'pre') {
        pre = { start: offset, line, source: '', state: 'before' }
      } else if (pre?.state === 'before' && tag === 'code' &&
        attrs.some(([name, value]) => name === 'class' && value?.split(/\s+/).includes('language-mermaid'))) {
        pre.state = 'inside'
      } else {
        pre = undefined
      }
    },
    startend() { pre = undefined },
    end(tag, _line, offset) {
      if (!pre) return
      if (tag === 'code' && pre.state === 'inside') {
        pre.state = 'after'
        return
      }
      if (tag === 'pre' && pre.state === 'after') {
        blocks.push({ start: pre.start, end: offset, line: pre.line, source: pre.source.trim() })
      }
      pre = undefined
    },
    data(text) {
      if (pre?.state === 'inside') pre.source += text
      else if (text.trim()) pre = undefined
    },
  })
  return blocks
}

function findChrome(): string | undefined {
  const override = process.env.REPORT_CHROME_PATH
  const candidates = override ? [override] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...((process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((dir) => ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map((name) => join(dir, name)))),
  ]
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

function render(source: string, dir: string): string {
  const input = join(dir, 'diagram.mmd')
  const output = join(dir, 'diagram.svg')
  const svgId = `report-mermaid-${randomUUID()}`
  writeFileSync(input, source)
  rmSync(output, { force: true })
  const result = spawnSync('npx', [
    '--yes', MERMAID_CLI, '--input', input, '--output', output,
    '--configFile', join(dir, 'mermaid.json'),
    '--puppeteerConfigFile', join(dir, 'puppeteer.json'),
    '--svgId', svgId,
    '--backgroundColor', 'transparent', '--no-font-embed', '--quiet',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' },
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `mermaid-cli 종료 코드 ${result.status}`)
  const svg = readFileSync(output, 'utf8').trim()
  if (!/^<svg[\s>][\s\S]*<\/svg>$/.test(svg)) throw new Error('SVG 출력이 없다')
  const problems = check('report.html', `<html><body>${svg}</body></html>`)
  if (problems.length) throw new Error(problems.map(([, , message]) => message).join('\n'))
  return scopeSvgIds(svg, svgId)
}

// Mermaid 는 SVG 루트 id 를 받아도 시퀀스의 actor0 같은 id 를 재사용한다.
// CLI 가 직렬화한 속성과 SVG 내부 참조에 각 그림의 접두어를 붙인다.
function scopeSvgIds(svg: string, svgId: string): string {
  const tag = /<[a-z][\w:.-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi
  const attribute = /\s([\w:.-]+)="([^"]*)"/g
  const ids = new Map<string, string>()
  for (const match of svg.matchAll(tag)) {
    for (const [, name, value] of match[0].matchAll(attribute)) {
      if (name === 'id' && value !== svgId && !value.startsWith(`${svgId}-`)) {
        ids.set(value, `${svgId}-${value}`)
      }
    }
  }
  if (ids.size === 0) return svg
  const scoped = svg.replace(tag, (markup) => markup.replace(attribute, (attr, name: string, value: string) => {
    if (name === 'id') return ` id="${ids.get(value) ?? value}"`
    if (name === 'aria-labelledby' || name === 'aria-describedby') {
      return ` ${name}="${value.replace(/\S+/g, (id) => ids.get(id) ?? id)}"`
    }
    if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) {
      return ` ${name}="#${ids.get(value.slice(1)) ?? value.slice(1)}"`
    }
    return attr
  }))
  return scoped.replace(/url\((['"]?)#([^'")\s]+)\1\)/g, (ref, quote: string, id: string) =>
    ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : ref)
}

function main(file: string): number {
  const html = readFileSync(file, 'utf8')
  const blocks = findBlocks(html)
  if (blocks.length === 0) return 0
  const chrome = findChrome()
  if (!chrome) {
    console.error('설치된 Chrome 을 찾지 못해 Mermaid 코드 블록을 그대로 두었다. REPORT_CHROME_PATH 로 실행 파일을 지정할 수 있다.')
    return 1
  }

  const dir = mkdtempSync(join(tmpdir(), 'report-mermaid-'))
  try {
    writeFileSync(join(dir, 'puppeteer.json'), JSON.stringify({ executablePath: chrome }))
    writeFileSync(join(dir, 'mermaid.json'), JSON.stringify({ look: 'handDrawn', htmlLabels: false }))
    const parts: string[] = []
    let offset = 0
    let failed = false
    for (const block of blocks) {
      if (/^\s*(?:flowchart|graph)\b/m.test(block.source) && !/^\s*classDef\s/m.test(block.source)) {
        console.warn(`${file}:${block.line}: classDef 로 노드 종류마다 색을 지정한다.`)
      }
      try {
        const svg = render(block.source, dir)
        parts.push(html.slice(offset, block.start), svg)
        offset = block.end
      } catch (error) {
        failed = true
        console.error(`${file}:${block.line}: Mermaid 렌더링에 실패해 코드 블록을 그대로 두었다. ${String(error)}`)
      }
    }
    if (offset > 0) writeFileSync(file, parts.join('') + html.slice(offset))
    return failed ? 1 : 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  if (process.argv.length !== 3) throw new Error('사용법: render-mermaid.ts 보고서.html')
  process.exitCode = main(process.argv[2])
} catch (error) {
  console.error(String(error))
  process.exitCode = 2
}
