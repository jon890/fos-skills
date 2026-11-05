// worker 를 띄우기 전에 지시서끼리, 그리고 저장소 계약과 어긋나는 곳을 찾는다.
//
// 지시서를 띄운 뒤에야 담당 파일이 겹치거나, 가리킨 함수가 없거나, 금지 명령을 요구한다는 것을 알게 되면
// worker 가 ask 로 멈추거나 먼저 머지된 쪽 때문에 뒤 PR 이 충돌한다. 띄우기 전에 한 번 돌린다.
//
// 사용법:
//     spec-lint.ts --repo DIR [--overlay FILE] [--base BRANCH] [--spec-ref REF | --spec-root DIR] [--active FILE ...] SPEC [SPEC ...]
//     spec-lint.ts --repo DIR [--overlay FILE] --check-overlay [--base main] [SPEC ...]
//
//     --repo     대상 저장소. 존재 확인과 담당 경로 확장을 이 저장소의 git 으로 한다
//     --overlay  저장소 값을 읽을 파일. 없으면 <orch 작업 폴더>/overlay.md 를 읽고, 그것도 없으면 저장소 값 없이 돈다
//     SPEC       검사할 지시서. 공통 지시서(spec-common.md)는 넘기지 않는다
//     --active   이미 띄운 지시서. 여러 번 준다. 선택 검사와 루프 검사는 하지 않고, 활성 지시서끼리의 겹침은 경고로 낸다.
//                두 줄을 강제하기 전에 띄운 worker 의 지시서가 새 지시서의 띄우기를 막지 않게 한다(launch-worker 가 쓴다)
//     --check-overlay  오버레이와 <orch 작업 폴더>/config.json 이 가리키는 경로가 origin/<base> 에 있는지도 본다.
//                      이 옵션을 주면 SPEC 을 생략할 수 있다. `--overlay` 는 지금처럼 오버레이 파일 위치다
//     --base     --check-overlay 와 루프 검사의 상대경로 스펙이 대조할 기준 브랜치. fetch 하지 않고 지금 있는 origin/<base> 를 본다.
//                기본은 --check-overlay 가 main, 루프 검사가 origin/HEAD 의 브랜치(없으면 main)다
//     --spec-ref 루프 검사가 상대경로 스펙을 읽을 git ref. 기본 origin/<base>. launch-worker 가 --resume-remote 면 origin/<지시서 브랜치> 를 준다
//     --spec-root 루프 검사가 상대경로 스펙을 이 폴더 아래 디스크에서 읽는다. --spec-ref 보다 앞선다. launch-worker 가 --worktree 면 그 워크트리를 준다
//
// 지시서에서 읽는 줄:
//     담당: `src/a/**`, `docs/a.md`     그 worker 가 고치는 경로. glob 을 쓴다. 여러 줄이어도 된다
//     예외: ...                          그 줄은 금지 문구와 존재 확인에서 뺀다
//     worker 선택: ...                   고른 에이전트, 모델, effort 와 비교한 후보, 고른 이유. 형식은 lib/spec.ts 의 selectionsOf 가 소유한다
//     ## 할 일 아래 첫 줄                 기능 루프를 쓰는지. 아래 「루프」 의 세 꼴 가운데 하나다
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
//     루프        `## 할 일` 제목(뒤에 띄어 쓴 설명은 받는다)이 없거나, 그 아래 첫 줄이 아래 셋 가운데 하나로 시작하지 않는다.
//                 빈 줄은 건너뛰고 목록 기호(`-`, `*`, `+`, `1.`, `1)`, 체크 상자)와 굵게는 벗긴다. 지시서와 스펙 모두 코드 블록 안의 줄은 보지 않는다.
//                   `루프를 쓴다(스펙: <경로>)`   경로의 스펙이 파일로 있고 그 제목과 첫 `## ` 절 사이에 `확인: YYYY-MM-DD` 줄이 있어야 한다.
//                                                  상대경로는 --repo 루트 기준이고 worker 가 시작할 곳(--spec-root, --spec-ref, 기본 origin/<base>)에서 읽는다.
//                                                  커밋하지 않은 스펙은 절대경로(`~/` 는 홈)로 적고 디스크에서 읽는다. 경로는 백틱으로 감싸도 된다.
//                                                  괄호 앞 띄어쓰기는 받는다
//                   `루프를 쓴다(스펙: 새로 쓴다)` 스펙 파일을 보지 않는다. 그 worker 는 spec 단계부터 하고 확인 전에는 plan 과 구현을 하지 않는다
//                   `루프 없이: <이유>`           이유가 비면 막는다. 이유가 타당한지는 보지 않는다(코디네이터가 feature-loop 기준표로 정한다)
//                 `리뷰 PR:` 줄(lib/review.ts 의 reviewPrOfSpec)이나 머리의 `중간 과정:` 줄(lib/spec.ts 의 interimOf)이 있는 지시서와
//                 --active 지시서는 보지 않는다. 기능 구현이 아니거나 이미 떠 있다.
//                 확인받은 스펙 없이 기능 구현 worker 를 띄우는 일을 막는다. 지침만으로는 바쁠 때 건너뛰었다
//     경로        백틱 안의 파일 경로(확장자가 있는 것)가 저장소에 없다. 파일 이름만 적었으면 어느 폴더에든 있으면 된다.
//                 새로 만들 파일일 수 있어 경고이고 종료 코드에 넣지 않는다
//     공통        지시서 폴더의 spec-common.md 에 틀(skills/orch/templates/spec-common.md)의 `<!-- orch-rule: <이름> -->` 표지가 빠졌거나,
//                 표지가 붙은 규칙의 본문이 틀과 다르다.
//                 표지는 빠지면 worker 가 옛 방식으로 움직이는 규칙(완료 보고 시점, 질문 경로, 개선 후보 보고 같은 것)을 가리킨다.
//                 공통 지시서가 틀보다 낡으면 worker 가 PR 을 열자마자 worker_done 을 보내거나 orca ask 를 직접 불러 status 답을 놓친다.
//                 표지가 있어도 본문이 옛것이면 같은 일이 난다(옛 종료 코드 설명, 틀이 금지한 명령).
//                 본문은 표지가 든 목록 항목이다. 항목 머리 줄(들여쓰지 않은 줄)부터 들여쓴 이어지는 줄과 빈 줄까지 보고,
//                 줄 끝 공백과 빈 줄은 빼고 비교한다. 틀 본문의 `{{...}}` 는 아무 글자에나 맞는다. 다른 표지는 한 줄에 하나씩 낸다.
//                 조건부 표지(CONDITIONAL_RULES)는 조건이 맞는 저장소에서만 빠진 것을 알린다. `migration` 은 orch 설정의
//                 migrations.dirs 나 migrations.watch 가 있는 저장소, `adr` 은 adr.dirs 가 있는 저장소다.
//                 조건이 맞지 않아도 표지가 있으면 본문은 비교한다.
//                 저장소가 그 규칙을 일부러 바꿨을 수 있어 경고이고 종료 코드에 넣지 않는다. 지시서 폴더에 spec-common.md 가 없으면 보지 않는다
//     임시        지시서가 임시 폴더 아래 경로(`/tmp/…`, `/private/tmp/…`, `/var/folders/…`, `$TMPDIR/…`, `…/scratchpad/…`)를 가리킨다.
//                 세션이 끝나거나 재부팅하면 그 파일이 사라져 다시 띄운 worker 가 막힌다. 내용을 지시서 본문에 옮기거나 저장소나
//                 orch 폴더에 둔다. `예외:` 줄은 보지 않는다. 경고이고 종료 코드에 넣지 않는다
//     제목        `# ` 제목 줄도 `보드 항목 id:` 줄도 없다. 보드 항목 제목이 업무 연결 줄, `## 목표` 첫 문장, 워크트리 이름으로 밀려나
//                 보드에 업무 목적이 보이지 않을 수 있다(lib/board.ts 의 specTitle). 경고이고 종료 코드에 넣지 않는다
//     보드        `보드 항목 id:` 줄에 id 뒤 설명이 붙었다. id 는 백틱 안의 글이나 공백 앞 첫 토큰으로만 읽는다(lib/spec.ts 의 boardIdOf).
//                 설명이 붙은 id 가 보드에 없으면 launch-worker 가 항목을 만들지 않는다. 설명은 다른 줄에 둔다. 경고이고 종료 코드에 넣지 않는다
//     완료        `## 완료 기준` 절(또는 `완료 기준:` 줄)에 PR 이 둘 이상 든다. `PR1`, `PR #12` 처럼 번호가 다른 PR 이 둘 이상이거나
//                 `PR1~PR3`, `PR 두 개` 꼴이다. 지시서 하나의 완료 기준은 PR 하나의 MERGED 다. 이 지시서는 PR1 만 맡고 뒤 PR 은
//                 코디네이터가 앞 PR 이 머지된 뒤 새 지시서로 띄운다(SKILL.md 원칙). 뒤 PR 목록은 완료 기준이 아닌 참고 절에 둔다.
//                 경고이고 종료 코드에 넣지 않는다
//     오버레이    (--check-overlay) 오버레이의 백틱 값과 config.json 의 문자열 값에서 읽은 상대 경로가 origin/<base> 에 없다.
//                 명령(`bash scripts/verify.sh --fast`)이면 낱말마다 본다. `/` 가 든 확장자 있는 낱말만 경로로 본다.
//                 파일 이름만 적은 것(스킬 스크립트일 수 있다), 절대경로, `~`, `$`, glob, `<...>` 가 든 값,
//                 git 이 무시하는 경로(`.orch/` 같은 로컬 폴더)는 보지 않는다.
//                 첫 마디가 origin/<base> 의 최상위 항목이 아닌 경로(다른 저장소, 스킬 문서, scratchpad, `origin/...`)도 보지 않는다.
//                 오버레이에서 `예외:` 로 시작하는 줄은 건너뛴다.
//                 로컬에만 있는 스크립트를 오버레이가 부르면 다른 워크트리와 worker 에서 그 단계가 「파일 없음」 으로 멈춘다
//
// 짧은 출력(진입점의 orch spec lint, lib/output.ts): 막을 발견은 `SPEC-ERROR <줄>`, 경고는 `SPEC-WARN <줄>` 이다. stderr 의 요약은 그대로다.
// 종료 코드:
//     0  막을 발견이 없다(경로, 공통, 임시, 제목, 보드, 완료 경고는 있을 수 있다)
//     1  겹침, 코디네이터, 소유, 없음, 금지, 선택, 루프, 오버레이 중 하나 이상
//     2  사용법 오류, 또는 저장소, 지시서, origin/<base>, config.json 을 읽지 못했다.
//        --overlay 없이 orch 작업 폴더를 옮기기 전에 돌려도 2 다(lib/paths.ts 머리 주석의 「옛 구조」)
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { taskFirstLine } from '../lib/spec.ts'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { ConfigError, loadConfig } from '../lib/config.ts'
import { isFile } from '../lib/fs.ts'
import { defaultBase, git } from '../lib/git.ts'
import { pathOf, requireMigrated } from '../lib/paths.ts'
import { reviewPrOfSpec } from '../lib/review.ts'
import { boardIdOfLine, interimOf, LINE_BREAK, SELECTION_FORMAT, selectionsOf } from '../lib/spec.ts'
import { short } from '../lib/output.ts'

const USAGE = [
  '사용법: spec-lint.ts --repo DIR [--overlay FILE] [--base BRANCH] [--spec-ref REF | --spec-root DIR] [--active FILE ...] SPEC [SPEC ...]',
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
const TEMPLATE = process.env.SPEC_TEMPLATE || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'spec-common.md')
const COMMON = 'spec-common.md'
const RULE_MARK = /<!--\s*orch-rule:\s*([A-Za-z0-9_-]+)\s*-->/g
// 임시 폴더 아래 경로. 폴더 이름만 말한 것(「scratchpad 에 쓴다」)은 빼고 그 아래 파일이나 폴더를 가리킨 것만 잡는다
const TEMP_PATH = /(?:^|[\s`'"(=])((?:\/private)?\/tmp\/[^\s`'"()]*|(?:\/private)?\/var\/folders\/[^\s`'"()]*|\$\{?TMPDIR\}?\/[^\s`'"()]*|[^\s`'"()]*\/scratchpad\/[^\s`'"()]*)/g
const TEMP_HINT = '임시 폴더라 세션이 끝나거나 재부팅하면 사라진다. 내용을 지시서 본문에 옮기거나 저장소나 orch 폴더에 둔다'

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

// 머리 주석의 「보드」. 고치는 방법을 함께 적는다
const BOARD_HINT = '`보드 항목 id:` 뒤에 설명이 붙었다. id 만 적고 설명은 다른 줄로 옮긴다(그대로면 id 는 첫 토큰으로 읽고, 보드에 없으면 항목을 만들지 않는다)'

// 머리 주석의 「완료」. 완료 기준 절에서 PR 이 둘 이상인 근거를 찾는다
const PR_NUMBER = /\bPR\s*#?(\d+)/gi
const PR_RANGE = /\bPR\s*#?\d+\s*[~\-–]\s*(?:PR\s*)?#?\d+/i
const PR_COUNT = /\bPR\s*(?:[2-9]|\d{2,}|두|세|네|여러)\s*(?:개|건)/i
const DONE_HINT =
  '완료 기준에 PR 이 둘 이상 보인다. 지시서 하나의 완료 기준은 PR 하나의 MERGED 다. ' +
  '이 지시서는 PR1 만 맡는다고 적고, 뒤 PR 은 코디네이터가 앞 PR 이 머지된 뒤 새 지시서로 띄운다. 뒤 PR 목록은 참고 절에만 둔다'

function doneProblem(lines: string[]): { no: number; found: string } | null {
  let inSection = false
  const numbers = new Map<string, number>()
  let first = 0
  let loose: string | null = null
  const scan = (text: string, no: number) => {
    for (const m of text.matchAll(PR_NUMBER)) {
      if (!numbers.has(m[1])) numbers.set(m[1], no)
      first ||= no
    }
    const hit = PR_RANGE.exec(text) ?? PR_COUNT.exec(text)
    if (hit && loose === null) {
      loose = hit[0]
      first ||= no
    }
  }
  lines.forEach((line, index) => {
    const no = index + 1
    if (/^#{1,6}\s/.test(line)) inSection = /^#{1,6}\s*완료 기준/.test(line)
    else if (inSection) scan(line, no)
    const rest = field(line, '완료 기준')
    if (rest !== null) scan(rest, no)
  })
  if (numbers.size < 2 && loose === null) return null
  const found = loose ?? [...numbers.keys()].map((n) => `PR${n}`).join(', ')
  return { no: first, found }
}

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

// 머리 주석의 「공통」 의 조건부 표지. 조건이 거짓인 저장소에서는 그 표지가 빠져도 알리지 않는다
const CONDITIONAL_RULES: Record<string, (repoRoot: string) => boolean> = {
  migration: (repoRoot) => configured(repoRoot, 'migrations', ['dirs', 'watch']),
  adr: (repoRoot) => configured(repoRoot, 'adr', ['dirs']),
}

// 설정 절의 keys 가운데 하나라도 비지 않은 객체인지. 설정을 읽지 못하면 거짓이다
function configured(repoRoot: string, name: 'migrations' | 'adr', keys: string[]): boolean {
  let body: unknown
  try {
    body = loadConfig(repoRoot)[name]
  } catch (e) {
    if (e instanceof ConfigError) return false
    throw e
  }
  if (typeof body !== 'object' || body === null) return false
  const filled = (value: unknown) => typeof value === 'object' && value !== null && Object.keys(value).length > 0
  return keys.some((key) => filled((body as Record<string, unknown>)[key]))
}

// 표지마다 그 표지가 든 목록 항목의 본문과 머리 줄 번호. 머리 주석의 「공통」 이 범위를 정한다
function ruleBodies(text: string): Map<string, { no: number; body: string }> {
  const lines = splitLines(text)
  const indented = (line: string) => /^\s/.test(line)
  const found = new Map<string, { no: number; body: string }>()
  lines.forEach((line, index) => {
    for (const m of line.matchAll(RULE_MARK)) {
      let head = index
      while (head > 0 && indented(lines[head])) head -= 1
      let end = index + 1
      while (end < lines.length && (lines[end].trim() === '' || indented(lines[end]))) end += 1
      const body = lines
        .slice(head, end)
        .map((l, i) => (i === 0 ? l.replace(/^(?:[-*]|\d+\.)\s+/, '') : l).trimEnd())
        .filter((l) => l !== '')
        .join('\n')
      found.set(m[1], { no: head + 1, body })
    }
  })
  return found
}

// 틀 본문의 {{...}} 는 저장소가 채운 값이라 아무 글자에나 맞춘다
function sameBody(template: string, copy: string): boolean {
  const parts = template.split(/\{\{[^}]*\}\}/)
  if (parts.length === 1) return template === copy
  const pattern = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?')
  return new RegExp(`^${pattern}$`).test(copy)
}

// 머리 주석의 「공통」. 지시서 폴더마다 한 번 본다
function staleCommon(specs: string[], repoRoot: string): string[] {
  let template: Map<string, { no: number; body: string }>
  try {
    template = ruleBodies(readFileSync(TEMPLATE, 'utf8'))
  } catch {
    return []
  }
  const required = [...template.keys()].filter((name) => !Object.hasOwn(CONDITIONAL_RULES, name) || CONDITIONAL_RULES[name](repoRoot))
  const found: string[] = []
  for (const dir of new Set(specs.map((s) => dirname(normalize(s))))) {
    const common = join(dir, COMMON)
    if (!isFile(common)) continue
    const has = ruleBodies(readFileSync(common, 'utf8'))
    const missing = required.filter((name) => !has.has(name))
    if (missing.length > 0) {
      found.push(
        `${common}:1: 공통: 틀의 규칙 표지 ${missing.map((m) => `\`${m}\``).join(', ')} 가 없다. ` +
          `공통 지시서가 틀(${TEMPLATE})보다 낡았을 수 있다. 틀에서 그 표지가 붙은 줄을 옮긴다`,
      )
    }
    for (const [name, mine] of has) {
      const want = template.get(name)
      if (want && !sameBody(want.body, mine.body)) {
        found.push(
          `${common}:${mine.no}: 공통: 표지 \`${name}\` 가 붙은 규칙이 틀과 다르다. ` +
            `저장소가 일부러 바꾼 것이 아니면 틀(${TEMPLATE}:${want.no})의 그 항목으로 바꾼다`,
        )
      }
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

// 머리 주석의 「루프」. 첫 줄 꼴과 스펙 확인 줄 규칙은 기능 루프(references/feature-loop.md)와 plan 의 check_feature.py 를 따른다
const LOOP_FORMAT = '`루프를 쓴다(스펙: <경로>)`, `루프를 쓴다(스펙: 새로 쓴다)`, `루프 없이: <이유>`'
const LOOP_SPEC = /^루프를 쓴다\s*\(스펙\s*:\s*(.*?)\s*\)/
const LOOP_NONE = /^루프 없이\s*:(.*)$/
const LOOP_NEW = '새로 쓴다'
const FENCE = /^\s*(```|~~~)/
const CONFIRMED = /^확인:\s*(\d{4}-\d{2}-\d{2})\s*$/

// 상대경로 스펙을 읽을 곳. 기본은 origin/<base> 이고, launch-worker 가 worker 가 실제로 일할 곳을 준다
type LoopSource = { ref: string } | { root: string }

function validDate(text: string): boolean {
  const [y, m, d] = text.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

// 코드 블록(``` 나 ~~~) 안의 줄을 빈 줄로 바꾼다. 줄 번호는 그대로다. 예시로 인용한 제목과 줄을 판정에 쓰지 않으려는 것이다
function outsideFences(lines: string[]): string[] {
  let fence: string | null = null
  return lines.map((line) => {
    const m = FENCE.exec(line)
    if (m) {
      if (fence === null) fence = m[1]
      else if (fence === m[1]) fence = null
      return ''
    }
    return fence === null ? line : ''
  })
}

// 스펙 본문에서 확인 줄 문제. 없으면 null. 제목과 첫 `## ` 절 사이만 본다(check_feature.py 의 check_confirmed)
function confirmProblem(text: string): string | null {
  for (const line of outsideFences(splitLines(text))) {
    if (/^##\s/.test(line)) break
    const m = CONFIRMED.exec(line.trim())
    if (m) return validDate(m[1]) ? null : `확인 줄의 날짜가 올바르지 않다: ${m[1]}`
  }
  return '제목 아래에 `확인: YYYY-MM-DD` 줄이 없다. 사용자가 확인한 스펙만 넘긴다. 확인 전이면 `루프를 쓴다(스펙: 새로 쓴다)` 로 spec 단계부터 맡긴다'
}

// 스펙 경로를 읽는다. 절대경로(`~/` 는 홈)는 디스크에서, 상대경로는 source 에서 읽는다. 못 읽으면 이유
function readLoopSpec(repoRoot: string, source: LoopSource, target: string): { text: string } | { why: string } {
  const abs = target.startsWith('~/') ? join(homedir(), target.slice(2)) : target
  const disk = (file: string, shown: string) => (isFile(file) ? { text: readFileSync(file, 'utf8') } : { why: `스펙 \`${shown}\` 을 파일로 읽지 못했다` })
  if (isAbsolute(abs)) return disk(abs, target)
  const rel = removePrefix(target, './')
  if ('root' in source) return disk(join(source.root, rel), target)
  const { ref } = source
  if (git(repoRoot, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).code !== 0) {
    return { why: `${ref} 가 없어 상대경로 스펙 \`${target}\` 을 읽지 못했다. 기준 브랜치를 --base 로 주거나 스펙을 절대경로로 적는다` }
  }
  const kind = git(repoRoot, ['cat-file', '-t', `${ref}:${rel}`])
  if (kind.code !== 0) return { why: `스펙 \`${target}\` 이 ${ref} 에 없다. 상대경로는 기준 브랜치에 커밋된 스펙만 받는다. 커밋하지 않은 스펙은 절대경로로 적는다` }
  if (kind.stdout.trim() !== 'blob') return { why: `스펙 \`${target}\` 이 ${ref} 에서 파일이 아니다` }
  return { text: git(repoRoot, ['show', `${ref}:${rel}`]).stdout }
}

function loopErrors(spec: Spec, repoRoot: string, source: LoopSource): string[] {
  const text = spec.lines.join('\n')
  if (reviewPrOfSpec(text) !== null || interimOf(text) !== null) return []
  const task = taskFirstLine(text)
  if (!task) return [`${spec.name}:1: 루프: \`## 할 일\` 제목이 없다. 제목 아래 첫 줄에 ${LOOP_FORMAT} 가운데 하나를 적는다`]
  const first = task.text
  const no = task.line
  const where = `${spec.name}:${no}: 루프: `
  const none = LOOP_NONE.exec(first)
  if (none) return none[1].trim() ? [] : [`${where}\`루프 없이:\` 뒤에 이유가 없다. 루프 없이 가는 이유를 한 줄로 적는다`]
  const loop = LOOP_SPEC.exec(first)
  if (!loop) return [`${where}\`## 할 일\` 아래 첫 줄이 ${LOOP_FORMAT} 가운데 하나가 아니다${first ? `: ${first.slice(0, 60)}` : '(첫 줄이 없다)'}`]
  const target = stripChars(loop[1], '`').trim()
  if (target === LOOP_NEW) return []
  if (!target) return [`${where}\`스펙:\` 뒤에 경로가 없다. 스펙이 아직 없으면 \`루프를 쓴다(스펙: 새로 쓴다)\` 를 쓴다`]
  const got = readLoopSpec(repoRoot, source, target)
  if ('why' in got) return [`${where}${got.why}`]
  const problem = confirmProblem(got.text)
  return problem ? [`${where}스펙 \`${target}\`: ${problem}`] : []
}

function lint(repo: Repo, specs: string[], overlay: string | null, active: string[], source: LoopSource): { errors: string[]; warnings: string[] } {
  const { coordinator, owners, forbidden } = readOverlay(overlay)
  const errors: string[] = []
  const warnings: string[] = []
  // 같은 지시서를 두 번 넘기면 한 번만 본다. 자기 자신과 겹친다고 하지 않게 한다
  const launched = new Set(active.map((s) => normalize(s)))
  const targets = new Set(specs.map((s) => normalize(s)))
  const parsed = [...new Map([...specs, ...active].map((s) => [normalize(s), s])).values()].map(readSpec)

  for (let i = 0; i < parsed.length; i += 1) {
    for (const b of parsed.slice(i + 1)) {
      const a = parsed[i]
      for (const [ga, na] of a.owned) {
        for (const [gb] of b.owned) {
          if (overlap(repo, ga, gb)) {
            const blocking = targets.has(a.path) || targets.has(b.path)
            const kind = blocking ? '겹침' : '겹침 경고'
            const findings = blocking ? errors : warnings
            findings.push(`${a.name}:${na}: ${kind}: \`${ga}\` 와 ${b.name} 의 \`${gb}\``)
          }
        }
      }
    }
  }

  for (const spec of parsed) {
    if (!launched.has(spec.path)) errors.push(...selectionErrors(spec), ...loopErrors(spec, repo.root, source))
    if (!spec.lines.some((line) => /^#\s+\S/.test(line) || field(line, '보드 항목 id') !== null)) {
      warnings.push(`${spec.name}:1: 제목: ${TITLE_HINT}`)
    }
    spec.lines.forEach((line, index) => {
      const given = boardIdOfLine(line)
      if (given?.note) warnings.push(`${spec.name}:${index + 1}: 보드: ${BOARD_HINT}(${given.id})`)
    })
    const done = doneProblem(spec.lines)
    if (done) warnings.push(`${spec.name}:${done.no}: 완료: ${DONE_HINT}(${done.found})`)
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
      for (const m of line.matchAll(TEMP_PATH)) {
        const path = m[1].replace(/[.,;:]+$/, '')
        warnings.push(`${spec.name}:${no}: 임시: \`${path}\` 는 ${TEMP_HINT}`)
      }
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
  warnings.push(...staleCommon(specs, repo.root))
  return { errors, warnings }
}

function main(argv: string[]): number {
  let parsed
  try {
    const options = {
      repo: { type: 'string' },
      overlay: { type: 'string' },
      'check-overlay': { type: 'boolean' },
      base: { type: 'string' },
      'spec-root': { type: 'string' },
      'spec-ref': { type: 'string' },
      active: { type: 'string', multiple: true },
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
  const active = values.active ?? []
  const missing = [...specs, ...active].filter((s) => !isFile(s))
  if (missing.length > 0) {
    process.stderr.write(`spec-lint: 지시서를 읽지 못했다: ${missing.join(', ')}\n`)
    return 2
  }
  try {
    const repo = new Repo(values.repo)
    if (!values.overlay && !requireMigrated(values.repo, 'spec-lint', '오버레이를 --overlay 로 직접 준다')) return 2
    const overlay = values.overlay ?? pathOf('overlay', values.repo)
    // 루프 검사의 기준 브랜치는 --base, 없으면 origin/HEAD 의 브랜치, 그것도 없으면 main 이다. --check-overlay 의 기본은 지금처럼 main 이다
    const loopBase = (values.base ?? defaultBase(values.repo) ?? 'main').replace(/^origin\//, '')
    const specRoot = values['spec-root']
    const source: LoopSource = specRoot ? { root: specRoot } : { ref: values['spec-ref'] ?? `origin/${loopBase}` }
    const { errors, warnings } = specs.length > 0 ? lint(repo, specs, overlay, active, source) : { errors: [], warnings: [] }
    if (values['check-overlay']) errors.push(...checkOverlay(values.repo, overlay, values.base ?? 'main'))
    // 짧은 출력(진입점의 orch spec lint)은 발견마다 판정 낱말을 붙인다
    const brief = short()
    for (const line of errors) process.stdout.write(`${brief ? 'SPEC-ERROR ' : ''}${line}\n`)
    for (const line of warnings) process.stdout.write(`${brief ? 'SPEC-WARN ' : ''}${line}\n`)
    const overlaps = warnings.filter((line) => line.includes(': 겹침 경고: ')).length
    const titles = warnings.filter((line) => line.includes(': 제목: ')).length
    const commons = warnings.filter((line) => line.includes(': 공통: ')).length
    const boards = warnings.filter((line) => line.includes(': 보드: ')).length
    const dones = warnings.filter((line) => line.includes(': 완료: ')).length
    const temps = warnings.filter((line) => line.includes(': 임시: ')).length
    const tail =
      (overlaps > 0 ? `, 겹침 경고 ${overlaps}건` : '') +
      (titles > 0 ? `, 제목 경고 ${titles}건` : '') +
      (commons > 0 ? `, 공통 경고 ${commons}건` : '') +
      (boards > 0 ? `, 보드 경고 ${boards}건` : '') +
      (dones > 0 ? `, 완료 경고 ${dones}건` : '') +
      (temps > 0 ? `, 임시 경고 ${temps}건` : '')
    const paths = warnings.length - titles - commons - boards - dones - overlaps - temps
    process.stderr.write(`spec-lint: 막을 발견 ${errors.length}건, 경로 경고 ${paths}건${tail}\n`)
    return errors.length > 0 ? 1 : 0
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    process.stderr.write(`spec-lint: ${e.message}\n`)
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))
