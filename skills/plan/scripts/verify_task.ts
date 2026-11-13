#!/usr/bin/env node
// task 생성 직후 자동 검증.
//
// index 스키마, 변경 파일 상태, 같은 phase 의 테스트 실행 지시와
// 스킬 번들 cwd, 사람 의존 검증, 필수 절, BSD sed 를 검사한다.
// `remote-verification.md` 가 있으면 선행 조건과 시점 열의 값을 검사하고 명령 칸의 원격 접속 형태를 경고한다.
// 변경 파일 표의 glob 행은 종류 칸에 `신규·수정` 을 써서 신규와 수정이 섞인 묶음을 적을 수 있다. 구체 경로에는 쓰지 못한다.
// 작업 항목이 호출 형태(`name()`)로 적은 함수를 수정 파일이 정의하면, 그 함수를 부르는 파일 중
// plan 의 변경 파일에 없는 것을 git grep 으로 찾아 경고한다.
// Python 테스트 파일 이름이 모듈 이름이 될 수 없으면 경로로 직접 실행하는지 본다.
// `bun test` 의 점 디렉터리 경로와 금지 문자열 검사가 같은 phase 의 테스트에 걸리는지도 본다.
// 같은 접두사와 번호를 다른 계획 디렉터리가 쓰면(`plan12-a` 와 `plan12-b`) 알린다.
// 검사하는 계획이 아직 커밋 전이면 위반이고, 이미 커밋된 계획끼리 겹치면 경고다.
// 새 겹침만 막고, 이미 진행 중인 계획의 폴더 이름을 바꾸게 하지 않는다.
// phase 안 Markdown 상대 링크는 phase 파일 위치 기준으로 풀어 없는 파일이면 위반이다.
// 변경 파일 표에 「신규」 로 적은 docs 가 커밋 전 파일이면(4단계에서 먼저 쓴 것) 위반 대신 경고다.
// 작업 트리와 로컬, 원격 브랜치의 tasks 디렉터리를 본다. 보고에서 phase 번호가 어느 계획인지 갈리지 않게 된다.
// index.json 의 pr_scope(한 문장)와 deferred(뒤로 미룬 일) 칸을 보고, phase 가 6개를 넘으면 plan 을 나누게 한다.
// 변경 파일이 40개를 넘으면 경고한다. 기준은 references/plan-size.md 가 소유한다.
// 레포 설정에 「PR 변경 파일 상한」 이 있으면 40개 대신 그 값과 비교하고, 「파일 길이 상한」 이 있으면
// 상한에 가까운 수정 파일을 경고한다. 값의 형식은 references/monorepo.md 의 「스크립트가 직접 읽는 값」 이 소유한다.
// `claude plugin test [dir]` 은 dir 아래의 `*.test.ts`, `*.test.tsx` 를 모두 실행하는 테스트 명령으로 본다.
// 완료 표시는 요구하지 않는다. 계획의 수명은 references/plan-lifecycle.md 가 정한다.
// 계획에 적힌 명령은 실행하지 않는다.
//
// 사용법:
//     node scripts/verify_task.ts PLAN
//     node scripts/verify_task.ts PLAN --audit
//     node scripts/verify_task.ts fe-plan27-login --tasks-dir tasks
//     node scripts/verify_task.ts --staged tasks/PLAN/phase-01.md
//
// 기본 검사는 구현 전 파일 상태를 대조한다. --audit 는 구현 후 문서 검사라
// 신규/수정/삭제 파일의 현재 존재 조건을 대조하지 않는다.
// --staged 는 git index 와 phase 변경 파일 목록을 대조한다.
// 같은 계획 폴더 바로 아래 index.json 과 phase-*.md 는 계획 메타데이터로 분리한다.
// 메타데이터만 staged 되어 있으면 구현 파일 누락을 검사하지 않는다. 구현 변경은 현재 index 만 대조한다.
// 테스트 범위, 실패 전파, 식별자와 스키마의 일치는 사람이 확인한다.
//
// cwd 는 타깃 레포 root 여야 한다. 계획서 디렉터리는 --tasks-dir 로 바꾼다 (기본값 tasks).
// 모노레포의 근거 문서는 `frontend/docs/flow.md` 처럼 하위 프로젝트의 docs 경로도 받는다.
// 경로는 이 스킬 번들 기준 상대경로다. 하네스가 알려주는 base 디렉터리에 붙여 쓴다.
//
// 옵션은 argparse 처럼 긴 옵션의 고유한 접두(--aud)와 `--옵션=값` 을 받는다. 모르는 옵션은 사용법 오류(2)다.
//
// 종료 코드
//     0  위반 없음 (경고는 별도 출력)
//     1  위반 발견 (내용은 stdout 으로 출력)
//     2  검사를 돌리지 못함 (인자 오류, 디렉터리 없음, JSON 파싱 실패)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { capture, isExpected, isMain, readTextFile, ValueError, write } from './io.ts'
import { type Spec, parseCli, UsageError } from './cli.ts'
import { run as checkFeature } from './check_feature.ts'
import * as overlayValues from './overlay_values.ts'
import { subprojects } from './overlay_paths.ts'
import {
  fnmatchcase,
  PyRegExp,
  pyre,
  globRel,
  isAbsolutePath,
  lstripPy,
  pathName,
  pathParts,
  pathParent,
  pathStem,
  pathSuffix,
  pjoin,
  posixJoin,
  posixNormpath,
  pyPath,
  pyRepr,
  pyStrAny,
  shlexSplit,
  unquote,
  urlsplitPath,
} from './pylike.ts'
import { pyInt, pyLen, pyReadText, pySplitLines, pyStrCompare, pyStrip, normalizeNewlines } from './kit/py.ts'

// task 생성 시 phase 파일에 필요한 필수 절을 검사한다
const REQUIRED_SECTIONS = ['## 목표', '**범위 외**', '## 작업 항목', '## 검증']

// 스키마에 없는 키. 실행 순서는 사용자 보고로 전달하고 task 파일에 넣지 않는다
const FORBIDDEN_KEYS = ['depends_on', 'related_docs', 'prerequisites']

// plan 하나는 PR 하나로 끝나는 크기다. 기준은 references/plan-size.md 가 소유한다
export const MAX_PHASES = 6
export const MAX_CHANGED_FILES = 40
// 레포 설정이 파일 길이 상한을 주면, 수정할 파일이 상한의 이 비율 이상일 때 경고한다
const FILE_LENGTH_RATIO = 0.95
// 이 날짜 이후에 만든 plan 만 pr_scope, deferred 칸과 phase 수 상한을 위반으로 센다
const PR_SCOPE_FROM = '2026-10-25'
const DEFERRED_KEYS = ['what', 'why', 'after']

const PROFILES = new Set(['fast', 'standard', 'deep'])
const MODELS = new Set(['haiku', 'sonnet', 'opus'])

const VAGUE_SCOPE = pyre(/전체\s*(?:수정|변경|적용|교체|리팩토링|삭제)/g)
// 「전체 삭제 경로」 처럼 뒤에 명사가 이어지면 수식어라 범위 지시가 아니다.
// 바로 붙은 조사, 또는 떨어져 있어도 서술어로 이어지면 범위 지시로 본다. 목록에 없는 어미는 오탐으로 남는다
const VAGUE_SCOPE_TAIL = pyre(/^(?:(?:[을를은는이가도만과와에]|으로|로|에서|및)|\s*(?:하|한|할|해|합|되|된|될|시키|시켜))/)
const PLAN_NUMBER = /^(.*?)plan(\p{Nd}+)-/u
const HUMAN_CHECK = pyre(/수동\s*(?:검토|확인|검증)|눈으로\s*확인|직접\s*확인|육안/)
const BSD_SED = pyre(/sed\s.*\\b/)
// 모노레포는 하위 프로젝트마다 docs 를 둔다. 루트 기준 경로의 어느 조각이든 `docs` 면 근거 문서로 본다
const DOC_PATH = pyre(/`((?:[A-Za-z0-9_.-]+\/)*docs\/[^`\s]+)`/g)
const TEST_DIRS = new Set(['test', 'tests', '__tests__'])
// `-spec.js` 는 테스트 이름이 아니다. `bottom-panel-spec.js` 같은 운영 코드의 이름이라 spec 은 `.spec.ts` 와 `_spec.rb` 처럼 `.` 나 `_` 로 이은 것만 본다
const TEST_NAME = /^test[_-]|(?:Test|Tests)\.[^.]+$|[._-]test\.[^.]+$|[._]spec\.[^.]+$/
// 테스트 디렉터리 안에서만 테스트로 보는 이름이다. `UserSpec.java`, `AppIT.java` 같은 JVM 규칙이다
const RUNNABLE_NAME = /(?:Spec|IT)\.[^.]+$/
const BUNDLE = /\$(?:SKILL_DIR|\{SKILL_DIR\})|~\/\.(?:claude|codex)\/skills|\$HOME\/\.(?:claude|codex)\/skills/
const CODE_SUFFIXES = new Set(['.java', '.kt', '.groovy', '.scala', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.cs', '.rb', '.php', '.swift', '.sh', '.bash', '.c', '.cpp'])
const SHELL = new Set(['', 'bash', 'sh', 'shell', 'zsh'])
// 「다음 케이스」 처럼 phase 와 무관한 「다음」 은 미루기가 아니다. 다른 phase 나 plan 을 가리키는 구절만 본다
const DEFER_TEST = pyre(/(?=.*(?:테스트|회귀\s*검증))(?=.*(?:(?:다음|후속|이후)\s*(?:phase|단계|plan)|나중에?))(?=.*(?:작성|추가|미루|미룬|넘기|넘긴|진행|수행|다루|다룬|구현|보강|처리))/i)
const NOT_DEFERRED = pyre(/(?:미루|넘기)지\s*(?:않|말)/)
const HUMAN_ONLY = pyre(/(?:사람이|담당자가|사용자가)\s*(?:확인|검토|판정)|화면(?:에서|을)\s*(?:확인|검토)/)

export type Entry = [rel: string, action: string]
type Command = string[]

// 테스트 디렉터리 아래 파일, 또는 테스트 이름을 가진 코드 파일이다.
// `UserSpec.java` 같은 운영 코드와 `docs/specs/` 문서는 테스트가 아니다
export function isTest(rel: string): boolean {
  const parts = (rel.startsWith('./') ? rel.slice(2) : rel).split('/')
  const dirs = parts.slice(0, -1)
  if (dirs.some((p) => TEST_DIRS.has(p)) || TEST_DIRS.has(parts.at(-1)!)) return true
  const name = parts.at(-1)!
  if (dirs.at(-1) === 'scripts' && /^test-/.test(name)) return false
  if (!(CODE_SUFFIXES.has(pathSuffix(name)) || isGlob(name))) return false
  return dirs.some((p) => p === 'spec' || p === 'specs') || TEST_NAME.test(name)
}

// 테스트 실행기가 직접 실행하는 테스트다. 테스트 디렉터리의 fixture, fake, helper, conftest 는 뺀다.
// 이름으로 판정하지 못하는 glob 과 테스트 디렉터리 자체는 실행 대상으로 둔다
export function runnableTest(rel: string): boolean {
  if (!isTest(rel)) return false
  const trimmed = (rel.startsWith('./') ? rel.slice(2) : rel).replace(/\/+$/, '')
  const parts = trimmed.split('/')
  if (parts.some((part, i) => ['fixture', 'fixtures', '__fixtures__'].includes(part) && parts.slice(0, i).some((p) => TEST_DIRS.has(p)))) return false
  const name = parts.at(-1)!
  if (TEST_DIRS.has(name) || isGlob(name)) return true
  return CODE_SUFFIXES.has(pathSuffix(name)) && (TEST_NAME.test(name) || RUNNABLE_NAME.test(name))
}

type Fence = { n: number; line: string; kind: 'open' | 'code' | 'close' | 'text'; language: string }

// 줄 번호, 줄, 종류, 언어를 낸다. 종류는 open, code, close, text 다.
// 닫는 fence 는 여는 fence 와 같은 문자로 같은 길이 이상이어야 한다
export function fences(text: string): Fence[] {
  const out: Fence[] = []
  let fence: string | null = null
  let language = ''
  pySplitLines(text).forEach((line, index) => {
    const n = index + 1
    if (fence === null) {
      const marker = pyre(/^\s*(`{3,}|~{3,})\s*([\p{L}\p{N}_+-]*)/u).exec(line)
      if (marker) {
        fence = marker[1]
        language = marker[2].toLowerCase()
        out.push({ n, line, kind: 'open', language })
      } else out.push({ n, line, kind: 'text', language: '' })
      return
    }
    const marker = pyre(/^\s*(`{3,}|~{3,})\s*$/).exec(line)
    if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
      fence = null
      out.push({ n, line, kind: 'close', language })
    } else out.push({ n, line, kind: 'code', language })
  })
  return out
}

// 코드 블록 속 제목은 절 구분자로 쓰지 않는다
export function section(text: string, name: string): string {
  const lines: string[] = []
  let active = false
  for (const { line, kind } of fences(text)) {
    if (kind === 'text' && line.startsWith('## ')) {
      if (active) break
      active = pyStrip(line) === `## ${name}`
      continue
    }
    if (active) lines.push(line)
  }
  return lines.join('\n')
}

export function codeBlocks(text: string): { start: number; language: string; body: string }[] {
  const out: { start: number; language: string; body: string }[] = []
  let lines: string[] = []
  let start = 0
  for (const { n, line, kind, language } of fences(text)) {
    if (kind === 'open') {
      lines = []
      start = n
    } else if (kind === 'code') lines.push(line)
    else if (kind === 'close') out.push({ start, language, body: lines.join('\n') })
  }
  return out
}

function manifest(path: string, text: string, out: string[], warnings: string[]): Entry[] {
  let body = section(text, '변경 파일')
  if (!body && section(text, 'Critical Files')) {
    body = section(text, 'Critical Files')
    warnings.push(`${path} — Critical Files 는 읽기 호환이다. 새 계획은 변경 파일 절을 쓴다`)
  }
  if (!body) {
    out.push(`${path} — 변경 파일 절이 없다`)
    return []
  }
  const entries: Entry[] = []
  for (const line of pySplitLines(body)) {
    if (!lstripPy(line).startsWith('|') || !line.includes('`')) continue
    const stripped = pyStrip(line)
    let end = stripped.length
    let start = 0
    while (start < end && stripped[start] === '|') start++
    while (end > start && stripped[end - 1] === '|') end--
    const cells = stripped.slice(start, end).split('|')
    if (cells.length !== 2) {
      out.push(`${path} — 변경 파일 행은 파일과 변경 두 칸이어야 한다: ${line}`)
      continue
    }
    const files = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])
    const action = pyre(/^\s*(신규·수정|신규|수정|삭제)(?:\s|$|\()/).exec(cells[1])
    if (files.length !== 1 || !action) {
      out.push(`${path} — 변경 파일 행의 경로 또는 변경 종류가 잘못됐다. 변경 칸은 신규, 수정, 삭제, 신규·수정(glob 행) 중 하나로 시작하고 설명은 \`수정 (설명)\` 처럼 괄호나 공백 뒤에 붙인다: ${line}`)
      continue
    }
    const rel = files[0].startsWith('./') ? files[0].slice(2) : files[0]
    if (isAbsolutePath(rel) || pathParts(rel).includes('..') || rel.includes('$') || rel.startsWith('~')) {
      out.push(`${path} — 저장소 상대경로가 필요하다: ${rel}`)
      continue
    }
    if (action[1] === '신규·수정' && !isGlob(rel)) {
      // 구체 경로는 신규인지 수정인지 미리 정할 수 있다. 섞인 묶음만 glob 행에 적는다
      out.push(`${path} — 신규·수정은 glob 행에만 쓴다. 구체 경로는 신규나 수정 가운데 하나로 적는다: ${rel}`)
    }
    if (entries.some(([existing]) => existing === rel)) out.push(`${path} — 변경 파일 중복: ${rel}`)
    entries.push([rel, action[1]])
  }
  if (entries.length === 0) out.push(`${path} — 변경 파일 목록이 비었다`)
  return entries
}

// Next.js 동적 라우트 조각이다. `[id]`, `[...path]`, `[[...slug]]` 처럼 조각 전체가 대괄호다.
// 조각 전체를 문자 클래스로 쓰는 glob 은 한 글자 디렉터리만 맞아 계획서에 쓸 일이 없다
const DYNAMIC_SEGMENT = /^\[\[?(?:\.\.\.)?[^[\]/*?]+\]\]?$/

export const literalSegment = (part: string) => DYNAMIC_SEGMENT.test(part)

// 생략 경로 위반 뒤에 붙는 안내다. 파일이 많아 적기 힘들면 glob 으로 적는다
const OMIT_HINT = ' (여러 파일은 glob 행으로 적고, 신규와 수정이 섞이면 종류 칸에 `신규·수정` 을 쓴다)'

// glob 행의 종류가 staged 변경 종류를 받는지 본다. `신규·수정` 은 신규와 수정을 받는다
const accepts = (kind: string, action: string) => kind === action || (kind === '신규·수정' && (action === '신규' || action === '수정'))

// `src/.../App.java` 처럼 생략한 경로다. 동적 라우트 조각 안의 `...` 는 생략이 아니다
export const omitted = (rel: string) => rel.split('/').some((part) => (part.includes('...') || part.includes('…')) && !literalSegment(part))

// 동적 라우트 조각을 escape 해 glob 으로 넘긴다
const globPattern = (rel: string) => rel.split('/').map((part) => (literalSegment(part) ? part.replaceAll('[', '[[]') : part)).join('/')

// * 는 한 경로 조각, ** 는 0개 이상의 디렉터리를 나타낸다. 동적 라우트 조각은 문자 그대로 대조한다
export function matches(rel: string, pattern: string): boolean {
  const parts = rel.split('/')
  const patterns = globPattern(pattern).split('/')
  const match = (i: number, j: number): boolean => {
    if (j === patterns.length) return i === parts.length
    if (patterns[j] === '**') return match(i, j + 1) || (i < parts.length && match(i + 1, j))
    return i < parts.length && fnmatchcase(parts[i], patterns[j]) && match(i + 1, j + 1)
  }
  return match(0, 0)
}

const legacyManifest = (text: string) => !section(text, '변경 파일') && Boolean(section(text, 'Critical Files'))

export const isGlob = (rel: string) => rel.split('/').some((part) => /[*?[]/.test(part) && !literalSegment(part))

// 4단계에서 먼저 쓴 docs 다. docs 아래이고 git 저장소에서 HEAD 에 아직 없는 파일이다
function uncommittedDocs(repo: string, rel: string): boolean {
  if (!(rel.startsWith('docs/') || rel.includes('/docs/'))) return false
  if (capture(['git', '-C', repo, 'rev-parse', '--git-dir']).code !== 0) return false
  return capture(['git', '-C', repo, 'cat-file', '-e', `HEAD:${rel}`]).code !== 0
}

// 앞 phase 의 생성과 삭제를 적용한 파일 상태로 대조한다.
//
// 생략 경로는 커밋 전 staged 대조에서 막히므로 「변경 파일」 절에서는 생성 때 위반이다. Critical Files 는 읽기 호환이라 경고로 둔다.
// created 는 앞 phase 가 신규로 선언한 glob 이다. 뒤 phase 가 그 glob 과 겹치는 경로나 glob 을
// 수정하거나 삭제하면 존재로 본다. 앞 phase 가 삭제한 경로와 glob 은 virtual 에 false 로 남아 계속 위반이다
function checkFileState(path: string, entries: Entry[], repo: string, virtual: Map<string, boolean>, out: string[], warnings: string[], legacy = false, created: string[] = []): void {
  for (const [rel, action] of entries) {
    if (omitted(rel)) {
      if (legacy) warnings.push(`${path} — 생략 경로는 존재를 대조하지 않는다: ${rel}`)
      else out.push(`${path} — 변경 파일에는 생략하지 않은 경로가 필요하다: ${rel}${OMIT_HINT}`)
      continue
    }
    const glob = isGlob(rel)
    if (action === '신규·수정') {
      // 신규일 수도 수정일 수도 있어 존재 조건을 정할 수 없다. 뒤 phase 가 겹치는 경로를 존재로 보게 glob 만 기억한다
      if (glob) created.push(rel)
      continue
    }
    const candidates = new Set<string>(glob ? globRel(repo, globPattern(rel)) : [rel])
    for (const p of virtual.keys()) if (!isGlob(p) && matches(p, rel)) candidates.add(p)
    let exists = [...candidates].some((p) => (virtual.has(p) ? virtual.get(p)! : existsSync(`${repo}/${p}`)))
    const deleted = [...virtual].filter(([, alive]) => alive === false).map(([p]) => p)
    let coveredBy: string | undefined
    if (!exists && !deleted.some((p) => matches(rel, p))) {
      // glob 끼리는 한쪽 문자열을 경로로 보고 다른 쪽에 맞춰 포함 관계를 판정한다
      coveredBy = created.find((pattern) => matches(rel, pattern) || matches(pattern, rel))
      exists = coveredBy !== undefined
    }
    if (action === '신규' && glob) {
      warnings.push(`${path} — 신규 glob 은 구체 파일의 부재를 보장하지 못한다: ${rel}`)
      created.push(rel)
    } else if (action === '신규' && exists && uncommittedDocs(repo, rel)) {
      warnings.push(`${path} — 4단계에서 먼저 쓴 docs 로 보여 신규 존재를 허용한다: ${rel} (이미 쓴 docs 는 변경 파일 표에 넣지 않는다)`)
    } else if (action === '신규' && exists && coveredBy !== undefined) {
      out.push(`${path} — 앞 phase 의 glob ${coveredBy} 이 이미 덮는다: ${rel} (glob 을 좁히거나 수정으로 적는다)`)
    } else if (action === '신규' && exists) {
      out.push(`${path} — 신규 파일이 이미 존재한다: ${rel} (구현 후 검사는 --audit)`)
    } else if ((action === '수정' || action === '삭제') && !exists) {
      out.push(`${path} — ${action} 파일이 존재하지 않는다: ${rel} (선행 계획이 만들 파일이면 그 계획이 머지된 뒤 기준 브랜치로 rebase 해 다시 돌린다)`)
    }
    if (action === '삭제' && glob) {
      for (const candidate of candidates) virtual.set(candidate, false)
      virtual.set(rel, false)
    }
  }
  // 같은 phase 의 신규 선언으로 그 phase 의 수정 오류를 숨기지 않는다
  for (const [rel, action] of entries) if (!omitted(rel) && !isGlob(rel)) virtual.set(rel, action !== '삭제')
}

// orch 의 무거운 검사 감싸기다. `orch slot heavy|mem [--exclusive] -- <명령>` 과 옛 꼴 `heavy-slot|mem-gate [옵션] -- <명령>` 이다
// 대기열만 거칠 뿐 안쪽 명령을 그대로 실행하므로 `--` 뒤를 안쪽 명령으로 읽는다. 명령을 읽는 단계에서 벗겨 뒤의 모든 검사가 안쪽 명령을 본다
export function slotInner(command: Command): Command | null {
  const head = pathName(command[0])
  const legacy = head === 'heavy-slot' || head === 'mem-gate'
  if (!legacy && !(head === 'orch' && command[1] === 'slot' && (command[2] === 'heavy' || command[2] === 'mem'))) return null
  const dash = command.indexOf('--')
  return dash < 0 || dash === command.length - 1 ? null : command.slice(dash + 1)
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z_0-9]*=/

// 프로그램 위치를 읽는다. 논리 줄 번호도 낸다. echo/grep 에 적힌 테스트 이름은 실행이 아니다
export function shellCommands(text: string): { line: number; command: Command }[] {
  const out: { line: number; command: Command }[] = []
  for (const { start, language, body } of codeBlocks(text)) {
    if (!SHELL.has(language)) continue
    pySplitLines(body.replaceAll('\\\n', ' ')).forEach((line, index) => {
      const offset = index + 1
      let tokens: string[]
      try {
        tokens = shlexSplit(line)
      } catch {
        return
      }
      let command: string[] = []
      for (const token of [...tokens, ';']) {
        if (token !== '' && [...token].every((c) => ';&|()'.includes(c))) {
          if (command.length) {
            while (command.length && ASSIGNMENT.test(command[0])) command.shift()
            if (command[0] === 'env') {
              command.shift()
              while (command.length && ASSIGNMENT.test(command[0])) command.shift()
            }
            if (command.length) out.push({ line: start + offset, command: slotInner(command) ?? command })
          }
          command = []
        } else command.push(token)
      }
    })
  }
  return out
}

const commandsOf = (text: string): Command[] => shellCommands(text).map((c) => c.command)

// 실행기 앞에 붙어 뒤 명령을 그대로 실행하는 접두어다. 벗긴 뒤 판정한다
const WRAPPERS: string[][] = [['npx'], ['bunx'], ['uv', 'run'], ['poetry', 'run'], ['pipenv', 'run'], ['bundle', 'exec'], ['pnpm', 'exec'], ['pnpm', 'dlx'], ['yarn', 'exec'], ['yarn', 'dlx']]
const WRAPPER_VALUE_OPTIONS = new Set(['--with', '--python', '--project', '--directory', '--package', '--from', '-p'])
// 패키지 관리자에서 값을 받는 옵션이다. 옵션을 건너뛰고 스크립트 이름을 찾는다
const VALUE_OPTIONS = new Map<string, Set<string>>([
  ['npm', new Set(['--prefix', '-w', '--workspace'])],
  ['pnpm', new Set(['--filter', '-F', '-C', '--dir'])],
  ['yarn', new Set(['--cwd'])],
  ['bun', new Set(['--cwd', '--filter'])],
])
const TEST_RUNNERS = new Set(['pytest', 'pytest-3', 'tox', 'nox', 'jest', 'vitest', 'mocha', 'rspec', 'phpunit', 'ctest'])
// 테스트를 실행하지 않는다고 알려진 명령이다. 여기에도 실행기에도 없는 명령은 판정하지 못해 경고로 둔다
const NON_TEST = new Set([
  'echo', 'printf', 'cat', 'ls', 'cd', 'pwd', 'git', 'grep', 'rg', 'egrep', 'sed', 'awk', 'find', 'jq', 'curl',
  'wc', 'head', 'tail', 'diff', 'cmp', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'export', 'source', '.', 'set',
  'sleep', 'exit', 'true', 'false', ':', 'test', '[', 'ruff', 'flake8', 'pylint', 'mypy', 'black', 'isort',
  'eslint', 'prettier', 'tsc', 'shellcheck', 'shfmt', 'docker', 'kubectl',
])
const KNOWN = new Set([...TEST_RUNNERS, ...VALUE_OPTIONS.keys(), 'python', 'python3', 'gradlew', 'gradle', 'mvn', 'mvnw', 'go', 'cargo', 'deno', 'dotnet', 'make', 'gmake', 'bash', 'sh'])
// node 에서 값을 따로 받는 옵션이다. `--test` 가 스크립트 이름보다 앞에 있는지 볼 때 건너뛴다
const NODE_VALUE_OPTIONS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C'])

// `node [옵션] <스크립트> [인자...]` 의 스크립트 경로다. 없으면 null 이다
function nodeScript(args: string[]): string | null {
  let skip = false
  for (const arg of args) {
    if (skip) skip = false
    else if (NODE_VALUE_OPTIONS.has(arg)) skip = true
    else if (!arg.startsWith('-')) return arg
  }
  return null
}

// `node [옵션] --test [파일...]` 이다. 스크립트 이름 뒤의 `--test` 는 스크립트 인자다
function nodeTest(args: string[]): boolean {
  let skip = false
  for (const arg of args) {
    if (skip) skip = false
    else if (arg === '--test') return true
    else if (NODE_VALUE_OPTIONS.has(arg)) skip = true
    else if (!arg.startsWith('-')) return false
  }
  return false
}

export function unwrap(commandIn: Command): Command {
  const command = [...commandIn]
  for (const prefix of WRAPPERS) {
    const head = command.slice(0, prefix.length).map((t, i) => (i === 0 ? pathName(t) : t))
    if (head.length === prefix.length && head.every((t, i) => t === prefix[i])) {
      command.splice(0, prefix.length)
      while (command.length && command[0].startsWith('-')) {
        const option = command.shift()!
        if (WRAPPER_VALUE_OPTIONS.has(option) && command.length) command.shift()
      }
      return unwrap(command)
    }
  }
  return command
}

// 패키지 관리자의 옵션을 건너뛴 나머지 인자를 낸다
export function positional(program: string, args: string[]): string[] {
  let rest: string[] = []
  let skip = false
  for (const arg of args) {
    if (skip) skip = false
    else if (VALUE_OPTIONS.get(program)?.has(arg)) skip = true
    else if (!arg.startsWith('-') || rest.length) rest.push(arg)
  }
  if (program === 'yarn' && rest[0] === 'workspace') rest = rest.slice(2)
  return rest
}

// npm 스크립트 본문이 다른 스크립트를 부를 때 따라가는 깊이다
const SCRIPT_DEPTH = 3

// `<cwd>/package.json` 의 `scripts.<script>` 본문에 테스트 명령이 하나라도 있는지 본다.
// 파일이나 이름이 없으면 false 다. 구현 전 계획이라도 package.json 은 이미 있는 파일이라 읽는다
function packageScriptIsTest(script: string, entries: Entry[], repo: string, cwd: string, depth: number): boolean {
  if (depth >= SCRIPT_DEPTH) return false
  let body: unknown
  try {
    const data = JSON.parse(pyReadText(cwd ? `${repo}/${cwd}/package.json` : `${repo}/package.json`)) as unknown
    const scripts = (data as { scripts?: Record<string, unknown> }).scripts
    body = (scripts as Record<string, unknown>)[script]
  } catch {
    return false
  }
  if (typeof body !== 'string') return false
  return commandsOf(`\`\`\`bash\n${body}\n\`\`\``).some((inner) => classify(inner, entries, repo, cwd, depth + 1) === 'test')
}

export type Kind = 'test' | 'other' | 'unknown'

// test, other, unknown 중 하나를 낸다. unknown 은 판정하지 못한 실행기다.
//
// cwd 는 같은 줄의 `cd <dir>` 가 가리키는 저장소 루트 기준 경로다. 스크립트 경로를 그 기준으로 풀어 파일 존재를 본다.
// npm 스크립트 이름이 test 로 보이지 않으면 cwd 의 package.json 본문을 읽어 한 번 더 판정한다. depth 는 그때 따라간 단계다
export function classify(commandIn: Command, entries: Entry[], repo: string, cwd = '', depth = 0): Kind {
  const command = unwrap(commandIn)
  if (command.length === 0) return 'other'
  const program = pathName(command[0])
  const args = command.slice(1)
  if (args.some((a) => ['--skipTests', '-DskipTests', '-Dmaven.test.skip=true', '--collect-only', '--help', '--dry-run'].includes(a) || (a.startsWith('-DskipTests=') && a !== '-DskipTests=false'))) return 'other'
  if (program === 'gradlew' || program === 'gradle') {
    const excluded: string[] = []
    args.slice(0, -1).forEach((arg, i) => {
      if (arg === '-x' || arg === '--exclude-task') excluded.push(args[i + 1])
    })
    for (const arg of args) if (arg.startsWith('--exclude-task=')) excluded.push(arg.slice(arg.indexOf('=') + 1))
    if (args.includes('-m') || excluded.some((task) => ['test', 'check'].includes(task.split(':').at(-1)!))) return 'other'
  }
  let found: boolean | null = null
  if (TEST_RUNNERS.has(program)) found = true
  else if ((program === 'python' || program === 'python3') && args[0] === '-m' && (args[1] === 'pytest' || args[1] === 'unittest')) found = true
  else if (program === 'playwright') found = args[0] === 'test'
  else if (program === 'gradlew' || program === 'gradle') found = args.some((a) => ['test', 'check', 'build'].includes(a.split(':').at(-1)!))
  else if (program === 'mvn' || program === 'mvnw') found = args.some((a) => ['test', 'verify', 'package', 'install'].includes(a))
  else if (VALUE_OPTIONS.has(program)) {
    let rest = positional(program, args)
    const explicitRun = rest[0] === 'run' || rest[0] === 'run-script'
    if (explicitRun) rest = rest.slice(1)
    else if (program === 'npm' && rest[0] === 'exec') rest = rest.slice(1)
    // `pnpm jest <파일>` 처럼 패키지 관리자가 테스트 실행기 bin 을 바로 부르는 형태다
    found = rest.length > 0 && (rest[0] === 'test' || rest[0].startsWith('test:') || rest[0] === 'jest' || rest[0] === 'vitest' || (rest[0] === 'playwright' && rest[1] === 'test'))
    // npm 과 bun 은 `run` 이 있어야 사용자 스크립트다. `npm install` 같은 하위 명령을 스크립트로 읽지 않는다
    if (!found && rest.length > 0 && (explicitRun || program === 'pnpm' || program === 'yarn')) found = packageScriptIsTest(rest[0], entries, repo, cwd, depth)
  } else if (program === 'node' && nodeTest(args)) found = true
  else if (['go', 'cargo', 'deno', 'dotnet'].includes(program)) found = args.length > 0 && args[0] === 'test'
  else if (program === 'claude') found = pluginTestDir(command) !== null
  else if (program === 'make' || program === 'gmake') found = args.some((a) => a === 'test' || a === 'check')
  if (found !== null) return found ? 'test' : 'other'
  let script = command[0]
  if (['bash', 'sh', 'python', 'python3'].includes(program)) {
    if (args.length === 0 || args[0].startsWith('-')) return 'other'
    script = args[0]
  } else if (program === 'node') {
    // node <스크립트> 도 bash·python 처럼 스크립트 경로로 판정한다. 경로가 없으면 판정하지 못한 명령이다
    script = nodeScript(args) ?? script
  } else if (NON_TEST.has(program)) return 'other'
  if (script.startsWith('./')) script = script.slice(2)
  if (!['scripts/', 'tests/', 'test/'].some((p) => script.startsWith(p))) return KNOWN.has(program) || script.includes('/') ? 'other' : 'unknown'
  const named = isTest(script) || /(?:^|\/)(?:check|verify|test)[_.-]/.test(script) || isRepoTestRunner(script)
  const rooted = cwd ? posixNormpath(posixJoin(cwd, script)) : script
  const available = isFile(`${repo}/${rooted}`) || entries.some(([rel, action]) => matches(rooted, rel) && action !== '삭제')
  return named && available ? 'test' : 'other'
}

// 저장소 테스트 실행기다. 인자로 준 파일·폴더가 실행 범위다
const REPO_TEST_RUNNER = /(?:^|\/)scripts\/run-tests\.(?:ts|js|mjs|cjs)$/
const isRepoTestRunner = (script: string) => REPO_TEST_RUNNER.test(script)

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export const testCommand = (command: Command, entries: Entry[], repo: string, cwd = '') => classify(command, entries, repo, cwd) === 'test'

// 디렉터리 인자를 하위 테스트 전체로 받는 실행기다. jest 와 vitest 의 위치 인자는 경로 패턴이라 디렉터리 아래를
// 모두 실행하고, pytest 는 디렉터리를 재귀로 모은다. 패키지 관리자의 `test` 스크립트는 jest 나 vitest 를 부른다고 본다.
// bun test 의 위치 인자는 경로 필터라 디렉터리 이름을 주면 그 아래 테스트를 모두 실행한다. 점 디렉터리는 checkBunDotPaths 가 따로 본다.
// mocha 는 `--recursive` 가 있어야 해서, 확인하지 못한 실행기와 함께 뺀다
const DIRECTORY_RUNNERS = new Set(['jest', 'vitest', 'pytest', 'pytest-3', 'bun', 'playwright'])
const DIRECTORY_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn'])
// 패키지 스크립트로 실행하는 Jest/Vitest 의 값 옵션이다. 값은 테스트 디렉터리가 아니다
const PACKAGE_TEST_VALUE_OPTIONS = new Set([
  '-t', '--testNamePattern', '--test-name-pattern', '--testPathPattern', '--testPathPatterns',
  '--coverageDirectory', '--coverage-dir', '--coverage.reportsDirectory',
  '--outputFile', '--output-file', '--reporter', '--reporters',
  '--maxWorkers', '-w', '--config', '-c', '--testTimeout', '--test-timeout',
])

// `claude plugin test [dir]` 은 dir(기본은 cwd) 아래의 `*.test.ts` 와 `*.test.tsx` 를 모두 실행한다. 파일 하나를 지정할 수 없다
const PLUGIN_TEST_SUFFIXES = ['.test.ts', '.test.tsx']

// `claude plugin test [dir]` 의 dir 이다. 그 명령이 아니면 null 이다
export function pluginTestDir(commandIn: Command): string | null {
  const command = unwrap(commandIn)
  if (command.length === 0 || pathName(command[0]) !== 'claude' || command[1] !== 'plugin' || command[2] !== 'test') return null
  const rest = command.slice(3).filter((arg) => !arg.startsWith('-'))
  return rest.length ? rest[0] : '.'
}

export function recursiveDirectoryRunner(commandIn: Command): boolean {
  const command = unwrap(commandIn)
  if (command.length === 0) return false
  const program = pathName(command[0])
  const args = command.slice(1)
  if (program === 'bun') return positional('bun', args)[0] === 'test'
  if (repoTestRunnerArgs(command) !== null) return true
  return DIRECTORY_RUNNERS.has(program) || DIRECTORY_PACKAGE_MANAGERS.has(program) || ((program === 'python' || program === 'python3') && args[0] === '-m' && args[1] === 'pytest')
}

// bun test 에서 값을 따로 받는 옵션이다. 값은 테스트 경로 인자가 아니다
const BUN_TEST_VALUE_OPTIONS = new Set(['-t', '--test-name-pattern', '--timeout', '--rerun-each', '--preload', '-r', '--reporter', '--reporter-outfile', '--coverage-dir', '--coverage-reporter', '--seed', '--bail', '--max-concurrency'])
// git grep 에서 값을 따로 받는 옵션이다. 패턴과 경로를 찾을 때 건너뛴다
const GIT_GREP_VALUE_OPTIONS = new Set(['-e', '-f', '-A', '-B', '-C', '-m', '--max-count', '--max-depth', '--threads', '--open-files-in-pager', '-O'])

// 디렉터리일 수 있는 인자를 낸다. `bun test src/profile` 의 `profile` 처럼 이름이 테스트처럼 보이지 않아도 경로 필터다
export function directoryArgs(commandIn: Command): string[] {
  const command = unwrap(commandIn)
  if (command.length && DIRECTORY_PACKAGE_MANAGERS.has(pathName(command[0]))) {
    const program = pathName(command[0])
    let args = positional(program, command.slice(1))
    if (args[0] === 'run' || args[0] === 'run-script') args = args.slice(1)
    const rest: string[] = []
    let skip = false
    // `pnpm playwright test <경로>` 의 `test` 는 하위 명령이라 경로 필터가 아니다
    for (const arg of args[0] === 'playwright' && args[1] === 'test' ? args.slice(2) : args.slice(1)) {
      if (skip) skip = false
      else if (PACKAGE_TEST_VALUE_OPTIONS.has(arg)) skip = true
      else if (!arg.startsWith('-')) rest.push(arg)
    }
    return rest
  }
  if (command.length && pathName(command[0]) === 'bun') {
    const rest: string[] = []
    let skip = false
    for (const arg of positional('bun', command.slice(1)).slice(1)) {
      if (skip) skip = false
      else if (BUN_TEST_VALUE_OPTIONS.has(arg)) skip = true
      else if (!arg.startsWith('-')) rest.push(arg)
    }
    return rest
  }
  const runnerArgs = repoTestRunnerArgs(command)
  if (runnerArgs !== null) return runnerArgs
  return command.filter((arg) => isTest(arg))
}

// `node scripts/run-tests.ts <파일·폴더...>` 의 인자다. 그 명령이 아니면 null 이다. 인자가 없으면 저장소 전체라 빈 목록이다
function repoTestRunnerArgs(command: Command): string[] | null {
  if (command.length === 0 || pathName(command[0]) !== 'node') return null
  const script = nodeScript(command.slice(1))
  if (script === null || !isRepoTestRunner(script.startsWith('./') ? script.slice(2) : script)) return null
  const rest: string[] = []
  let skip = false
  for (const arg of command.slice(command.indexOf(script) + 1)) {
    if (skip) skip = false
    else if (REPO_TEST_RUNNER_VALUE_OPTIONS.has(arg)) skip = true
    else if (!arg.startsWith('-') && !['.', './'].includes(arg)) rest.push(arg) // `.` 은 저장소 전체라 범위를 좁히지 않는다
  }
  return rest
}

// run-tests.ts 에서 값을 따로 받는 옵션이다. 값은 테스트 경로가 아니다
const REPO_TEST_RUNNER_VALUE_OPTIONS = new Set(['--concurrency', '--timeout', '--max-wait', '--out', '--wait'])

// 같은 줄의 `cd <dir>` 를 반영한다. 줄이 바뀌면 저장소 루트로 돌아간다.
// 줄 번호가 없으면 한 줄의 명령 체인으로 본다. 절대 경로와 `cd` 인자 없음은 루트로 본다
export function commandCwds(commands: Command[], lineNumbers: number[] | null = null): string[] {
  let cwd = ''
  let previous: number | null = null
  return commands.map((command, index) => {
    const line = lineNumbers !== null ? lineNumbers[index] : 0
    if (line !== previous) cwd = ''
    previous = line
    if (command[0] === 'cd') {
      const target = command.slice(1).find((a) => !a.startsWith('-'))
      cwd = target === undefined || /^[/~$]/.test(target) ? '' : posixNormpath(posixJoin(cwd, target))
      if (cwd === '.' || cwd.startsWith('..')) cwd = ''
    }
    return cwd
  })
}

// bun 1.3.5 실측이다. `./`, `../`, `/` 로 시작하지 않는 인자는 경로가 아니라 파일 이름 필터다.
// 필터로 읽힌 인자는 `.claude/` 같은 점 디렉터리 아래를 찾지 않는다.
// 다른 인자가 테스트를 찾으면 종료 코드가 0 이라 그 테스트를 건너뛴 것이 드러나지 않는다
function checkBunDotPaths(path: string, commands: Command[], out: string[]): void {
  for (const commandIn of commands) {
    const command = unwrap(commandIn)
    if (!command.length || pathName(command[0]) !== 'bun') continue
    const rest = positional('bun', command.slice(1))
    if (rest[0] !== 'test') continue
    let skip = false
    for (const arg of rest.slice(1)) {
      if (skip) skip = false
      else if (BUN_TEST_VALUE_OPTIONS.has(arg)) skip = true
      else if (arg.startsWith('-') || ['./', '../', '/'].some((p) => arg.startsWith(p))) continue
      else if (arg.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..')) {
        out.push(`${path} — bun test 는 \`./\` 로 시작하지 않는 인자를 이름 필터로 읽어 점 디렉터리 아래 테스트를 찾지 않는다. \`./${arg}\` 로 쓴다`)
      }
    }
  }
}

// python -m unittest 에서 값을 따로 받는 옵션이다. 값은 테스트 이름 인자가 아니다
const UNITTEST_VALUE_OPTIONS = new Set(['-k', '--durations'])

// Python 3.14 실측이다. `python3 -m unittest` 는 파일 경로 인자를 모듈 이름으로 바꿔 import 한다.
// `.github/tests/test_x.py` 는 `.github.tests.test_x` 가 되어 `ValueError: Empty module name` 으로 끝난다.
// `./` 로 시작해도, 점 디렉터리가 중간에 있어도 같다. `discover -s` 는 디렉터리를 경로로 받아 이 변환을 거치지 않는다
function checkUnittestDotPaths(path: string, commands: Command[], out: string[]): void {
  for (const commandIn of commands) {
    const command = unwrap(commandIn)
    if (!command.length || !['python', 'python3'].includes(pathName(command[0])) || command[1] !== '-m' || command[2] !== 'unittest') continue
    const args = command.slice(3)
    if (args[0] === 'discover') continue
    let skip = false
    for (const arg of args) {
      if (skip) skip = false
      else if (UNITTEST_VALUE_OPTIONS.has(arg)) skip = true
      else if (arg.startsWith('-') || !arg.includes('/')) continue
      else if (arg.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..')) {
        const target = (arg.startsWith('./') ? arg.slice(2) : arg).replace(/\/+$/, '')
        const at = target.lastIndexOf('/')
        const directory = at < 0 ? '' : target.slice(0, at)
        const name = at < 0 ? target : target.slice(at + 1)
        const fix = name.endsWith('.py') ? `discover -s ${directory} -p ${name}` : `discover -s ${target}`
        out.push(`${path} — python -m unittest 는 경로를 모듈 이름으로 바꿔 점 디렉터리가 든 경로에서 \`ValueError: Empty module name\` 으로 실패한다: ${arg}. \`python3 -m unittest ${fix}\` 로 쓴다`)
      }
    }
  }
}

// \`! git grep ...\` 이면 [포함 pathspec, 제외 pathspec] 을, 아니면 null 을 낸다. 경로가 없으면 저장소 전체다
export function gitGrepPaths(commandIn: Command): [string[], string[]] | null {
  if (commandIn[0] !== '!') return null
  const command = commandIn.slice(1)
  let prefix = ''
  if (!command.length || pathName(command[0]) !== 'git') return null
  const args = command.slice(1)
  while (args.length && args[0].startsWith('-')) {
    const option = args.shift()!
    if (option === '-C' && args.length) {
      const directory = args.shift()!
      prefix = `${(directory.startsWith('./') ? directory.slice(2) : directory).replace(/\/+$/, '')}/`
    }
  }
  if (args[0] !== 'grep') return null
  let positionalArgs: string[] = []
  let patternGiven = false
  let skip: string | null = null
  let separated = false
  for (const arg of args.slice(1)) {
    if (skip) {
      patternGiven = patternGiven || skip === '-e' || skip === '-f'
      skip = null
    } else if (separated) positionalArgs.push(arg)
    else if (arg === '--') {
      // `--` 앞의 위치 인자는 패턴과 revision 이다
      separated = true
      positionalArgs = []
    } else if (GIT_GREP_VALUE_OPTIONS.has(arg)) skip = arg
    else if (!arg.startsWith('-')) positionalArgs.push(arg)
  }
  if (!separated && !patternGiven) positionalArgs = positionalArgs.slice(1)
  const include: string[] = []
  const exclude: string[] = []
  for (const spec of positionalArgs) {
    const excluded = /^:(?:!|\^|\(exclude\))/.exec(spec)
    ;(excluded ? exclude : include).push(posixNormpath(prefix + spec.slice(excluded ? excluded[0].length : 0)))
  }
  return [include.length ? include : [posixNormpath(prefix || '.')], exclude]
}

// git pathspec 의 기본 규칙이다. 디렉터리는 그 아래 전체이고 glob 의 `*` 는 `/` 도 넘는다
function pathspecMatches(rel: string, specIn: string): boolean {
  const spec = specIn.replace(/\/+$/, '')
  return spec === '' || spec === '.' || rel === spec || rel.startsWith(`${spec}/`) || fnmatchcase(rel, spec)
}

const REMOTE_PROGRAMS = new Set(['ssh', 'scp', 'sftp', 'mosh'])

// push 나 원격 호스트 접속이 있어야 끝나는 명령이면 true 다
function remoteCommand(commandIn: Command): boolean {
  const command = unwrap(commandIn)
  if (!command.length) return false
  const program = pathName(command[0])
  const args = command.slice(1)
  if (REMOTE_PROGRAMS.has(program)) return true
  if (program === 'git') {
    const rest = [...args]
    while (rest.length && rest[0].startsWith('-')) {
      const option = rest.shift()!
      if ((option === '-C' || option === '-c') && rest.length) rest.shift()
    }
    return rest[0] === 'push'
  }
  if (program === 'rsync') {
    // `host:경로` 나 `user@host:경로` 는 원격이다. 옵션 값의 `=` 뒤 콜론은 보지 않는다
    return args.filter((arg) => !arg.startsWith('-')).some((arg) => /^(?:[\p{L}\p{N}_.-]+@)?[\p{L}\p{N}_.-]+:/u.test(arg))
  }
  return false
}

function checkRemoteCommands(path: string, commands: Command[], warnings: string[]): void {
  for (const command of commands) {
    if (remoteCommand(command)) warnings.push(`${path} — 검증 절에 push 나 원격 접속이 있다. phase 검증은 커밋 전에 작업 공간에서 끝나야 한다. remote-verification.md 로 옮긴다: ${command.join(' ')}`)
  }
}

const REMOTE_COLUMNS = ['선행 조건', '시점', '실행 위치', '명령', '기대값']
const REMOTE_PREREQUISITES = ['없음', 'push', '머지', '배포']
const REMOTE_TIMINGS = ['PR 전', 'PR 뒤']

// 첫 마크다운 표의 [줄 번호, 칸 목록] 을 머리 행부터 낸다. 구분 행은 뺀다
function tableRows(text: string): [number, string[]][] {
  const rows: [number, string[]][] = []
  for (const [index, line] of pySplitLines(text).entries()) {
    const stripped = pyStrip(line)
    if (!stripped.startsWith('|')) {
      if (rows.length) break
      continue
    }
    let start = 0
    let end = stripped.length
    while (start < end && stripped[start] === '|') start++
    while (end > start && stripped[end - 1] === '|') end--
    const cells = stripped.slice(start, end).split('|').map(pyStrip)
    if (cells.filter((c) => c).every((c) => /^:?-+:?$/.test(c))) continue
    rows.push([index + 1, cells])
  }
  return rows
}

// remote-verification.md 의 선행 조건·시점과 명령 칸의 원격 접속 형태를 본다.
//
// 시점 열이 없는 옛 형식은 모두 PR 뒤로 읽고 경고만 한다. 진행 중인 계획을 막지 않는다.
// PR 전 항목이 읽기 전용인지는 명령의 뜻이라 판정하지 않는다. 작성자가 확인한다
function checkRemoteVerification(path: string, out: string[], warnings: string[]): void {
  const rows = tableRows(readTextFile(path))
  if (rows.length === 0) {
    out.push(`${path} — 원격 검증 표가 없다`)
    return
  }
  const [[, header], ...body] = rows
  const missing = REMOTE_COLUMNS.filter((c) => !header.includes(c))
  const legacy = missing.length === 1 && missing[0] === '시점'
  if (legacy) warnings.push(`${path} — 시점 열이 없는 옛 형식이다. 모든 항목을 PR 뒤로 읽는다`)
  else if (missing.length) {
    out.push(`${path} — 원격 검증 표에 열이 없다: ${missing.join(', ')}`)
    return
  }
  const col: Record<string, number> = {}
  for (const name of REMOTE_COLUMNS) if (header.includes(name)) col[name] = header.indexOf(name)
  for (const [n, cells] of body) {
    const cell = (name: string) => {
      const i = col[name]
      return i !== undefined && i < cells.length ? cells[i] : ''
    }
    const commandText = stripBackticks(cell('명령'))
    if (commandsOf(`\`\`\`bash\n${commandText}\n\`\`\``).some(remoteCommand)) {
      warnings.push(`${path}:${n} — 명령 칸에 원격 접속이나 push 형태가 있다. 접속 대상과 운영 값 대신 절차 이름이나 저장소 스크립트만 적고, 실행 위치는 저장소 이름만 적는다`)
    }
    const prerequisite = cell('선행 조건')
    if (!new PyRegExp(`^(?:${REMOTE_PREREQUISITES.join('|')})(?:\\s|$)`).test(prerequisite)) {
      const message = `${path}:${n} — 선행 조건은 ${REMOTE_PREREQUISITES.join(', ')} 중 하나로 시작한다: ${prerequisite}`
      ;(legacy ? warnings : out).push(message)
      continue
    }
    if (legacy) continue
    const timing = cell('시점')
    if (!REMOTE_TIMINGS.includes(timing)) out.push(`${path}:${n} — 시점은 ${REMOTE_TIMINGS.join(' 또는 ')} 이다: ${timing}`)
    else if (timing === 'PR 전' && ['머지', '배포'].includes(prerequisite.split(pyre(/\s+/))[0])) out.push(`${path}:${n} — 머지나 배포가 선행 조건인 검증은 PR 전에 돌릴 수 없다`)
  }
}

const stripBackticks = (text: string) => text.replace(/^`+|`+$/g, '')

// Python 테스트 파일의 이름이 모듈 이름이 될 수 없으면 true 다. `test-foo.py` 가 그 예다
export const pythonModuleNameProblem = (rel: string) => rel.endsWith('.py') && !isGlob(rel) && isTest(rel) && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(pathStem(rel))

// 모듈 이름을 거치지 않고 파일 경로로 실행한다. `python3 tests/test-foo.py` 와 `pytest tests/test-foo.py` 다
function runsPathDirectly(commandIn: Command, rel: string): boolean {
  const command = unwrap(commandIn)
  if (!command.length) return false
  let program = pathName(command[0])
  let args = command.slice(1)
  if ((program === 'python' || program === 'python3') && args[0] === '-m' && args[1] === 'pytest') {
    program = 'pytest'
    args = args.slice(2)
  } else if (program === 'python' || program === 'python3') args = args.slice(0, 1)
  else if (program !== 'pytest' && program !== 'pytest-3') return false
  const target = rel.startsWith('./') ? rel.slice(2) : rel
  return args.some((arg) => (arg.startsWith('./') ? arg.slice(2) : arg).split('::')[0] === target)
}

// 하이픈 같은 문자가 든 Python 테스트 파일은 모듈로 import 할 수 없다.
//
// `unittest discover` 는 그런 파일을 알리지 않고 건너뛰고, pytest 의 디렉터리 수집도 기본 패턴(`test_*.py`)에 걸리지 않아 빠진다.
// `python3 -m unittest tests.test-foo` 는 import 오류로 끝난다. 테스트가 돌지 않는데 검증이 통과하므로 위반으로 막는다.
// 경로를 직접 실행하는 명령이 있으면 모듈 이름을 거치지 않으므로 허용한다
function checkPythonTestNames(path: string, commands: Command[], entries: Entry[], out: string[]): void {
  for (const [rel, action] of entries) {
    if (action === '삭제' || !pythonModuleNameProblem(rel)) continue
    if (commands.some((command) => runsPathDirectly(command, rel))) continue
    out.push(
      `${path} — Python 테스트 파일 이름이 모듈 이름이 될 수 없어 unittest discover 와 pytest 디렉터리 수집이 건너뛴다: ${rel}. ` +
        `\`${pathStem(rel).replace(/[^0-9A-Za-z_]/g, '_')}.py\` 처럼 밑줄로 쓰거나 검증 명령에서 경로로 직접 실행한다`,
    )
  }
}

// 금지 문자열 검사의 경로에 같은 phase 의 테스트 파일이 있으면 경고한다.
//
// 「X 가 없어야 한다」 를 단언하는 테스트는 X 를 문자열로 담는다. 그 파일이 검사 경로에 있으면
// 두 검증이 동시에 통과할 수 없다. 테스트가 X 를 담는지는 구현 전이라 알 수 없어 경고로 둔다
function checkForbiddenGrepPaths(path: string, commands: Command[], entries: Entry[], warnings: string[]): void {
  const tests = entries.filter(([rel, action]) => action !== '삭제' && isTest(rel)).map(([rel]) => rel)
  for (const command of commands) {
    const paths = gitGrepPaths(command)
    if (!paths) continue
    const [include, exclude] = paths
    for (const rel of tests) {
      if (include.some((spec) => pathspecMatches(rel, spec)) && !exclude.some((spec) => pathspecMatches(rel, spec))) {
        warnings.push(`${path} — 금지 문자열 검사가 같은 phase 의 테스트 파일에 걸릴 수 있다. 경로에서 빼거나 pathspec 제외(\`':!${rel}'\`)를 쓴다: ${command.join(' ')}`)
      }
    }
  }
}

// 실행 정책이 있는 저장소에서만 새 JS 경로를 대조한다. staged 검사는 index 의 정책을 읽는다.
function checkNewJsPolicy(path: string, entries: Entry[], repo: string, out: string[], warnings: string[], staged = false): void {
  const policyPath = 'scripts/runtime-policy.json'
  let text: string
  if (staged) {
    const result = capture(['git', 'show', `:${policyPath}`], { cwd: repo })
    if (result.code !== 0) return
    text = result.stdout
  } else {
    if (!existsSync(`${repo}/${policyPath}`)) return
    text = readTextFile(`${repo}/${policyPath}`)
  }
  let allowed: Set<string>
  try {
    const policy = JSON.parse(text) as { entry_js?: unknown; legacy?: unknown } | null
    if (!policy || !Array.isArray(policy.entry_js) || !Array.isArray(policy.legacy) ||
        ![...policy.entry_js, ...policy.legacy].every((value) => typeof value === 'string')) throw new Error()
    allowed = new Set([...policy.entry_js, ...policy.legacy])
  } catch {
    warnings.push(`${path} — ${policyPath} 의 JS 허용 목록을 읽지 못해 대조를 건너뛴다`)
    return
  }
  for (const [rel, action] of entries) {
    if (action === '신규' && /\.(?:js|mjs|cjs)$/.test(rel) && !isGlob(rel) && !allowed.has(rel)) {
      out.push(`${path} — 새 JS 파일을 runtime-policy 허용 목록에 더한다: ${rel}`)
    }
  }
}

function checkStaged(path: string, text: string, repo: string, out: string[], warnings: string[]): void {
  const entries = manifest(path, text, out, warnings)
  if (entries.some(([rel]) => omitted(rel))) {
    out.push(`${path} — staged 대조에는 생략하지 않은 변경 파일 경로가 필요하다${OMIT_HINT}`)
    return
  }
  const result = capture(['git', 'diff', '--cached', '--name-status', '-z', '--find-renames'], { cwd: repo })
  if (result.code !== 0) throw new ValueError(`Command 'git diff --cached --name-status -z --find-renames' returned non-zero exit status ${result.code}.`)
  const fields = result.stdout.split('\0')
  const changes: Entry[] = []
  let i = 0
  while (i < fields.length && fields[i]) {
    const status = fields[i]
    const rel = fields[i + 1]
    i += 2
    if (status.startsWith('R') || status.startsWith('C')) {
      const renamed = fields[i]
      i += 1
      if (status.startsWith('R')) changes.push([rel, '삭제'])
      changes.push([renamed, '신규'])
    } else changes.push([rel, ({ A: '신규', D: '삭제' } as Record<string, string>)[status] ?? '수정'])
  }
  checkNewJsPolicy(path, changes, repo, out, warnings, true)
  if (changes.length === 0) out.push(`${path} — staged 변경이 없다`)
  const planDir = posixNormpath(pathParent(pjoin(repo, path)))
  const implementation = changes.filter(([rel]) => {
    const dir = posixNormpath(pathParent(pjoin(repo, rel)))
    const name = pathName(rel)
    return !(dir === planDir && (name === 'index.json' || name === 'verification-plan.md' || fnmatchcase(name, 'phase-*.md')))
  })
  // 메타데이터 보완 커밋에는 이미 커밋한 신규 구현 파일이 다시 staged 될 필요가 없다
  if (changes.length && !implementation.length) return
  for (const [rel, action] of implementation) {
    const allowed = entries.filter(([pattern]) => matches(rel, pattern))
    const [generated] = overlayValues.lookup(repo, ['plan'], '생성 파일', overlayValues.targets(repo, [rel])[0])
    if (allowed.length === 0 && generated && overlayValues.codes(generated).some((pattern) => matches(rel, pattern))) continue
    if (allowed.length === 0) out.push(`${path} — phase 범위 밖의 staged 파일: ${rel}`)
    else if (!allowed.some(([, kind]) => accepts(kind, action))) out.push(`${path} — staged 변경 종류가 목록과 다르다: ${rel} (${action})`)
  }
  // 목록에 있는데 staged 에 없는 파일이다. 신규 테스트가 빠진 커밋을 막는다
  const staged = new Set(changes.map(([rel, action]) => `${rel}\0${action}`))
  for (const [rel, action] of entries) {
    if (isGlob(rel) || staged.has(`${rel}\0${action}`)) continue
    if (action === '신규') out.push(`${path} — 신규로 적은 파일이 staged 에 없다: ${rel}`)
    else warnings.push(`${path} — ${action}로 적은 파일이 staged 에 없다: ${rel}`)
  }
}

// index.json 이 스키마와 실제 파일에 맞는지 본다.
//
// execution_profile 은 provider 중립 필드이고 model 은 읽기 호환용이다.
// 둘 다 있으면 어느 쪽이 이기는지 정해져 있지 않아 실행 등급이 갈린다
function checkIndex(path: string, planName: string, phaseFiles: string[], out: string[]): void {
  const data = JSON.parse(readTextFile(path)) as unknown
  if (!isRecord(data) || !Array.isArray(data.phases)) {
    out.push(`${path} — index 객체와 phases 배열이 필요하다`)
    return
  }
  if (data.name !== planName) out.push(`${path} — name 이 디렉터리명과 다르다: ${pyRepr(data.name)} != ${pyRepr(planName)}`)
  const phases = data.phases as unknown[]
  if (data.total_phases !== phases.length) out.push(`${path} — total_phases(${pyStrAny(data.total_phases)}) 가 phases 길이(${phases.length})와 다르다`)
  for (const key of FORBIDDEN_KEYS) if (key in data) out.push(`${path} — 스키마에 없는 키: ${key}`)
  const onDisk = new Set(phaseFiles.map(pathName))
  const listed: string[] = []
  phases.forEach((phase, i) => {
    if (!isRecord(phase)) {
      out.push(`${path} — phases[${i}] 가 객체가 아니다`)
      return
    }
    for (const key of ['number', 'file']) if (!(key in phase)) out.push(`${path} — phases[${i}] 에 ${key} 가 없다`)
    if (phase.number !== i + 1) out.push(`${path} — phases[${i}] number 가 ${i + 1} 이 아니다: ${pyStrAny(phase.number)}`)
    const f = phase.file
    if (typeof f !== 'string' || !onDisk.has(f)) out.push(`${path} — phases[${i}] 가 가리키는 ${pyStrAny(f)} 가 없다`)
    else listed.push(f)
    const hasProfile = typeof phase.execution_profile === 'string' && PROFILES.has(phase.execution_profile)
    const hasModel = typeof phase.model === 'string' && MODELS.has(phase.model)
    const both = 'execution_profile' in phase && 'model' in phase
    if (both || !(hasProfile || hasModel)) out.push(`${path} — phases[${i}] execution_profile/model schema 오류`)
  })
  if (new Set(listed).size !== onDisk.size || [...new Set(listed)].some((f) => !onDisk.has(f)) || listed.length !== onDisk.size) {
    out.push(`${path} — phases 목록과 실제 phase 파일이 일치하지 않는다`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// index.json 에 이 plan 의 PR 범위와 뒤로 미룬 일이 있는지, phase 수가 PR 하나의 크기인지 본다.
// created_at 이 PR_SCOPE_FROM 보다 이르거나 없는 옛 plan 은 같은 검사를 경고로만 낸다
function checkPrScope(path: string, data: Record<string, unknown>, out: string[], warnings: string[]): void {
  const created = data.created_at
  const legacy = !(typeof created === 'string' && pyStrCompare(created, PR_SCOPE_FROM) >= 0)
  const sink = legacy ? warnings : out
  const note = legacy ? ' (옛 plan 이라 경고만 낸다)' : ''
  const scope = data.pr_scope
  if (typeof scope !== 'string' || !pyStrip(scope)) sink.push(`${path} — pr_scope 가 없거나 비었다. 이 plan 의 PR 이 끝내는 것을 한 문장으로 적는다${note}`)
  else if (pyStrip(scope).includes('\n')) sink.push(`${path} — pr_scope 는 한 문장이어야 한다${note}`)
  const deferred = data.deferred
  if (!Array.isArray(deferred)) sink.push(`${path} — deferred 칸이 없다. 뒤로 미룬 일을 적고, 없으면 빈 배열로 둔다${note}`)
  else {
    deferred.forEach((item, i) => {
      const missing = DEFERRED_KEYS.filter((k) => !isRecord(item) || !pyStrip(pyStrAny(k in item ? item[k] : '')))
      if (missing.length) sink.push(`${path} — deferred[${i}] 에 ${missing.join(', ')} 가 비었다${note}`)
    })
  }
  const phases = data.phases
  if (Array.isArray(phases) && phases.length > MAX_PHASES) {
    sink.push(`${path} — phase 가 ${phases.length}개로 PR 하나의 크기(${MAX_PHASES}개)를 넘는다. plan 을 나누고 지금 할 plan 만 쓴다. 뒤의 일은 deferred 에 한 줄로 둔다${note}`)
  }
}

type Limit = [number, string]

// 변경 파일이 PR 하나의 크기를 넘으면 경고한다.
//
// limit 은 레포 설정이 준 [상한, 출처] 다. 있으면 저장소의 크기 측정처럼 계획 폴더만 빼고 모든 파일을 센다.
// 없으면 docs/ 와 tasks/ 를 뺀 파일을 MAX_CHANGED_FILES 와 비교한다. phases 는 [phase 파일, 변경 파일 집합] 목록이다
export function checkChangedFileCount(path: string, entries: Set<string>, warnings: string[], limit: Limit | null = null, phases: [string, Set<string>][] = [], planDir = ''): void {
  if (limit) {
    const [cap, source] = limit
    const files = new Set([...entries].filter((rel) => !(planDir && under(rel, planDir))))
    if (files.size > cap) {
      const split = phases.map(([phase, rels]) => `${pathStem(phase)} ${rels.size}개`).join(', ')
      warnings.push(`${path} — 변경 파일이 ${files.size}개로 저장소의 PR 크기 기준(${cap}개, ${source})을 넘는다. phase 별 변경 파일: ${split}. 나눌 선을 정해 plan 을 나누거나, 저장소의 크기 예외 규칙을 따른다`)
    }
    return
  }
  const files = new Set([...entries].filter((rel) => !(rel.startsWith('docs/') || rel.startsWith('tasks/')) && !rel.includes('/docs/')))
  if (files.size > MAX_CHANGED_FILES) {
    warnings.push(`${path} — 변경 파일이 ${files.size}개로 PR 하나의 크기(${MAX_CHANGED_FILES}개)를 넘는다. 디렉터리 이동 같은 일괄 이동이 아니면 plan 을 나눈다. 일괄 이동이면 pr_scope 에 그렇게 적는다`)
  }
}

// 기존 수정·삭제 파일의 전체 줄을 변경량의 근사치로 센다. 신규 파일은 아직 줄 수를 알 수 없다.
export function checkEstimatedSize(path: string, entries: Set<string>, repo: string, warnings: string[]): void {
  const configPath = pjoin(repo, '.github/pr-size.json')
  try {
    const config = (isFile(configPath) ? JSON.parse(readTextFile(configPath)) : {}) as { grades?: Record<string, Record<string, number>>; core?: string[]; generated?: string[]; tests?: string[]; docs?: string[] }
    const match = (rel: string, patterns: string[] = []) => patterns.some((pattern) => fnmatchcase(rel, pattern))
    const files = new Map<string, string>()
    for (const entry of entries) {
      const [rel, action] = entry.split('\0')
      if (!isGlob(rel) && !omitted(rel)) files.set(rel, `${files.get(rel) ?? ''} ${action}`)
    }
    let core = 0, total = 0, count = 0, unknown = 0
    for (const [rel, action] of files) {
      if (!match(rel, config.core) && match(rel, config.generated)) continue
      count++
      let lines = 0
      if (action.includes('수정') || action.includes('삭제')) {
        try { lines = pySplitLines(normalizeNewlines(readFileSync(pjoin(repo, rel), 'utf8'))).length } catch { unknown++ }
      } else unknown++
      total += lines
      if (match(rel, config.core) || (!match(rel, config.tests) && !match(rel, config.docs))) core += lines
    }
    const metrics: Record<string, number> = { core_lines: core, total_lines: total, files: count }
    const exceeds = (grade: string) => Object.entries(config.grades![grade]).some(([key, limit]) => metrics[key] > limit)
    const grade = config.grades ? (exceeds('D') ? 'D' : exceeds('B') ? 'C' : exceeds('A') ? 'B' : 'A') : null
    warnings.push(`${path} — PR 크기 추정${grade ? ` ${grade}등급` : ''}: 본 코드 ${core}줄, 전체 ${total}줄, ${count}개 파일 (줄 수 미상 ${unknown}개).${grade === 'D' ? ' PR 나눔 검토' : ''}`)
  } catch {
    warnings.push(`${configPath} — PR 크기 설정을 읽지 못해 줄 수를 추정하지 못했다`)
  }
}

// 인수 검증 표와 검증 명령에 적은 구체적인 테스트 파일을 추적 파일 및 신규 계획과 대조한다.
export function checkTestReferences(path: string, text: string, entries: Entry[], repo: string, out: string[]): void {
  const listed = capture(['git', '-C', repo, 'ls-files', '-z'])
  if (listed.code !== 0) return
  const tracked = new Set(listed.stdout.split('\0'))
  const planned = entries.filter(([, action]) => action === '신규').map(([rel]) => rel)
  const refs = text.match(/[A-Za-z0-9_.@/-]+\.(?:tsx?|jsx?|py|java|kt|mjs|sh|rb)/g) ?? []
  for (const ref of new Set(refs)) {
    const rel = ref.replace(/^\.\//, '')
    if (!isTest(rel) || isGlob(rel) || tracked.has(rel) || planned.some((p) => isGlob(p) ? matches(rel, p) : p === rel)) continue
    out.push(`${path} — 검증에 적은 테스트 파일이 git 추적 파일이나 신규 계획에 없다: ${rel}`)
  }
}

// 파일 길이 상한을 적용할 파일이다. `/` 없는 패턴은 파일 이름에 맞춘다. globs 가 없으면 코드 파일 전부다
function lengthTarget(rel: string, globs: string[]): boolean {
  if (globs.length === 0) return CODE_SUFFIXES.has(pathSuffix(rel))
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  return globs.some((g) => (g.includes('/') ? matches(rel, g) : fnmatchcase(name, g)))
}

// 수정할 파일이 레포 설정의 파일 길이 상한에 가까우면 경고한다. limit 은 [상한, glob 목록, 출처] 다.
//
// 구현이 줄을 더하면 저장소 검사(Checkstyle FileLength 같은 것)가 실패하므로, 계획 단계에서 새 파일로 나눌지 정하게 한다
function checkFileLength(path: string, entries: Set<string>, repo: string, limit: [number, string[], string], warnings: string[]): void {
  const [cap, globs, source] = limit
  const floor = Math.trunc(cap * FILE_LENGTH_RATIO)
  const sorted = [...entries].map((e) => e.split('\0') as [string, string]).sort((a, b) => pyStrCompare(a[0], b[0]) || pyStrCompare(a[1], b[1]))
  for (const [rel, action] of sorted) {
    if (!action.includes('수정') || isGlob(rel) || omitted(rel) || !lengthTarget(rel, globs)) continue
    let lines: number
    try {
      lines = pySplitLines(normalizeNewlines(readFileSync(`${repo}/${rel}`).toString('utf8'))).length
    } catch {
      continue
    }
    if (lines >= floor) {
      warnings.push(`${path} — ${rel} 이 ${lines}줄로 저장소의 파일 길이 상한(${cap}줄, ${source})까지 ${cap - lines}줄 남았다. 더할 코드를 새 파일로 나눌지 계획에서 정한다`)
    }
  }
}

// 레포 설정의 PR 변경 파일 상한과 파일 길이 상한을 읽는다. 없으면 null, 읽지 못하면 경고를 남기고 null 이다
function repoLimits(repo: string, planDir: string, warnings: string[]): [Limit | null, [number, string[], string] | null] {
  const sub = overlayValues.targets(repo, [planDir])[0]
  const skills = ['plan']
  let files: Limit | null = null
  let length: [number, string[], string] | null = null
  let [value, source] = overlayValues.lookup(repo, skills, 'PR 변경 파일 상한', sub)
  if (value !== null) {
    try {
      files = [overlayValues.number(repo, value), source!]
    } catch (error) {
      if (!(error instanceof ValueError)) throw error
      warnings.push(`${source} — 「PR 변경 파일 상한」 을 읽지 못해 기본 기준(${MAX_CHANGED_FILES}개)을 쓴다: ${error.message}`)
    }
  }
  ;[value, source] = overlayValues.lookup(repo, skills, '파일 길이 상한', sub)
  if (value !== null) {
    let cap: number | null = null
    try {
      cap = overlayValues.number(repo, value)
    } catch (error) {
      if (!(error instanceof ValueError)) throw error
      warnings.push(`${source} — 「파일 길이 상한」 을 읽지 못해 파일 길이를 보지 않는다: ${error.message}`)
    }
    if (cap !== null) {
      const [globs] = overlayValues.lookup(repo, skills, '파일 길이 대상', sub)
      length = [cap, globs ? overlayValues.codes(globs) : [], source!]
    }
  }
  return [files, length]
}

// 같은 접두사와 번호를 쓰는 다른 계획 디렉터리를 찾는다.
//
// 다른 브랜치에서 만든 계획은 작업 트리에 없으므로 브랜치마다 ls-tree 로 본다.
// 번호는 앞의 0 을 떼고 비교한다. `plan012` 와 `plan12` 는 같은 번호다.
// 검사하는 계획이 커밋 전이면 지금 만드는 중이라 번호를 바꿀 수 있어 위반으로 낸다.
// 이미 커밋된 계획이면 phase 가 진행 중일 수 있어 경고로만 낸다. 폴더 이름을 바꾸면 진행 중인 일이 깨진다
function checkPlanNumber(repo: string, tasksDir: string, plan: string, out: string[], warnings: string[]): void {
  const mine = PLAN_NUMBER.exec(plan)
  if (!mine) return
  const where = new Map<string, string[]>()
  const add = (name: string, place: string) => {
    if (!where.has(name)) where.set(name, [])
    where.get(name)!.push(place)
  }
  const local = pjoin(repo, tasksDir)
  const localPath = `${repo}/${tasksDir}`
  try {
    if (statSync(localPath).isDirectory()) {
      for (const child of readdirSync(localPath)) if (isDirectory(`${localPath}/${child}`)) add(child, '작업 트리')
    }
  } catch {
    // 작업 트리에 계획 폴더가 없다
  }
  // `refs/remotes/origin/HEAD` 는 짧은 이름이 `origin` 이라 전체 이름에서 HEAD 를 제외한 뒤 줄인다
  const refs = capture(['git', '-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  for (const full of refs.code === 0 ? refs.stdout.split(pyre(/\s+/)).filter(Boolean) : []) {
    if (full.endsWith('/HEAD')) continue
    const ref = full.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '')
    const tree = capture(['git', '-C', repo, 'ls-tree', '-d', '--name-only', ref, `${tasksDir}/`])
    for (const name of tree.stdout.split(pyre(/\s+/)).filter(Boolean)) add(name.slice(name.lastIndexOf('/') + 1), ref)
  }
  // 그 계획을 처음 더한 커밋의 날짜. 아직 커밋하지 않았으면 null 이다
  const added = (name: string): string | null => {
    const log = capture(['git', '-C', repo, 'log', '--all', '--diff-filter=A', '--format=%cs', '--', `${tasksDir}/${name}`])
    const dates = log.code === 0 ? log.stdout.split(pyre(/\s+/)).filter(Boolean) : []
    return dates.length ? dates.at(-1)! : null
  }
  for (const [name, places] of [...where].sort((a, b) => pyStrCompare(a[0], b[0]))) {
    const other = PLAN_NUMBER.exec(name)
    if (name !== plan && other && other[1] === mine[1] && pyInt(other[2]) === pyInt(mine[2])) {
      const theirs = added(name)
      const ours = added(plan)
      const shown = [...new Set(places)].sort(pyStrCompare)
      const whereText = shown.slice(0, 3).join(', ') + (shown.length > 3 ? ` 외 ${shown.length - 3}곳` : '')
      const found = `${pjoin(local, plan)} — 계획 번호가 겹친다: ${name} (${whereText}, ${theirs ?? '커밋 전'} 추가). 이 계획은 ${ours ?? '커밋 전'} 추가`
      if (ours === null) out.push(`${found}. 이 계획의 번호를 plan_number.ts 의 다음 번호로 바꾼다`)
      else warnings.push(`${found}. 이미 커밋된 계획이라 이름은 그대로 두고, 보고에서 계획 이름을 붙인다`)
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// 번들 스크립트 경로와 실행할 저장소를 혼동하는 블록만 검사한다
function checkBashCwd(path: string, text: string, out: string[]): void {
  for (const { start, language, body } of codeBlocks(text)) {
    if (['bash', 'sh', 'shell', 'zsh'].includes(language) && BUNDLE.test(body)) {
      if (!pyre(/(?<![^\n])\s*# cwd:/).test(body)) out.push(`${path}:${start} — 스킬 번들 명령의 cwd 주석 누락`)
    }
  }
}

// 「전체 삭제」 류가 범위 지시로 쓰였는지 본다. 뒤에 명사가 이어진 수식어는 뺀다
export function vagueScope(line: string): boolean {
  for (const m of line.matchAll(VAGUE_SCOPE)) {
    const tail = line.slice(m.index! + m[0].length)
    if (!pyStrip(tail) || !pyre(/^\s*[가-힣]/).test(tail) || VAGUE_SCOPE_TAIL.test(tail)) return true
  }
  return false
}

// 코드 블록 밖의 산문만 낸다. 「의도 메모」 절과 첫 절 이전의 머리말은 뺀다.
//
// 의도 메모를 빼는 이유는 설계 근거를 적는 절이라 「직접 확인」 같은 표현이
// 자연스럽게 나오기 때문이다. 그것까지 잡으면 글을 규칙에 맞춰 비틀게 되고,
// 정작 검증 기준의 결함은 그대로 남는다.
//
// 뺄 절을 하나만 지정한다. 볼 절을 열거하면 작업 항목처럼 자동 실행이 실제로
// 끊기는 자리를 놓친다. 사람 의존 지시는 검증 절보다 작업 항목에 더 자주 들어간다
export function iterProse(text: string): [number, string][] {
  let skip = true // 첫 "## " 이전은 phase 를 소개하는 문장이라 뺀다
  const out: [number, string][] = []
  for (const { n, line, kind } of fences(text)) {
    if (kind !== 'text') continue
    if (line.startsWith('## ')) {
      skip = line.includes('의도 메모')
      continue
    }
    if (!skip) out.push([n, line])
  }
  return out
}

// 같은 phase 의 테스트 작업과 실행 지시를 본다. 작업 순서는 강제하지 않는다
export function checkPhasePrompt(path: string, text: string, out: string[], entries: Entry[] = [], repo: string = process.cwd(), warnings: string[] = []): void {
  const context = section(text, '컨텍스트') || text
  const evidence = pyre(/\*\*근거 문서\*\*\s*:([\s\S]*?)(?=\n\s*\n|$)/).exec(context)
  const docs = evidence ? [...evidence[1].matchAll(DOC_PATH)].map((m) => m[1]) : []
  if (!evidence || docs.length === 0) out.push(`${path} — 근거 문서에 docs/ 경로가 없다`)
  else {
    for (const rel of docs) if (!isFile(`${repo}/${rel}`)) out.push(`${path} — 근거 문서가 없는 경로를 가리킨다: ${rel}`)
  }
  const work = section(text, '작업 항목')
  const validation = section(text, '검증')
  if (!/(?<![^\n])### [^\n]+/.test(work)) out.push(`${path} — 작업 항목이 없다`)
  const numbered = shellCommands(validation)
  const commands = numbered.map((c) => c.command)
  const lineNumbers = numbered.map((c) => c.line)
  const cwds = commandCwds(commands, lineNumbers)
  const runnerPairs = commands.map((command, i) => [command, cwds[i]] as [Command, string]).filter(([command, cwd]) => testCommand(command, entries, repo, cwd))
  const runners = runnerPairs.map(([command]) => command)
  const runnerCwds = runnerPairs.map(([, cwd]) => cwd)
  if (commands.length === 0) {
    out.push(`${path} — 검증 절에 실행할 명령이 없다 (명령은 bash 코드 블록에 적는다. 목록이나 인라인 코드로 적은 명령은 읽지 않는다)`)
  } else if (runners.length === 0) {
    const unknown = commands.filter((command) => classify(command, entries, repo) === 'unknown')
    if (unknown.length) warnings.push(`${path} — 테스트 실행 여부를 판정하지 못한 명령이다. 테스트를 실행하는지 직접 확인한다: ${unknown[0].join(' ')}`)
    else out.push(`${path} — 검증 절에 테스트 실행 명령이 없다 (lint/grep/echo 만으로 완료할 수 없다)`)
  }
  checkBunDotPaths(path, commands, out)
  checkUnittestDotPaths(path, commands, out)
  checkForbiddenGrepPaths(path, commands, entries, warnings)
  checkPythonTestNames(path, commands, entries, out)
  checkRemoteCommands(path, commands, warnings)
  checkContractCommands(path, commands, cwds, entries, repo, out)
  checkIntegrationFilters(path, commands, entries, repo, warnings)

  const runs = (part: string) => commandsOf(`\`\`\`bash\n${part}\n\`\`\``).some((c) => testCommand(c, entries, repo))

  for (const { language, body } of codeBlocks(validation)) {
    if (!SHELL.has(language)) continue
    const pipefail = pyre(/set\s+-[A-Za-z]*o\s+pipefail/).test(body)
    for (const line of pySplitLines(body)) {
      if (pyre(/\|\|\s*(?:true|:|exit\s+0)(?:\s|;|$)/).test(line) && runs(line.split('||')[0])) out.push(`${path} — 테스트 실패를 무시하는 명령: ${pyStrip(line)}`)
      const pipes = line.split(/(?<!\|)\|(?!\|)/)
      if (!pipefail && pipes.length > 1 && pyre(/^\s*tee(?![\p{L}\p{N}_])/u).test(pipes.at(-1)!) && runs(pipes[0])) {
        warnings.push(`${path} — pipefail 없이 tee 로 넘기면 테스트 실패 종료 코드가 사라진다: ${pyStrip(line)}`)
      }
    }
  }
  for (const [, line] of iterProse(`## 작업 항목\n${work}\n## 검증\n${validation}`)) {
    if (DEFER_TEST.test(line) && !NOT_DEFERRED.test(line)) out.push(`${path} — 테스트를 다른 phase 로 미루는 지시: ${pyStrip(line)}`)
  }
  const changedCode = entries.filter(([rel, action]) => action !== '삭제' && CODE_SUFFIXES.has(pathSuffix(rel)) && !isTest(rel)).map(([rel]) => rel)
  const changedTests = entries.filter(([rel, action]) => action !== '삭제' && isTest(rel)).map(([rel]) => rel)
  const prose = iterProse(`## 작업 항목\n${work}`).map(([, line]) => line).join('\n')
  const references = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  const testReferences = references.filter((ref) => isTest(ref) || /(?:Test|Tests|Spec)$/.test(ref))
  const declaredTests = changedTests.filter((rel) => references.some((ref) => ref === rel || [pathName(rel), pathStem(rel)].includes(pathName(ref))) || (isGlob(rel) && testReferences.length > 0))
  // 인자 경로는 같은 줄의 `cd <dir> &&` 를 반영한 저장소 루트 기준으로도 변경 파일과 대조한다
  const checkedScript = runners.some((command, i) =>
    command.some((arg) => !/^[/-]/.test(arg) && work.includes(arg) && (changedCode.includes(arg.startsWith('./') ? arg.slice(2) : arg) || changedCode.includes(posixNormpath(posixJoin(runnerCwds[i], arg))))),
  )
  if (changedCode.length && declaredTests.length === 0 && !checkedScript) {
    // 어느 변경 파일 때문에 걸렸는지 보여 준다. glob 이 코드로 잡혔는지 테스트로 안 잡혔는지 가려야 한다
    const shown = changedCode.slice(0, CALLER_LIMIT).join(', ') + (changedCode.length > CALLER_LIMIT ? ` 외 ${changedCode.length - CALLER_LIMIT}개` : '')
    out.push(`${path} — 코드 변경을 검증할 테스트 파일 또는 검증 스크립트 작업이 같은 phase 에 없다 (코드로 센 변경 파일: ${shown})`)
  }
  const targeted: string[] = []
  for (const command of runners) {
    const unwrapped = unwrap(command)
    const candidates = unwrapped.length && DIRECTORY_PACKAGE_MANAGERS.has(pathName(unwrapped[0])) ? directoryArgs(command) : command
    targeted.push(...candidates.filter((arg) => isTest(arg)))
  }
  // 디렉터리 인자는 `cd <dir> &&` 를 반영한 저장소 루트 기준 경로로도 대조한다
  const directories: string[] = []
  commands.forEach((command, i) => {
    if (testCommand(command, entries, repo) && recursiveDirectoryRunner(command)) {
      for (const arg of directoryArgs(command)) if (!/^[/-]/.test(arg)) directories.push(posixNormpath(posixJoin(cwds[i], arg)))
    }
  })
  const pluginDirs: string[] = []
  commands.forEach((command, i) => {
    const directory = pluginTestDir(command)
    if (directory !== null && !directory.startsWith('/')) pluginDirs.push(posixNormpath(posixJoin(cwds[i], directory)))
  })
  // 보조 파일은 그것을 쓰는 테스트가 실행한다. 어느 테스트가 쓰는지는 구현 전이라 알 수 없어 파일 단위로 대조하지 않는다
  const runnable = declaredTests.filter(runnableTest)
  if (runnable.length && (targeted.length || directories.length || pluginDirs.length) && !runners.some((command) => ['gradle', 'gradlew', 'mvn', 'mvnw'].includes(pathName(command[0])))) {
    for (const rel of runnable) {
      if (
        !targeted.some((arg) => matches(rel, arg) || pathName(rel) === pathName(arg) || rel.startsWith(`${arg.replace(/\/+$/, '')}/`)) &&
        !directories.some((directory) => rel.startsWith(`${directory}/`)) &&
        !pluginDirs.some((directory) => under(rel, directory) && PLUGIN_TEST_SUFFIXES.some((s) => rel.endsWith(s)))
      ) {
        out.push(`${path} — 검증 명령이 작업 항목의 테스트를 실행하지 않는다: ${rel}`)
      }
    }
  }
  for (const command of runners) {
    if (repoTestRunnerArgs(unwrap(command)) !== null) continue
    if (command.some((arg) => (arg.startsWith('./') ? arg.slice(2) : arg).startsWith('scripts/'))) warnings.push(`${path} — 저장소 스크립트의 테스트 범위와 실패 종료 코드는 직접 확인한다: ${command.join(' ')}`)
  }
}

// 경로와 명령의 대응만 오버레이에서 읽는다. 명령은 실행하지 않는다.
function checkContractCommands(path: string, commands: Command[], cwds: string[], entries: Entry[], repo: string, out: string[]): void {
  const sources = new Map<string, string[]>()
  for (const [rel] of entries) {
    const [value] = overlayValues.lookup(repo, ['plan'], '계약 검증 규칙', overlayValues.targets(repo, [rel])[0])
    if (value) sources.set(value, [...(sources.get(value) ?? []), rel])
  }
  for (const [value, changed] of sources) {
    const config = overlayValues.codes(value)[0]
    if (isAbsolutePath(config) || config.split('/').includes('..')) throw new ValueError('계약 검증 규칙은 저장소 안 JSON 파일의 상대경로여야 한다')
    const rules: unknown = JSON.parse(readTextFile(pjoin(repo, config)))
    if (!Array.isArray(rules)) throw new ValueError(`${config}: 계약 검증 규칙은 배열이어야 한다`)
    for (const rule of rules) {
      const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && pyStrip(s) !== '')
      if (!isRecord(rule) || !strings(rule.files) || !strings(rule.commands)) throw new ValueError(`${config}: 규칙마다 files glob 목록과 commands 명령 목록이 필요하다`)
      const patterns = rule.files
      const affected = changed.filter((rel) => patterns.some((pattern) => matches(rel, pattern) || (isGlob(rel) && matches(pattern, rel))))
      if (!affected.length) continue
      const expected = rule.commands.map((command) => {
        const parsed = commandsOf(`\`\`\`bash\n${command}\n\`\`\``)
        if (parsed.length !== 1 || !parsed[0].length) throw new ValueError(`${config}: commands 의 값 하나에는 명령 하나를 적는다`)
        return parsed[0]
      })
      const present = commands.some((command, i) => expected.some((wanted) => {
        const actual = unwrap(command).slice()
        // cd 로 옮겨 실행한 상대 스크립트도 루트 기준 명령과 대조한다.
        if (actual[0]?.includes('/') && !isAbsolutePath(actual[0])) actual[0] = posixNormpath(posixJoin(cwds[i], actual[0]))
        const target = unwrap(wanted).slice()
        if (target[0]?.startsWith('./')) target[0] = target[0].slice(2)
        return actual.length === target.length && actual.every((arg, j) => arg === target[j])
      }))
      if (!present) out.push(`${path} — 계약 파일 변경에 필요한 검증 명령이 없다: ${affected.join(', ')} (${rule.commands.join(' 또는 ')})`)
    }
  }
}

// 일반 Gradle test 의 필터가 통합 테스트를 골라도 태그 제외로 0건 실행될 수 있다.
// 기존 파일의 표지만 읽는다. 아직 없는 테스트와 실제 태그 제외 설정은 작성자가 확인한다.
function checkIntegrationFilters(path: string, commands: Command[], entries: Entry[], repo: string, warnings: string[]): void {
  const filtered = commands.map(unwrap).filter((command) => ['gradle', 'gradlew'].includes(pathName(command[0] ?? '')) && command.some((arg) => /(?:^|:)test$/.test(arg)))
  if (!filtered.length) return
  const markers = new Map<string | null, string[]>()
  for (const sub of [null, ...subprojects(repo)]) {
    const [value] = overlayValues.lookup(repo, ['plan'], '통합 테스트 표지', sub)
    markers.set(sub, value ? overlayValues.codes(value) : [])
  }
  if (![...markers.values()].some((values) => values.length)) return
  const listed = capture(['git', '-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  const files = listed.code === 0 ? listed.stdout.split('\0') : entries.flatMap(([rel]) => isGlob(rel) ? globRel(repo, globPattern(rel)) : [rel])
  for (const rel of new Set(files.filter((rel) => /\.(?:java|kt)$/.test(rel) && isFile(pjoin(repo, rel))))) {
    const first = rel.split('/')[0]
    const configured = markers.get(markers.has(first) ? first : null)!
    if (!configured.length) continue
    const source = readTextFile(pjoin(repo, rel)).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    if (!configured.some((marker) => source.split('\n').some((line) => {
      const trimmed = pyStrip(line)
      return trimmed.startsWith(marker) && !/[\p{L}\p{N}_$]/u.test(trimmed.slice(marker.length, marker.length + 1))
    }))) continue
    const packageName = /^\s*package\s+([\w.]+)/m.exec(source)?.[1]
    const name = pathStem(rel)
    const fullName = packageName ? `${packageName}.${name}` : name
    for (const command of filtered) {
      const filters = command.flatMap((arg, i) => arg === '--tests' ? [command[i + 1] ?? ''] : arg.startsWith('--tests=') ? [arg.slice(8)] : [])
      if (filters.some((filter) => {
        const classFilter = filter.includes('.') ? filter.slice(0, filter.lastIndexOf('.')) : filter
        return fnmatchcase(name, filter) || fnmatchcase(fullName, filter) || fnmatchcase(name, classFilter) || fnmatchcase(fullName, classFilter)
      })) {
        warnings.push(`${path} — 통합 테스트 표지가 있는 ${rel} 을 일반 test 필터로 실행하면 제외되어 0건일 수 있다. 통합 테스트 실행 명령을 확인한다: ${command.join(' ')}`)
      }
    }
  }
}

// rel 이 저장소 루트 기준 directory 아래다. `.` 은 저장소 전체다
function under(rel: string, directory: string): boolean {
  return directory === '.' || (rel.startsWith('./') ? rel.slice(2) : rel).startsWith(`${directory.replace(/\/+$/, '')}/`)
}

const MARKDOWN_LINK = pyre(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)/g)
const REFERENCE_LINK = pyre(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/)

// phase 안 Markdown 상대 링크를 그 파일 위치 기준으로 풀어 없는 파일이면 위반으로 낸다.
//
// 저장소의 문서 링크 검사기가 같은 기준으로 풀기 때문에, 계획서에서 ADR 이나 docs 를 가리키는
// 링크가 깨지면 계획을 커밋한 뒤 그 검사가 실패한다. 코드 블록과 코드 스팬 안은 보지 않는다
function checkRelativeLinks(path: string, text: string, repo: string, out: string[]): void {
  const base = pathParent(isAbsolutePath(path) ? path : pjoin(repo, path))
  for (const { n, line, kind } of fences(text)) {
    if (kind !== 'text') continue
    const prose = line.replace(/(`+).*?\1/g, '')
    const found = [...prose.matchAll(MARKDOWN_LINK)].map((m) => m[1])
    const reference = REFERENCE_LINK.exec(prose)
    if (reference) found.push(reference[1])
    for (const raw of found) {
      const target = raw.replace(/^[<>]+|[<>]+$/g, '')
      const url = urlsplitPath(target)
      if (url.scheme || url.netloc || !url.path || url.path.startsWith('/')) continue
      if (!existsSync(`${base}/${unquote(url.path)}`)) {
        out.push(`${path}:${n} — 링크 대상 파일이 없다: ${target} (${pathName(path)} 위치 기준). 경로를 이 파일 기준 상대 경로로 고치거나, 링크 대신 백틱 경로로 쓴다`)
      }
    }
  }
}

// 셸 블록의 `sed ... \b` 도 산문과 같이 본다. BSD sed 는 `\b` 를 모른다
function checkCodeSed(path: string, text: string, out: string[]): void {
  for (const { n, line, kind, language } of fences(text)) {
    if (kind === 'code' && SHELL.has(language) && BSD_SED.test(line)) out.push(`${path}:${n} — BSD sed 에서 동작하지 않는 \\b: ${pyStrip(line)}`)
  }
}

// 추가 낱말은 명령 없는 검증 절에 한정해 설계 설명의 오탐을 피한다
function checkHumanVerification(path: string, text: string, out: string[]): void {
  const validation = section(text, '검증')
  if (shellCommands(validation).length === 0) {
    for (const [, line] of iterProse(`## 검증\n${validation}`)) {
      if (HUMAN_ONLY.test(line)) out.push(`${path} — 명령 없는 사람 의존 검증: ${pyStrip(line)}`)
    }
  }
}

// 작업 항목이 함수를 가리키는 형태다. `save()`, `save(user)`, `Repo.save()` 의 마지막 이름을 잡는다
const CALL_REFERENCE = /`(?:[A-Za-z_][\p{L}\p{N}_]*[.:#]+)*([A-Za-z_][\p{L}\p{N}_]*)\([^`]*\)`/gu
const CALLER_LIMIT = 5
// 이름이 이만큼 짧으면(`of`, `now`) 낱말 grep 이 어느 함수의 호출자인지 가리지 못해 건너뛴다
const MIN_CALL_NAME_LENGTH = 4
// 일치 파일이 이 수를 넘으면 `save`, `record` 처럼 어느 저장소에나 있는 이름이다. 파일 목록 대신 한 줄로 줄인다
const COMMON_CALLER_COUNT = 30
// 어느 저장소에나 있는 이름이라 호출자 경고가 거의 모든 파일을 가리킨다(실측: 경고 28건 중 23건).
// 낱말로 grep 하는 한 어느 함수의 호출자인지 가릴 수 없어 건너뛴다. 저장소 고유 이름은 넣지 않는다
const COMMON_CALL_NAMES = new Set([
  'print', 'println', 'printf', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'get',
  'map', 'filter', 'reduce', 'forEach', 'push', 'pop', 'append', 'join', 'split', 'keys', 'values',
  'items', 'open', 'close', 'read', 'write', 'log', 'format', 'init', 'main', 'run', 'test',
  'then', 'catch', 'parse', 'toString', 'equals', 'hashCode', 'size', 'length', 'min', 'max',
  'range', 'sorted', 'sort', 'isinstance', 'super', 'require', 'assert', 'expect',
])

// name 을 낱말로 담은 코드 파일을 낸다. git 저장소가 아니면 빈 목록이다
function gitGrepFiles(repo: string, name: string, exclude: Set<string>): string[] {
  const done = capture(['git', '-C', repo, 'grep', '-l', '-w', '-F', '-e', name])
  if (done.code !== 0 && done.code !== 1) return []
  const prefixes = excludePrefixes(exclude)
  return pySplitLines(done.stdout).filter((rel) => CODE_SUFFIXES.has(pathSuffix(rel)) && !exclude.has(rel) && !prefixes.some((p) => rel.startsWith(p)))
}

const excludePrefixes = (exclude: Set<string>) => [...exclude].filter((rel) => !pathSuffix(rel)).map((rel) => `${rel.replace(/\/+$/, '')}/`)

// 클래스나 객체의 직속 멤버 이름을 찾는다. 중첩된 지역 함수는 뺀다
function jsMembers(source: string, opening: number): Set<string> {
  let depth = 1
  let end = opening + 1
  while (end < source.length && depth) {
    depth += Number(source[end] === '{') - Number(source[end] === '}')
    end += 1
  }
  const body = source.slice(opening + 1, end - 1)
  const depths: number[] = []
  depth = 0
  for (const char of body) {
    // 코드 포인트마다가 아니라 UTF-16 단위마다 쌓는다. 인덱스가 정규식 결과와 같은 단위여야 한다
    for (let k = 0; k < char.length; k++) depths.push(depth)
    depth += Number('{(['.includes(char)) - Number('})]'.includes(char))
  }
  const members = new Set<string>()
  const pattern = new PyRegExp(
    '(?:(?<![^])|[;,\\n}])\\s*(?:(?:public|static|async|get|set|readonly|abstract|declare)\\s+)*([A-Za-z_$][\\p{L}\\p{N}_$]*)\\s*(?=[(:=,]|(?![^]))',
    'dgu',
  )
  for (const match of body.matchAll(pattern)) {
    if (depths[match.indices![1][0]] === 0) members.add(match[1])
  }
  return members
}

const IDENTIFIER = '[A-Za-z_$][\\p{L}\\p{N}_$]*'
const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])'
const WORD_AFTER = '(?![\\p{L}\\p{N}_])'
const LINE_END = '(?![^\\n])'

// TS/JS 는 export 한 이름만, 다른 언어는 기존 낱말 대조로 주인을 찾는다
export function ownsCallName(file: string, name: string): boolean {
  const raw = normalizeNewlines(readFileSync(file).toString('utf8').replaceAll('�', ''))
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(pathSuffix(file))) {
    return new PyRegExp(`${WORD_BEFORE}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${WORD_AFTER}`, 'u').test(raw)
  }
  // 주석과 문자열 속 export 예시는 공개 선언이 아니다. 템플릿 문자열도 함께 뺀다
  const source = raw.replace(pyre(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<![\p{L}\p{N}_$])'(?:\\[^\n]|[^'\\\n])*'|"(?:\\[^\n]|[^"\\\n])*"|`(?:\\[^\n]|[^`\\])*`/gu), ' ')
  const declarations = [...source.matchAll(new PyRegExp(`${WORD_BEFORE}export\\s+(?:default\\s+)?(?:(?:async|abstract|declare)\\s+)*(?:function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+|class\\s+)(${IDENTIFIER})`, 'gu'))].map((m) => m[1])
  const defaults = [...source.matchAll(new PyRegExp(`${WORD_BEFORE}export\\s+default\\s+(${IDENTIFIER})\\s*(?=;|${LINE_END})`, 'gu'))].map((m) => m[1])
  const exported = new Set([...declarations, ...defaults])
  const commonjs = '(?<![\\p{L}\\p{N}_$.])(?:module\\s*\\.\\s*exports|exports)'
  for (const m of source.matchAll(new PyRegExp(`${commonjs}\\s*\\.\\s*(${IDENTIFIER})\\s*=(?!=|>)`, 'gu'))) exported.add(m[1])
  for (const m of source.matchAll(new PyRegExp(`${commonjs}\\s*=\\s*(${IDENTIFIER})\\s*(?=;|${LINE_END})`, 'gu'))) exported.add(m[1])
  const containers = new Set(exported)
  for (const listing of source.matchAll(new PyRegExp(`${WORD_BEFORE}export\\s*\\{([^}]*)\\}`, 'gu'))) {
    for (const item of listing[1].split(',')) {
      const match = new PyRegExp(`^\\s*(${IDENTIFIER})(?:\\s+as\\s+(${IDENTIFIER}))?\\s*$`, 'u').exec(item)
      if (match) {
        exported.add(match[2] ?? match[1])
        containers.add(match[1])
      }
    }
  }
  for (const container of source.matchAll(new PyRegExp(`${WORD_BEFORE}(?:class\\s+(${IDENTIFIER})[^{;]*|(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*)\\{`, 'gu'))) {
    if (containers.has(container[1] ?? container[2])) {
      if (jsMembers(source, container.index + container[0].length - 1).has(name)) return true
    }
  }
  for (const container of source.matchAll(new PyRegExp(`${WORD_BEFORE}export\\s+default\\s+(?:class\\s*)?\\{`, 'gu'))) {
    if (jsMembers(source, container.index + container[0].length - 1).has(name)) return true
  }
  for (const container of source.matchAll(new PyRegExp(`${commonjs}\\s*=\\s*\\{`, 'gu'))) {
    if (jsMembers(source, container.index + container[0].length - 1).has(name)) return true
  }
  return exported.has(name)
}

// 수정하는 함수의 호출자가 plan 의 변경 파일에 빠졌는지 본다.
//
// phaseEntries 는 [phase 경로, 작업 항목 절, 변경 파일 목록] 이다.
// 이름을 낱말로 grep 하므로 같은 이름의 다른 함수도 걸린다. 그래서 위반이 아니라 경고로 낸다.
// 호출자가 바꿀 필요가 없으면 그대로 두고, 바꿔야 하면 그 파일을 변경 파일 표에 넣는다
export function checkCallers(phaseEntries: [string, string, Entry[]][], repo: string, tasksDir: string, warnings: string[]): void {
  const planned = new Set(phaseEntries.flatMap(([, , entries]) => entries.map(([rel]) => rel)))
  planned.add(tasksDir)
  for (const [path, work, entries] of phaseEntries) {
    const modified = entries.filter(([rel, action]) => (action === '수정' || action === '삭제') && CODE_SUFFIXES.has(pathSuffix(rel)) && !isGlob(rel)).map(([rel]) => rel)
    if (modified.length === 0) continue
    const names = [...new Set([...work.matchAll(CALL_REFERENCE)].map((m) => m[1]).filter((n) => !COMMON_CALL_NAMES.has(n) && pyLen(n) >= MIN_CALL_NAME_LENGTH))]
    const tooCommon: string[] = []
    for (const name of names) {
      const owners = modified.filter((rel) => isFile(`${repo}/${rel}`) && ownsCallName(`${repo}/${rel}`, name))
      if (owners.length === 0) continue
      const callers = gitGrepFiles(repo, name, planned)
      if (callers.length > COMMON_CALLER_COUNT) tooCommon.push(`\`${name}\` ${callers.length}개`)
      else if (callers.length) {
        const shown = callers.slice(0, CALLER_LIMIT).join(', ') + (callers.length > CALLER_LIMIT ? ` 외 ${callers.length - CALLER_LIMIT}개` : '')
        warnings.push(`${path} — \`${name}\` 을 쓰는 파일이 plan 의 변경 파일에 없다: ${shown}. 시그니처나 동작이 바뀌어 고쳐야 하면 변경 파일 표에 넣는다`)
      }
    }
    if (tooCommon.length) {
      warnings.push(`${path} — 너무 흔한 이름이라 호출자를 가리지 못해 건너뛴다: ${tooCommon.join(', ')}. 호출부가 바뀌면 \`git grep\` 에 클래스 이름을 함께 줘서 직접 찾는다`)
    }
  }
}

const USAGE = `usage: verify_task.ts [-h] [--require-verification] [--audit] [--staged PHASE] [--tasks-dir TASKS_DIR] [plan]

task 생성 직후 자동 검증. 사용법과 검사 항목은 이 파일 머리 주석이 설명한다.

positional arguments:
  plan

options:
  -h, --help            show this help message and exit
  --require-verification
                        새 기능 계획의 인수 검증 계획을 요구한다
  --audit               구현 후 문서 검사. 구현 전 파일 상태는 대조하지 않는다
  --staged PHASE        phase 변경 파일 목록과 git index 대조
  --tasks-dir TASKS_DIR
                        계획서 디렉터리. 저장소 루트 기준 (기본값 tasks)
`

const SPEC: Spec = {
  options: [
    { name: 'require-verification', value: false },
    { name: 'audit', value: false },
    { name: 'staged', value: true },
    { name: 'tasks-dir', value: true },
  ],
  positionals: [{ name: 'plan', nargs: '?' }],
}

export function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseCli(argv, SPEC)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    write(2, `${USAGE.split('\n')[0]}\nverify_task.ts: error: ${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    write(1, USAGE)
    return 0
  }
  const plan = parsed.positionals.plan as string | undefined
  const stagedArg = parsed.options.staged as string | undefined
  const audit = parsed.options.audit === true
  const requireVerification = parsed.options['require-verification'] === true
  const tasksDir = (parsed.options['tasks-dir'] as string | undefined) ?? 'tasks'
  if (Boolean(plan) === (stagedArg !== undefined) || (audit && stagedArg !== undefined) || (requireVerification && stagedArg !== undefined)) {
    write(2, 'plan 또는 --staged PHASE 중 하나를 지정한다\n')
    return 2
  }
  const repo = process.cwd()
  const out: string[] = []
  const warnings: string[] = []
  try {
    if (stagedArg !== undefined) {
      const staged = pyPath(stagedArg)
      checkStaged(staged, readTextFile(staged), repo, out, warnings)
    } else {
      if (pathName(plan!) !== plan) throw new ValueError(`plan 은 ${tasksDir}/ 아래 디렉터리 이름이어야 한다`)
      const planDir = pjoin(repo, tasksDir, plan!)
      const phases = globRel(planDir, 'phase-*.md')
        .map((name) => pjoin(planDir, name))
        .sort(pyStrCompare)
      if (phases.length === 0) throw new ValueError(`phase 파일 없음: ${planDir}`)
      checkIndex(`${planDir}/index.json`, plan!, phases, out)
      const index = JSON.parse(readTextFile(`${planDir}/index.json`)) as unknown
      if (isRecord(index)) {
        checkPrScope(`${planDir}/index.json`, index, out, warnings)
        // 기존 계획은 그대로 두고, 기능 계획만 스펙/요구사항 연결을 검사한다
        if ('spec' in index) {
          const checked = checkFeature([pyStrAny(index.spec), '--plan', `${planDir}/index.json`, ...(requireVerification ? ['--require-verification'] : [])], repo)
          if (checked.code) out.push(`${planDir} — 기능 계약 검사 실패: ${pyStrip(checked.stdout + checked.stderr)}`)
        } else if (requireVerification) out.push(`${planDir} — 인수 검증 계획 검사는 spec 이 있는 기능 계획에 적용한다`)
      }
      checkPlanNumber(repo, tasksDir, plan!, out, warnings)
      const remote = `${planDir}/remote-verification.md`
      if (isFile(remote)) checkRemoteVerification(remote, out, warnings)
      const virtual = new Map<string, boolean>()
      const created: string[] = []
      const phaseEntries: [string, string, Entry[]][] = []
      const allFiles = new Set<string>()
      const allEntries = new Set<string>()
      if (audit) warnings.push('구현 후 문서 검사: 신규/수정/삭제 파일의 구현 전 존재 조건은 대조하지 않는다')
      let policyPlanned = false
      for (const path of phases) {
        const text = readTextFile(path)
        for (const marker of REQUIRED_SECTIONS) if (!text.includes(marker)) out.push(`${path} — 필수 섹션 누락: ${marker}`)
        const entries = manifest(path, text, out, warnings)
        for (const [rel, action] of entries) {
          allFiles.add(rel)
          allEntries.add(`${rel}\0${action}`)
        }
        policyPlanned ||= entries.some(([rel, action]) => rel === 'scripts/runtime-policy.json' && (action === '수정' || action === '신규'))
        if (audit || !policyPlanned) checkNewJsPolicy(path, entries, repo, out, warnings)
        if (!audit) checkFileState(path, entries, repo, virtual, out, warnings, legacyManifest(text), created)
        checkBashCwd(path, text, out)
        for (const [n, line] of iterProse(text)) {
          if (vagueScope(line)) out.push(`${path}:${n} — 모호한 범위 지시: ${pyStrip(line)}`)
          if (HUMAN_CHECK.test(line)) out.push(`${path}:${n} — 사람 의존 검증: ${pyStrip(line)}`)
          if (BSD_SED.test(line)) out.push(`${path}:${n} — BSD sed 에서 동작하지 않는 \\b: ${pyStrip(line)}`)
        }
        checkCodeSed(path, text, out)
        checkRelativeLinks(path, text, repo, out)
        checkHumanVerification(path, text, out)
        checkPhasePrompt(path, text, out, entries, repo, warnings)
        phaseEntries.push([path, section(text, '작업 항목'), entries])
      }
      const testEntries = phaseEntries.flatMap(([, , entries]) => entries)
      for (const phase of phases) {
        const text = readTextFile(phase)
        checkTestReferences(phase, section(text, '검증') + '\n' + section(text, '인수 검증 계획'), testEntries, repo, out)
      }
      if (isRecord(index) && typeof index.verification_plan === 'string') {
        const verification = pjoin(planDir, index.verification_plan)
        if (isFile(verification) && !phases.includes(verification)) checkTestReferences(verification, section(readTextFile(verification), '인수 검증 계획'), testEntries, repo, out)
      }
      if (!audit) checkEstimatedSize(`${planDir}/index.json`, allEntries, repo, warnings)
      const planRel = `${tasksDir.replace(/\/+$/, '')}/${plan}`
      const [fileLimit, lengthLimit] = repoLimits(repo, planRel, warnings)
      checkChangedFileCount(`${planDir}/index.json`, allFiles, warnings, fileLimit, phaseEntries.map(([phase, , rels]) => [phase, new Set(rels.map(([rel]) => rel))] as [string, Set<string>]), planRel)
      if (lengthLimit && !audit) checkFileLength(`${planDir}/index.json`, allEntries, repo, lengthLimit, warnings)
      if (!audit) checkCallers(phaseEntries, repo, tasksDir, warnings)
    }
  } catch (error) {
    if (!isExpected(error)) throw error
    write(2, `검사를 실행하지 못했다: ${error.message}\n`)
    return 2
  }
  write(1, `${[...out, ...warnings.map((w) => `경고: ${w}`), `위반 ${out.length}건, 경고 ${warnings.length}건`].join('\n')}\n`)
  return out.length ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
