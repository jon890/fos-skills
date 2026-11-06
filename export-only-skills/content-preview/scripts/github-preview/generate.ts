#!/usr/bin/env node
// GitHub issue/PR 본문 미리보기 HTML 생성기.
//
// GitHub 은 본문을 GitHub Flavored Markdown 으로 렌더링한다. 같은 모양을 재현하기 위해
// github-markdown-css 와 marked.js 를
// 쓰는 템플릿에 markdown 을 흘려 넣어 등록 전 본문을 실제 화면과 비슷하게 검토한다.
//
// Dooray 미리보기(scripts/dooray-preview/) 와 같은 구조이고 viewer 엔진만 다르다.
//
// 사용 예:
//     node scripts/github-preview/generate.ts \
//         --type issue \
//         --repo "<owner>/<repo>" \
//         --title "<issue 또는 PR 제목>" \
//         --md-file "$PREVIEW_DIR/body.md" \
//         --out "$PREVIEW_DIR/preview.html"
//     node scripts/show-preview.ts "$PREVIEW_DIR/preview.html"
//
// 옵션: --type {issue,pr}(기본 issue), --repo, --title(필수), --md-file(필수, '-' 는 stdin), --out(필수)
// 종료 코드: 0 성공, 1 본문에 '</script>' 가 있거나 읽지 못함, 2 사용법 오류
//
// 주의:
// - markdown 본문에 '</script>' 문자열이 있으면 안 된다 (text/markdown 블록이 깨진다).
// - CDN 로드라 오프라인에서는 스타일이 빠진 채 보인다.
// - GitHub 고유 자동링크(#번호)·@mention·:emoji: 코드는 marked.js 가 GitHub 처럼 변환하지
//   않는다 (유니코드 emoji 는 그대로 표시됨). 정확한 GFM 은 등록 후 GitHub 에서 확인.

import { join } from 'node:path'
import { parseCli, type Spec } from '../cli.ts'
import { isMain, readStdin, write } from '../io.ts'
import { pyReadText } from '../kit/py.ts'
import { clearOutput, escapeHtml, writeOutput } from '../preview_output.ts'

const TEMPLATE = join(import.meta.dirname, 'template.html')

const TYPE_MAP: Record<string, [string, string]> = {
  issue: ['issue', 'Issue'],
  pr: ['pr', 'Pull Request'],
}

const PROG = 'generate.ts'
const USAGE = `usage: ${PROG} [-h] [--type {issue,pr}] [--repo REPO] --title TITLE
                   --md-file MD_FILE --out OUT
`
const SPEC: Spec = {
  prog: PROG,
  usage: USAGE,
  help: `${USAGE}
GitHub issue/PR 본문 미리보기 HTML 생성

options:
  -h, --help         show this help message and exit
  --type {issue,pr}  본문 종류
  --repo REPO        저장소 (예: <owner>/<repo>)
  --title TITLE      issue/PR 제목
  --md-file MD_FILE  본문 markdown 파일 경로 ('-' 는 stdin)
  --out OUT          출력 HTML 경로
`,
  options: {
    type: { type: 'string', choices: ['issue', 'pr'] },
    repo: { type: 'string' },
    title: { type: 'string', required: true },
    'md-file': { type: 'string', required: true },
    out: { type: 'string', required: true },
  },
}

// str.replace 처럼 모두 바꾼다. 바꿀 글자의 $& 같은 표기를 해석하지 않는다
const replaceAll = (text: string, from: string, to: string) => text.split(from).join(to)

export function main(argv: string[]): number {
  const parsed = parseCli(argv, SPEC)
  if ('exit' in parsed) return parsed.exit
  const args = parsed.values as { type?: string; repo?: string; title: string; 'md-file': string; out: string }
  clearOutput(args.out)

  const md = args['md-file'] === '-' ? readStdin() : pyReadText(args['md-file'])

  if (md.includes('</script>')) {
    write(2, "오류: 본문에 '</script>' 가 포함되어 미리보기가 깨진다. 본문을 수정하라.\n")
    return 1
  }

  const [typeClass, typeLabel] = TYPE_MAP[args.type ?? 'issue']

  // 앞 단계가 넣은 글자도 뒤 단계가 다시 바꾼다(옛 구현의 연쇄 replace). 본문은 마지막에 넣어 표기가 그대로 남는다
  let out = pyReadText(TEMPLATE)
  out = replaceAll(out, '{{TITLE}}', escapeHtml(args.title))
  out = replaceAll(out, '{{REPO}}', escapeHtml(args.repo ?? ''))
  out = replaceAll(out, '{{TYPE_CLASS}}', typeClass)
  out = replaceAll(out, '{{TYPE_LABEL}}', typeLabel)
  out = replaceAll(out, '{{MD_BODY}}', md)
  writeOutput(args.out, out)
  write(1, `생성 완료: ${args.out}\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
