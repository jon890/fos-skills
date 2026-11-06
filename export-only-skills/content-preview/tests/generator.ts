// 두 생성기 테스트가 함께 쓰는 실행기와 HTML 읽기. Node 내장 모듈만 쓴다.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, tempDir, type Result } from './helpers.ts'

export type Generated = Result & { html: string; out: string; dir: string }

// args 에 --out 이 없으면 임시 폴더의 preview.html 로 낸다. 생성기를 실행하기 전 out 에 stale 이 있으면 지워지는지 볼 수 있게 dir 을 돌려준다
export function generate(command: string[], args: string[], opts: { input?: string; dir?: string; stale?: string } = {}): Generated {
  const dir = opts.dir ?? tempDir('content-preview-')
  const out = join(dir, 'preview.html')
  if (opts.stale !== undefined) writeFileSync(out, opts.stale)
  const full = args.includes('--out') ? args : [...args, '--out', out]
  const done = run([...command, ...full], { input: opts.input })
  return { ...done, out, dir, html: existsSync(out) ? readFileSync(out, 'utf8') : '' }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" }
export const unescapeHtml = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (m) => ENTITIES[m])

// 링크 주소, role=alert 개수, 태그를 뗀 글. Python 의 html.parser 로 하던 검사를 정규식으로 한다
export function parsePreview(source: string) {
  const links = [...source.matchAll(/<a\b[^>]*?\bhref="([^"]*)"/g)].map((m) => unescapeHtml(m[1]))
  const alerts = [...source.matchAll(/<[^>]*\brole="alert"[^>]*>/g)].length
  const text = unescapeHtml(source.replace(/<[^>]*>/g, ''))
  return { links, alerts, text }
}
