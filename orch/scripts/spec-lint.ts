// worker 를 띄우기 전에 지시서끼리, 그리고 저장소 계약과 어긋나는 곳을 찾는다.
//
// 지시서를 띄운 뒤에야 담당 파일이 겹치거나, 가리킨 함수가 없거나, 금지 명령을 요구한다는 것을 알게 되면
// worker 가 ask 로 멈추거나 먼저 머지된 쪽 때문에 뒤 PR 이 충돌한다. 띄우기 전에 한 번 돌린다.
//
// 사용법:
//     spec-lint.ts --repo DIR [--overlay FILE] [--active FILE ...] SPEC [SPEC ...]
//     spec-lint.ts --repo DIR [--overlay FILE] --check-overlay [--base main] [SPEC ...]
//
//     --repo     대상 저장소. 존재 확인과 담당 경로 확장을 이 저장소의 git 으로 한다
//     --overlay  저장소 값을 읽을 파일. 없으면 <orch 작업 폴더>/overlay.md 를 읽고, 그것도 없으면 저장소 값 없이 돈다
//     SPEC       검사할 지시서. 공통 지시서(spec-common.md)는 넘기지 않는다
//     --active   이미 띄운 지시서. 여러 번 준다. SPEC 과 같이 검사하되 선택 검사만 하지 않는다.
//                선택 줄을 강제하기 전에 띄운 worker 의 지시서가 새 지시서의 띄우기를 막지 않게 한다(launch-worker 가 쓴다)
//     --check-overlay  오버레이와 <orch 작업 폴더>/config.json 이 가리키는 경로가 origin/<base> 에 있는지도 본다.
//                      이 옵션을 주면 SPEC 을 생략할 수 있다. `--overlay` 는 지금처럼 오버레이 파일 위치다
//     --base     --check-overlay 가 대조할 기준 브랜치. 기본 main. fetch 하지 않고 지금 있는 origin/<base> 를 본다
//
// 지시서에서 읽는 줄:
//     담당: `src/a/**`, `docs/a.md`     그 worker 가 고치는 경로. glob 을 쓴다. 여러 줄이어도 된다
//     예외: ...                          그 줄은 금지 문구와 존재 확인에서 뺀다
//     worker 선택: ...                   고른 에이전트, 모델, effort 와 비교한 후보, 고른 이유. 형식은 lib/spec.ts 의 selectionsOf 가 소유한다
//
// 오버레이의 `## spec-lint` 절에서 읽는 줄 (저장소 값은 여기에만 둔다):
//     코디네이터 소유: `docs/adr/**`, `CHANGELOG.md`   어느 지시서도 담당으로 가질 수 없는 경로
//     소유: `src/net/**` spec-net                       그 경로는 이름이 그 값인 지시서만 담당으로 가질 수 있다
//     금지 문구: `rm -rf`, `pkill`                      지시서가 요구하면 안 되는 명령. 기본 목록에 더한다
//
// glob 은 Python 의 fnmatch 규칙이다. `*` 는 `/` 도 넘는다. 옮기기 전 spec-lint.py 와 판정이 같게 하려는 것이다.
//
// 검사 (발견마다 `<파일>:<줄>: <종류>: <내용>` 한 줄):
//     겹침        두 지시서의 담당 경로가 같은 파일을 가리킨다. 둘 다 glob 이면 패턴끼리도 대조한다
//     코디네이터  담당 경로가 코디네이터 소유 경로와 겹친다
//     소유        담당 경로가 다른 지시서 소유로 정한 경로와 겹친다
//     없음        백틱 안의 함수 호출 꼴(`name()`, `Class.method()`)이 저장소에 없다(`git grep -w`)
//     금지        금지 문구가 든 줄인데 그 줄에 부정 표현(않, 말고, 대신, 금지, 없이)이 없다
//     선택        `worker 선택:` 줄이 없거나, 둘 이상이거나, 에이전트, 모델, effort, 비교, 이유 가운데 빠진 것이 있다.
//                 모델을 비교 없이 익숙한 쪽으로 고르는 일을 막는다. launch-worker 도 같은 줄로 --agent, --model 을 대조한다
//     경로        백틱 안의 파일 경로(확장자가 있는 것)가 저장소에 없다. 파일 이름만 적었으면 어느 폴더에든 있으면 된다.
//                 새로 만들 파일일 수 있어 경고이고 종료 코드에 넣지 않는다
//     공통        지시서 폴더의 spec-common.md 에 틀(orch/templates/spec-common.md)의 `<!-- orch-rule: <이름> -->` 표지가 빠졌다.
//                 표지는 틀이 요구하는 완료 규칙(준비됨 status, MERGED 확인 뒤 worker_done)을 가리킨다. 공통 지시서가 틀보다 낡으면
//                 worker 가 옛 규칙대로 PR 을 열자마자 worker_done 을 보낸다. 문장이 아니라 표지로 판정한다. 저장소가 그 규칙을 일부러 바꿨을 수
//                 있어 경고이고 종료 코드에 넣지 않는다. 지시서 폴더에 spec-common.md 가 없으면 보지 않는다
//     제목        `# ` 제목 줄도 `보드 항목 id:` 줄도 없다. 보드 항목 제목이 업무 연결 줄, `## 목표` 첫 문장, 워크트리 이름으로 밀려나
//                 보드에 업무 목적이 보이지 않을 수 있다(lib/board.ts 의 specTitle). 경고이고 종료 코드에 넣지 않는다
//     오버레이    (--check-overlay) 오버레이의 백틱 값과 config.json 의 문자열 값에서 읽은 상대 경로가 origin/<base> 에 없다.
//                 명령(`bash scripts/verify.sh --fast`)이면 낱말마다 본다. `/` 가 든 확장자 있는 낱말만 경로로 본다.
//                 파일 이름만 적은 것(스킬 스크립트일 수 있다), 절대경로, `~`, `$`, glob, `<...>` 가 든 값,
//                 git 이 무시하는 경로(`.orch/` 같은 로컬 폴더)는 보지 않는다.
//                 첫 마디가 origin/<base> 의 최상위 항목이 아닌 경로(다른 저장소, 스킬 문서, scratchpad, `origin/...`)도 보지 않는다.
//                 오버레이에서 `예외:` 로 시작하는 줄은 건너뛴다.
//                 로컬에만 있는 스크립트를 오버레이가 부르면 다른 워크트리와 worker 에서 그 단계가 「파일 없음」 으로 멈춘다
//
// 종료 코드:
//     0  막을 발견이 없다(경로, 공통, 제목 경고는 있을 수 있다)
//     1  겹침, 코디네이터, 소유, 없음, 금지, 선택, 오버레이 중 하나 이상
//     2  사용법 오류, 또는 저장소, 지시서, origin/<base>, config.json 을 읽지 못했다.
//        --overlay 없이 orch 작업 폴더를 옮기기 전에 돌려도 2 다(lib/paths.ts 머리 주석의 「옛 구조」)
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { isFile } from './lib/fs.ts'
import { git } from './lib/git.ts'
import { pathOf, requireMigrated } from './lib/paths.ts'
import { LINE_BREAK, SELECTION_FORMAT, selectionsOf } from './lib/spec.ts'

const USAGE = [
  '사용법: spec-lint.ts --repo DIR [--overlay FILE] SPEC [SPEC ...]',
  '        spec-lint.ts --repo DIR [--overlay FILE] --check-overlay [--base main] [SPEC ...]',
].join('\n')

const DEFAULT_FORBIDDEN = ['--no-verify', 'push --force', 'push -f ', 'reset --hard', 'pkill', 'killall']
const NEGATION = ['않', '말고', '대신', '금지', '없이']
const TICK = /`([^`]+)`/g
// 낱말 글자는 Python 의 \w 처럼 한글을 포함한 유니코드 글자와 숫자, 밑줄이다. JavaScript 의 \w 는 ASCII 만 본다.
const W = '\\p{L}\\p{N}_'
const CALL = new RegExp(`^(?:[A-Za-z_][${W}]*\\.)*([A-Za-z_][${W}]*)\\(\\)$`, 'u')
// 마지막 마디에 확장자가 있는 것만 경로로 본다. `mac/battle-join` 같은 브랜치 이름과 `feature/` 같은 접두를 빼려는 것이다
const PATHLIKE = new RegExp(`^(?:[${W}.\\-]+/)*[${W}\\-]+(?:\\.[${W}\\-]+)*\\.[A-Za-z]{1,5}$`, 'u')

// 저장소 공통 지시서가 따라야 할 틀. SPEC_TEMPLATE 은 테스트가 바꾼다
const TEMPLATE = process.env.SPEC_TEMPLATE || join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'spec-common.md')
const COMMON = 'spec-common.md'
const RULE_MARK = /<!--\s*orch-rule:\s*([A-Za-z0-9_-]+)\s*-->/g

class UsageError extends Error {}

function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function ticks(line: string): string[] {
  return [...line.matchAll(TICK)].map((m) => m[1])
}

function stripChars(text: string, chars: string): string {
  let start = 0
  let end = text.length
  while (start < end && chars.includes(text[start])) start += 1
  while (end > start && chars.includes(text[end - 1])) end -= 1
  return text.slice(start, end)
}

function removePrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

// `이름:` 으로 시작하는 줄이면 그 뒤 글. 목록 기호와 굵게는 무시한다. 아니면 null.
function field(line: string, name: string): string | null {
  let stripped = removePrefix(removePrefix(line.trim(), '- '), '* ').trim()
  stripped = stripped.replace(/^\*\*([^*]+?)\*\*/, '$1')
  if (!stripped.startsWith(`${name}:`)) return null
  return stripped.slice(name.length + 1)
}

// Python fnmatch.translate 를 옮겼다. 대소문자를 가리고 `*` 와 `?` 는 `/` 도 받는다.
const PATTERNS = new Map<string, RegExp>()
const NEVER = /(?!)/

function translate(pattern: string): RegExp {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    i += 1
    if (c === '*') {
      out += '.*'
      while (pattern[i] === '*') i += 1
    } else if (c === '?') {
      out += '.'
    } else if (c === '[') {
      let j = i
      if (pattern[j] === '!') j += 1
      if (pattern[j] === ']') j += 1
      while (j < pattern.length && pattern[j] !== ']') j += 1
      if (j >= pattern.length) {
        out += '\\['
      } else {
        let stuff = pattern.slice(i, j).replaceAll('\\', '\\\\')
        i = j + 1
        if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`
        else if (stuff.startsWith('^')) stuff = `\\${stuff}`
        out += `[${stuff}]`
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^(?:${out})$`, 's')
  } catch {
    // `[z-a]` 처럼 범위가 거꾸로 된 패턴이다. Python 은 이것을 아무것과도 맞지 않는 패턴으로 바꾼다
    return NEVER
  }
}

function fnmatch(name: string, pattern: string): boolean {
  let re = PATTERNS.get(pattern)
  if (!re) {
    re = translate(pattern)
    PATTERNS.set(pattern, re)
  }
  return re.test(name)
}

class Repo {
  root: string
  files: string[]

  constructor(root: string) {
    this.root = root
    const done = git(root, ['ls-files'])
    if (done.code !== 0) throw new UsageError(`git 저장소가 아니다: ${root}`)
    this.files = splitLines(done.stdout)
  }

  expand(pattern: string): Set<string> {
    const p = pattern.replace(/\/+$/, '')
    const hits = new Set(this.files.filter((f) => fnmatch(f, p) || f.startsWith(`${p}/`)))
    return hits.size > 0 ? hits : new Set([p])
  }

  exists(target: string): boolean {
    const p = target.replace(/\/+$/, '')
    // 파일 이름만 적은 것은 어느 폴더에든 있으면 있다고 본다
    if (!p.includes('/')) return this.files.some((f) => f === p || f.endsWith(`/${p}`))
    return existsSync(join(this.root, p)) || this.files.some((f) => f === p || f.startsWith(`${p}/`))
  }

  hasName(name: string): boolean {
    return git(this.root, ['grep', '-qw', name]).code === 0
  }
}

// 값에서 저장소 상대 경로로 볼 낱말. 명령이면 낱말마다 본다.
function pathWords(value: string): string[] {
  const found: string[] = []
  for (const raw of value.split(/\s+/)) {
    const word = removePrefix(stripChars(raw, `"'(),;`), './')
    if (!word.includes('/') || /^[/~-]/.test(word) || /[$*?<>{}[\]=]/.test(word)) continue
    if (PATHLIKE.test(word)) found.push(word)
  }
  return found
}

function* strings(node: unknown): Generator<string> {
  if (typeof node === 'string') yield node
  else if (Array.isArray(node)) for (const value of node) yield* strings(value)
  else if (typeof node === 'object' && node !== null) for (const value of Object.values(node)) yield* strings(value)
}

type Ref = { file: string; no: number; word: string }

// 오버레이는 백틱 값, config.json 은 문자열 값에서 읽는다.
function overlayRefs(repoRoot: string, overlay: string | null): Ref[] {
  const refs: Ref[] = []
  if (overlay && isFile(overlay)) {
    splitLines(readFileSync(overlay, 'utf8')).forEach((line, index) => {
      if (field(line, '예외') !== null) return
      for (const tok of ticks(line)) for (const word of pathWords(tok)) refs.push({ file: overlay, no: index + 1, word })
    })
  }
  const config = pathOf('config', repoRoot)
  if (isFile(config)) {
    const text = readFileSync(config, 'utf8')
    const lines = splitLines(text)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new UsageError(`${config} 를 JSON 으로 읽지 못했다: ${(e as Error).message}`)
    }
    for (const value of strings(parsed)) {
      for (const word of pathWords(value)) {
        const no = lines.findIndex((line) => line.includes(word)) + 1
        refs.push({ file: config, no, word })
      }
    }
  }
  return refs
}

// origin/<base> 에 없는 오버레이 경로마다 한 줄.
function checkOverlay(repoRoot: string, overlay: string | null, base: string): string[] {
  const ref = `origin/${base}`
  const done = git(repoRoot, ['ls-tree', '-r', '--name-only', ref])
  if (done.code !== 0) throw new UsageError(`${ref} 를 읽지 못했다`)
  const files = new Set(splitLines(done.stdout))
  const top = new Set([...files].map((f) => f.split('/', 1)[0]))
  const errors: string[] = []
  for (const { file, no, word } of overlayRefs(repoRoot, overlay)) {
    // 다른 저장소나 스킬 쪽 경로일 수 있다. 이 저장소의 경로인지 알 수 없으면 막지 않는다
    if (!top.has(word.split('/', 1)[0])) continue
    const dir = `${word.replace(/\/+$/, '')}/`
    if (files.has(word) || [...files].some((f) => f.startsWith(dir))) continue
    if (git(repoRoot, ['check-ignore', '-q', '--no-index', word]).code === 0) continue
    errors.push(`${basename(file)}:${no}: 오버레이: \`${word}\` 가 ${ref} 에 없다`)
  }
  return errors
}

function overlap(repo: Repo, a: string, b: string): boolean {
  if (fnmatch(a, b) || fnmatch(b, a)) return true
  const left = repo.expand(a)
  for (const hit of repo.expand(b)) if (left.has(hit)) return true
  return false
}

function readOverlay(path: string | null): { coordinator: string[]; owners: [string, string][]; forbidden: string[] } {
  const coordinator: string[] = []
  const owners: [string, string][] = []
  const forbidden = [...DEFAULT_FORBIDDEN]
  if (!path || !isFile(path)) return { coordinator, owners, forbidden }
  let inSection = false
  for (const line of splitLines(readFileSync(path, 'utf8'))) {
    if (line.startsWith('## ')) {
      inSection = line.slice(3).trim() === 'spec-lint'
      continue
    }
    if (!inSection) continue
    let rest: string | null
    if ((rest = field(line, '코디네이터 소유')) !== null) {
      coordinator.push(...ticks(rest))
    } else if ((rest = field(line, '소유')) !== null) {
      const owner = rest.replace(TICK, '').trim()
      if (owner) for (const glob of ticks(rest)) owners.push([glob, owner])
    } else if ((rest = field(line, '금지 문구')) !== null) {
      forbidden.push(...ticks(rest))
    }
  }
  return { coordinator, owners, forbidden }
}

// 제목 경고의 본문. 고르는 순서는 lib/board.ts 의 specTitle 이 소유한다
const TITLE_HINT =
  '`# ` 제목 줄도 `보드 항목 id:` 도 없다. 보드 항목 제목은 `# ` 제목 줄, `보드 항목 id` 의 기존 항목 제목, 업무 연결 줄의 제목, ' +
  '`## 목표` 첫 문장, id 순으로 고른다. 첫 줄 예: `# 보드 항목이 업무의 목적을 보이게 한다`'

type Spec = { path: string; name: string; stem: string; owned: [string, number][]; lines: string[] }

function readSpec(path: string): Spec {
  const lines = splitLines(readFileSync(path, 'utf8'))
  const owned: [string, number][] = []
  lines.forEach((line, index) => {
    const rest = field(line, '담당')
    if (rest !== null) for (const glob of ticks(rest)) owned.push([glob, index + 1])
  })
  const name = basename(path)
  return { path: normalize(path), name, stem: basename(path, extname(path)), owned, lines }
}

function ruleMarks(text: string): Set<string> {
  return new Set([...text.matchAll(RULE_MARK)].map((m) => m[1]))
}

// 머리 주석의 「공통」. 지시서 폴더마다 한 번 본다
function staleCommon(specs: string[]): string[] {
  let required: Set<string>
  try {
    required = ruleMarks(readFileSync(TEMPLATE, 'utf8'))
  } catch {
    return []
  }
  const found: string[] = []
  for (const dir of new Set(specs.map((s) => dirname(normalize(s))))) {
    const common = join(dir, COMMON)
    if (!isFile(common)) continue
    const has = ruleMarks(readFileSync(common, 'utf8'))
    const missing = [...required].filter((name) => !has.has(name))
    if (missing.length > 0) {
      found.push(
        `${common}:1: 공통: 틀의 규칙 표지 ${missing.map((m) => `\`${m}\``).join(', ')} 가 없다. ` +
          `공통 지시서가 틀(${TEMPLATE})보다 낡았을 수 있다. 틀에서 그 표지가 붙은 줄을 옮긴다`,
      )
    }
  }
  return found
}

// 머리 주석의 「선택」. 줄이 없으면 1번 줄에 낸다
function selectionErrors(spec: Spec): string[] {
  const found = selectionsOf(spec.lines.join('\n'))
  if (found.length === 0) return [`${spec.name}:1: 선택: \`worker 선택:\` 줄이 없다. 형식: ${SELECTION_FORMAT}`]
  const errors: string[] = []
  for (const extra of found.slice(1)) errors.push(`${spec.name}:${extra.no}: 선택: \`worker 선택:\` 줄이 둘 이상이다. 하나만 둔다`)
  const [first] = found
  if (first.problems.length > 0) errors.push(`${spec.name}:${first.no}: 선택: ${first.problems.join(', ')} 가 빠졌다. 형식: ${SELECTION_FORMAT}`)
  return errors
}

function lint(repo: Repo, specs: string[], overlay: string | null, active: string[] = []): { errors: string[]; warnings: string[] } {
  const { coordinator, owners, forbidden } = readOverlay(overlay)
  const errors: string[] = []
  const warnings: string[] = []
  // 같은 지시서를 두 번 넘기면 한 번만 본다. 자기 자신과 겹친다고 하지 않게 한다
  const launched = new Set(active.map((s) => normalize(s)))
  const parsed = [...new Map([...specs, ...active].map((s) => [normalize(s), s])).values()].map(readSpec)

  for (let i = 0; i < parsed.length; i += 1) {
    for (const b of parsed.slice(i + 1)) {
      const a = parsed[i]
      for (const [ga, na] of a.owned) {
        for (const [gb] of b.owned) {
          if (overlap(repo, ga, gb)) errors.push(`${a.name}:${na}: 겹침: \`${ga}\` 와 ${b.name} 의 \`${gb}\``)
        }
      }
    }
  }

  for (const spec of parsed) {
    if (!launched.has(spec.path)) errors.push(...selectionErrors(spec))
    if (!spec.lines.some((line) => /^#\s+\S/.test(line) || field(line, '보드 항목 id') !== null)) {
      warnings.push(`${spec.name}:1: 제목: ${TITLE_HINT}`)
    }
    for (const [glob, no] of spec.owned) {
      for (const c of coordinator) {
        if (overlap(repo, glob, c)) errors.push(`${spec.name}:${no}: 코디네이터: \`${glob}\` 가 코디네이터 소유 \`${c}\` 와 겹친다`)
      }
      for (const [g, owner] of owners) {
        if (owner !== spec.stem && owner !== removePrefix(spec.stem, 'spec-') && overlap(repo, glob, g)) {
          errors.push(`${spec.name}:${no}: 소유: \`${glob}\` 는 ${owner} 소유 \`${g}\` 와 겹친다`)
        }
      }
    }
    spec.lines.forEach((line, index) => {
      const no = index + 1
      if (field(line, '예외') !== null || field(line, '담당') !== null) return
      for (const phrase of forbidden) {
        if (line.includes(phrase) && !NEGATION.some((n) => line.includes(n))) {
          errors.push(`${spec.name}:${no}: 금지: \`${phrase.trim()}\` 를 요구한다`)
        }
      }
      for (const raw of ticks(line)) {
        const tok = raw.trim()
        const call = CALL.exec(tok)
        if (call) {
          if (!repo.hasName(call[1])) errors.push(`${spec.name}:${no}: 없음: \`${tok}\` 를 저장소에서 찾지 못했다`)
        } else if (PATHLIKE.test(tok) && !/[*<{]/.test(tok) && !repo.exists(tok)) {
          warnings.push(`${spec.name}:${no}: 경로: \`${tok}\` 가 저장소에 없다(새 파일이면 무시)`)
        }
      }
    })
  }
  warnings.push(...staleCommon(specs))
  return { errors, warnings }
}

function main(argv: string[]): number {
  let parsed
  try {
    const options = {
      repo: { type: 'string' },
      overlay: { type: 'string' },
      'check-overlay': { type: 'boolean' },
      base: { type: 'string', default: 'main' },
      active: { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', short: 'h' },
    } as const
    parsed = parseArgs({ args: expandArgs(argv, options), options, allowPositionals: true })
  } catch (e) {
    process.stderr.write(`${USAGE}\nspec-lint: ${(e as Error).message}\n`)
    return 2
  }
  const { values, positionals: specs } = parsed
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.repo) {
    process.stderr.write(`${USAGE}\nspec-lint: --repo 가 필요하다\n`)
    return 2
  }
  if (specs.length === 0 && !values['check-overlay']) {
    process.stderr.write('spec-lint: 지시서를 하나 이상 주거나 --check-overlay 를 준다\n')
    return 2
  }
  const active = values.active as string[]
  const missing = [...specs, ...active].filter((s) => !isFile(s))
  if (missing.length > 0) {
    process.stderr.write(`spec-lint: 지시서를 읽지 못했다: ${missing.join(', ')}\n`)
    return 2
  }
  try {
    const repo = new Repo(values.repo)
    if (!values.overlay && !requireMigrated(values.repo, 'spec-lint', '오버레이를 --overlay 로 직접 준다')) return 2
    const overlay = values.overlay ?? pathOf('overlay', values.repo)
    const { errors, warnings } = specs.length > 0 ? lint(repo, specs, overlay, active) : { errors: [], warnings: [] }
    if (values['check-overlay']) errors.push(...checkOverlay(values.repo, overlay, values.base as string))
    for (const line of [...errors, ...warnings]) process.stdout.write(`${line}\n`)
    const titles = warnings.filter((line) => line.includes(': 제목: ')).length
    const commons = warnings.filter((line) => line.includes(': 공통: ')).length
    const tail = (titles > 0 ? `, 제목 경고 ${titles}건` : '') + (commons > 0 ? `, 공통 경고 ${commons}건` : '')
    process.stderr.write(`spec-lint: 막을 발견 ${errors.length}건, 경로 경고 ${warnings.length - titles - commons}건${tail}\n`)
    return errors.length > 0 ? 1 : 0
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    process.stderr.write(`spec-lint: ${e.message}\n`)
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))
