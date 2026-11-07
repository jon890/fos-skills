#!/usr/bin/env node
// 하네스 지침 파일이 가리키는 대상이 실재하는지 확인한다.
//
// 검사 항목
//   1. 마크다운 링크 `[텍스트](경로.md)`
//   2. 백틱으로 감싼 repo 상대 경로. 링크 문구 안의 백틱 경로는 링크 대상이 실재하면 보지 않는다.
//      대상은 링크가 이미 말한다. 대상이 없으면 1번이 깨진 링크로 내고, 문구의 경로도 함께 본다.
//   3. 다른 문서의 섹션 참조 — `"섹션명" 섹션` / `"섹션명" 표`
//   4. 스킬 참조 — `` `이름` skill ``
//   5. 절 이름 참조 — 파일 표기 바로 뒤의 「제목」. 「A」 의 「B」 와 「A」 「B」 는 제목마다 본다.
//      파일 표기는 백틱 경로, Markdown 링크, `{@code 경로}`, 맨 경로(`backend/AGENTS.md`)다.
//      제목은 그 파일의 `#` 부터 `######` 제목과 앞뒤 공백만 무시하고 글자 그대로 비교한다.
//      「A」 의 「B」 처럼 두 번째 이후 항목은 줄 머리(목록 표기 뒤)의 굵은 라벨 `**B.**` 도 인정한다.
//      끝의 마침표와 콜론은 무시한다. check_rename_drift 도 제목과 굵은 라벨을 같은 라벨로 본다.
//      첫 항목은 Markdown 제목만 인정한다. 점만 있는 「...」 는 서식 자리표시자라 건너뛴다.
//      대상 파일은 참조하는 파일 기준, 그다음 저장소 루트 기준으로 찾고, 못 찾으면 건너뛴다.
//      파일 표기가 바로 앞에 없는 「」 는 화면 문구로 보고 검사하지 않는다.
//
// 펜스 코드 블록(``` 와 ~~~) 안은 모든 검사에서 건너뛴다. 예시 출력과 서식 견본이 들어 있는 자리라서다.
// 브랜치 이름처럼 경로가 아닌 백틱 표기는 2번에서 건너뛴다. 확장자도 끝 슬래시도 없는 표기가
// 브랜치를 말하는 줄(「브랜치」, `branch`, `checkout`, `switch`, `worktree`)에 있을 때다.
//
//   6. 홈 경로 — 백틱으로 감싼 `~/…` 경로가 이 머신의 홈 아래에 있는지. 없으면 실패가 아니라 경고로 낸다.
//      경로 뒤에 공백과 `-` 옵션 낱말(`--apply`, `-n`)이 오면 거기서 잘라 경로만 본다.
//      다른 사람의 머신 경로이거나 지침 작성자만 가진 파일일 수 있어 깨진 참조로 단정하지 못한다.
//      경고는 종료 코드를 바꾸지 않고 깨진 참조 결과 뒤에 낸다.
//
// 5번은 두 범위를 본다. 감사 대상 지침 전부와, git 이 추적하는 텍스트 파일 가운데
// 가리키는 파일이 감사 대상 지침인 참조다. 지침의 절 이름을 바꾸면 코드 주석과 프롬프트의
// 참조가 깨지기 때문이다. 바이너리와 디코딩이 안 되는 파일은 건너뛴다.
// 추적 파일 범위에서 CHANGELOG*.md 는 뺀다. 변경 이력은 과거의 절 이름을 적는 글이라
// 이름이 바뀐 지금 보면 늘 깨진 참조로 읽힌다.
// `--scope` 는 읽는 파일을 그 아래로 제한한다. 두 범위 모두 같다.
//
// 사용법: node check_references.ts [repo-root] [--scope <저장소 안 경로>]
// 종료 코드: 0 깨진 참조 없음, 1 깨진 참조 있음, 2 `--scope` 인자 오류. 경고만 있으면 0 이다.

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isMain, readTextReplace, write } from './io.ts'
import { PY_SPACE, pySplitLines, pyStrip } from './kit/py.ts'
import { exists, isDir, isFile, isRelativeTo, isSymlink, pathName, pathParent, pathParents, pjoin, pyPath, pyResolve, pyre, relativeTo, walk, WORD } from './pylike.ts'
import { iterTargets, resolveScope, takeScope, ValueError } from './target_files.ts'

// 경로처럼 보이는 백틱 조각. 디렉터리 구분자를 포함해야 경로로 본다.
const PATH_IN_BACKTICK = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?)`/gu
// 홈 경로. 백틱 안이 `~/` 로 시작하는 표기다. 한글과 공백이 든 경로도 본다.
// 자리표시자(`<>{}*$`)가 든 표기는 잡지 않는다.
const HOME_PATH = /`(~\/[^`<>{}*$\n]+)`/gu
// 경로 뒤에 옵션이 붙은 명령 줄(`~/x/run.py --apply`)은 공백과 `-옵션` 낱말 앞에서 자른다.
// 영문자로 시작하는 옵션만 자른다. `내 지침 -초안.md` 같은 한글 파일 이름은 경로로 남는다.
const HOME_PATH_OPTION = pyre(/\s+--?[A-Za-z].*$/u)
const MD_LINK = /\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/gu
// 확장자와 무관한 링크 한 개. 링크 문구의 백틱 경로를 2번 검사에서 가릴 때 쓴다.
const LINK_SPAN = pyre(/\[([^\]]*)\]\(([^)\s]+)\)/gu)
const SECTION_REF = pyre(/`([A-Za-z0-9_./-]+\.md)`\s*(?:의|에)?\s*["“]([^"”]{2,60})["”]\s*(섹션|표|절)/gu)
// 파일 표기 + (의|에) + 「제목」 이 하나 이상. 파일 표기가 바로 앞에 없는 「」 는 잡지 않는다.
const SECTION_TITLES = '(?<titles>「[^」\\n]+」(?:\\s*(?:의\\s*)?「[^」\\n]+」)*)'
const GUIDE_REF = pyre(
  new RegExp(
    '(?:`(?<tick>[^`\\s]+\\.md)`' +
      '|\\[[^\\]]*\\]\\((?<link>[^)\\s#]+\\.md)(?:#[^)]*)?\\)' +
      '|\\{@code\\s+(?<code>[^}\\s]+\\.md)\\s*\\}' +
      `|(?<![\\p{L}\\p{N}_./\`(\\-])(?<bare>(?:\\.{1,2}/)*[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.md))` +
      `\\s*(?:의|에)?\\s*${SECTION_TITLES}`,
    'gu',
  ),
)
const TITLE = /「([^」\n]+)」/gu
const PLACEHOLDER_TITLE = pyre(/^[.…\s]+$/u)
const BOLD_LABEL = pyre(/^\s*(?:(?:[-*+]|\p{Nd}+\.)\s+)?\*\*([^*]+)\*\*/u)
const MAX_EXTRA_BYTES = 2_000_000
const SKILL_REF = pyre(/`([a-z][a-z0-9-]+)`\s*(?:skill|스킬)/gu)
// 같은 줄이 형제 스킬을 말하는 표기 — `플러그인:스킬` 이나 `스킬` 스킬
const QUALIFIED_SKILL = new RegExp(`(?<!${WORD})([a-z][a-z0-9-]*):([a-z][a-z0-9-]+)`, 'gu')
const BUNDLE_DIRS = ['assets/', 'references/', 'scripts/']

// 검사에서 제외 — 플레이스홀더, 홈 경로, 와일드카드, URL
//   `../..` 로 시작하는 깊은 상대 경로를 여기서 빼면 안 된다.
//   이 스킬은 조건부 절을 `references/` 로 내리라고 처방하고, 그렇게 옮기면 링크가
//   한 단 깊어져 정확히 그 형태가 된다. 스킬이 시킨 작업이 만드는 링크를
//   스킬의 검사기가 안 보게 된다. 저장소 밖으로 나가는지는 해석 결과로 판정한다.
const SKIP = /[<>{}*]|^~|^\$|^https?:/u
const FENCE = pyre(/^\s*(```|~~~)/u)
// 브랜치 이름은 `docs/branch-naming` 처럼 경로와 같은 모양이다. 줄이 브랜치를 말하면 확장자 없는 표기는 경로로 보지 않는다.
const BRANCH_CONTEXT = new RegExp(`브랜치|(?<!${WORD})branch|checkout|switch|worktree`, 'iu')
const HEADER = pyre(/^#{1,6}\s+(.*)$/u)
const TRAILING_SPACE = new RegExp(`${PY_SPACE}+$`)

const findall = (re: RegExp, text: string): RegExpMatchArray[] => [...text.matchAll(re)]
const rstripPy = (text: string) => text.replace(TRAILING_SPACE, '')

// 펜스 코드 블록 밖의 (줄 번호, 줄). 여는 펜스와 같은 문자로 닫히기 전까지는 블록 안이다
function outsideFences(lines: string[]): [number, string][] {
  const out: [number, string][] = []
  let fence: string | null = null
  lines.forEach((line, i) => {
    const m = FENCE.exec(line)
    if (m && fence === null) fence = m[1]
    else if (m && m[1] === fence) fence = null
    else if (fence === null) out.push([i + 1, line])
  })
  return out
}

function isBranchName(cand: string, line: string): boolean {
  const trimmed = cand.replace(/\/+$/, '')
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return !cand.endsWith('/') && !last.includes('.') && BRANCH_CONTEXT.test(line.replaceAll(cand, ''))
}

function home(): string {
  return process.env.HOME ?? homedir()
}

function run(argv: string[]): number {
  let rest: string[]
  let scopeArg: string | null
  let root: string
  let scope: string | null
  try {
    ;[rest, scopeArg] = takeScope(argv)
    root = pyResolve(pyPath(rest.length ? rest[0] : '.'))
    scope = resolveScope(root, scopeArg)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }

  const targets = () => iterTargets(root, false, scope).filter((path) => isRelativeTo(pyResolve(path), root))

  // 설치된 스킬 이름 — 홈과 repo 양쪽
  function installedSkills(): Set<string> {
    const names = new Set<string>()
    const h = home()
    for (const base of [pjoin(h, '.claude/skills'), pjoin(h, '.codex/skills'), pjoin(root, '.claude/skills'), pjoin(root, '.agents/skills'), pjoin(root, 'skills')]) {
      if (isDir(base)) for (const name of readdirSync(base)) names.add(name)
    }
    for (const skillFile of iterTargets(root)) {
      if (pathName(skillFile) === 'SKILL.md' && isRelativeTo(pyResolve(skillFile), root)) names.add(pathName(pathParent(skillFile)))
    }
    // 플러그인 스킬. 스킬을 skills/ 아래에 두지 않는 플러그인도 있어 SKILL.md 로 찾는다.
    const plug = pjoin(h, '.claude/plugins')
    if (isDir(plug)) {
      for (const step of walk(plug)) {
        if (exists(pjoin(step.current, 'SKILL.md'))) names.add(pathName(step.current))
      }
    }
    return names
  }

  // 저장소가 가진 플러그인 이름 — `plugins/<이름>/` 과 plugin.json 의 name
  function pluginNames(): Set<string> {
    const names = new Set<string>()
    const pluginsDir = pjoin(root, 'plugins')
    const dirs = isDir(pluginsDir) ? readdirSync(pluginsDir).filter((d) => isDir(pjoin(pluginsDir, d))) : []
    for (const d of dirs) names.add(d)
    const manifests = [pjoin(root, '.claude-plugin/plugin.json'), ...dirs.map((d) => pjoin(pluginsDir, d, '.claude-plugin/plugin.json')).filter((p) => exists(p))]
    for (const manifest of manifests) {
      try {
        const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(manifest)))
        if (typeof data === 'object' && data !== null && !Array.isArray(data) && typeof (data as Record<string, unknown>).name === 'string') names.add((data as Record<string, string>).name)
      } catch {
        continue
      }
    }
    return names
  }

  // 저장소 안 스킬 이름 → SKILL.md 를 가진 디렉터리들
  function skillDirs(): Map<string, string[]> {
    const dirs = new Map<string, string[]>()
    for (const skillFile of iterTargets(root)) {
      if (pathName(skillFile) === 'SKILL.md' && isRelativeTo(pyResolve(skillFile), root)) {
        const name = pathName(pathParent(skillFile))
        dirs.set(name, [...(dirs.get(name) ?? []), pathParent(skillFile)])
      }
    }
    return dirs
  }

  // 스킬 번들 안의 파일이면 SKILL.md 를 가진 디렉터리를 돌려준다
  function bundleRoot(path: string): string | null {
    for (const parent of pathParents(path)) {
      if (exists(pjoin(parent, 'SKILL.md'))) return parent
      if (parent === root) break
    }
    return null
  }

  const labelCache = new Map<string, Set<string>>()
  // 파일의 줄 머리 굵은 라벨 집합. 끝의 마침표와 콜론은 뗀다
  function labels(path: string): Set<string> {
    let out = labelCache.get(path)
    if (!out) {
      out = new Set()
      if (isFile(path)) {
        for (const line of pySplitLines(readTextReplace(path))) {
          const m = BOLD_LABEL.exec(line)
          if (m) out.add(pyStrip(rstripChars(pyStrip(m[1]), '.:')))
        }
      }
      labelCache.set(path, out)
    }
    return out
  }

  const headerCache = new Map<string, Set<string>>()
  // 파일의 헤더 텍스트 집합
  function headers(path: string): Set<string> {
    let out = headerCache.get(path)
    if (!out) {
      out = new Set()
      if (isFile(path)) {
        for (const line of pySplitLines(readTextReplace(path))) {
          const m = HEADER.exec(line)
          if (m) out.add(pyStrip(m[1]))
        }
      }
      headerCache.set(path, out)
    }
    return out
  }

  // git 이 추적하는 텍스트 파일. git 저장소가 아니면 비어 있다. 바이너리와 디코딩 실패는 건너뛴다
  function trackedTextFiles(): [string, string][] {
    const done = spawnSync('git', ['ls-files', '-z'], { cwd: root })
    if (done.error) throw done.error
    if (done.status !== 0) return []
    const out: [string, string][] = []
    for (const name of new TextDecoder('utf-8', { ignoreBOM: true }).decode(done.stdout).split('\0')) {
      const path = pjoin(root, name)
      if (!name || !isFile(path) || isSymlink(path) || pathName(path).startsWith('CHANGELOG')) continue
      if (scope !== null && path !== scope && !isRelativeTo(path, scope)) continue
      try {
        const raw = readFileSync(path)
        if (raw.length > MAX_EXTRA_BYTES || raw.includes(0)) continue
        out.push([path, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)])
      } catch {
        continue
      }
    }
    return out
  }

  // 절 참조의 대상 파일. 참조하는 파일 기준, 그다음 저장소 루트 기준이다
  function guideTarget(source: string, name: string): string | null {
    for (const base of [pathParent(source), root]) {
      const candidate = pyResolve(pjoin(base, name))
      if (isFile(candidate) && isRelativeTo(candidate, root)) return candidate
    }
    return null
  }

  // 한 줄의 「제목」 참조 가운데 대상 파일에 없는 제목. instructions 가 있으면 그 파일만 가리키는 참조를 본다
  function brokenGuideRefs(source: string, line: string, instructions: Set<string> | null): [string, string][] {
    const found: [string, string][] = []
    for (const match of findall(GUIDE_REF, line)) {
      const g = match.groups!
      const name = g.tick || g.link || g.code || g.bare
      if (SKIP.test(name)) continue
      const target = guideTarget(source, name)
      if (target === null || (instructions !== null && !instructions.has(target))) continue
      const known = headers(target)
      findall(TITLE, g.titles).forEach((t, index) => {
        const title = t[1]
        const text = pyStrip(title)
        if (known.has(text) || PLACEHOLDER_TITLE.test(text) || SKIP.test(text)) return
        if (index > 0 && labels(target).has(pyStrip(rstripChars(text, '.:')))) return
        found.push([name, title])
      })
    }
    return found
  }

  // 링크 대상이 실재하면 그 링크 문구를 지운다.
  // `[plan 의 `references/x.md`](../plan/references/x.md)` 처럼 문구가 대상을 다시 적거나
  // `[`scripts/` 절](./step.md)` 처럼 대상 안의 것을 가리키는 경우,
  // 문구의 경로를 따로 해석하면 엉뚱한 기준으로 찾아 깨진 참조로 낸다. 대상은 링크가 이미 말한다.
  // 대상이 없으면 그대로 두어 문구의 경로도 2번 검사가 잡게 한다
  function maskResolvedLinkText(source: string, line: string): string {
    return line.replace(LINK_SPAN, (all: string, _text: string, target: string) => {
      const hash = target.indexOf('#')
      const dest = hash >= 0 ? target.slice(0, hash) : target
      if (!dest || SKIP.test(dest)) return all
      return exists(pyResolve(pjoin(pathParent(source), dest))) ? `[](${target})` : all
    })
  }

  // 같은 줄이 이름으로 부른 형제 스킬 폴더에 그 경로가 있는지.
  // `plugin:skill` 꼴은 앞쪽이 알려진 플러그인 이름일 때만 스킬 지명으로 받는다
  function inSiblingSkill(line: string, bare: string, siblings: Map<string, string[]>, plugins: Set<string>): boolean {
    const named = new Set<string>()
    for (const m of findall(QUALIFIED_SKILL, line)) if (plugins.has(m[1])) named.add(m[2])
    for (const m of findall(SKILL_REF, line)) named.add(m[1])
    return [...named].some((name) => (siblings.get(name) ?? []).some((d) => exists(pjoin(d, bare))))
  }

  const skills = installedSkills()
  const plugins = pluginNames()
  const siblings = skillDirs()
  const broken: [string, number, string, string][] = []
  const warnings: [string, number, string][] = []
  const h = home()
  const instructions = new Set(iterTargets(root).map((path) => pyResolve(path)))
  const scanned = new Set<string>()

  for (const f of targets()) {
    scanned.add(pyResolve(f))
    const rel = relativeTo(f, root)
    const text = readTextReplace(f)

    for (const [i, line] of outsideFences(pySplitLines(text))) {
      // 1) 마크다운 링크
      for (const m of findall(MD_LINK, line)) {
        const link = m[1]
        if (SKIP.test(link)) continue
        const hash = link.indexOf('#')
        const target = pyResolve(pjoin(pathParent(f), hash >= 0 ? link.slice(0, hash) : link))
        // 저장소 밖을 가리키는 경로는 판정 대상이 아니다.
        //   상대 경로가 몇 단을 올라가든 해석한 뒤에 경계를 따진다.
        if (!isRelativeTo(target, root)) continue
        if (!isFile(target)) broken.push([rel, i, '링크', link])
      }

      // 2) 백틱 경로 — repo 상대 경로로 해석
      for (const m of findall(PATH_IN_BACKTICK, maskResolvedLinkText(f, line))) {
        const cand = m[1]
        if (SKIP.test(cand) || isBranchName(cand, line)) continue
        const bare = cand.replace(/\/+$/, '')
        const normalized = bare.startsWith('./') ? bare.slice(2) : bare
        const bases = [root, ...pathParents(f).filter((parent) => isRelativeTo(parent, root))]
        if (bases.some((base) => exists(pjoin(base, bare)))) continue
        // 다른 스킬의 이름과 함께 적은 번들 경로는 그 형제 스킬 폴더에서 찾는다
        if (BUNDLE_DIRS.some((d) => normalized.startsWith(d)) && inSiblingSkill(line, bare, siblings, plugins)) continue
        // 스킬 번들 안의 문서는 번들 root 기준 상대 경로를 쓴다 (예: scripts 아래 파일)
        const bundle = bundleRoot(f)
        if (bundle && exists(pjoin(bundle, bare))) continue
        // 저장소 루트의 배포용 스킬은 대상 프로젝트에 생성할 경로를 계약으로 적는다.
        // 이 경로를 스킬 원본 저장소 안에서 찾으면 정상 지침을 깨진 참조로 오인한다.
        if (bundle && pathParent(bundle) === root && !['assets/', 'references/', 'scripts/'].some((d) => normalized.startsWith(d))) continue
        // repo 밖 경로(홈 설정 등)는 판정 대상이 아니다
        if ([ '.claude/', '.github/', 'assets/', 'docs/', 'references/', 'scripts/', 'skills/', 'src/', 'tasks/' ].some((d) => normalized.startsWith(d))) broken.push([rel, i, '경로', cand])
      }

      // 6) 홈 경로 — 이 머신에 없으면 경고
      for (const m of findall(HOME_PATH, line)) {
        const cand = rstripPy(m[1].replace(HOME_PATH_OPTION, ''))
        if (!exists(pjoin(h, cand.slice(2)))) warnings.push([rel, i, cand])
      }

      // 3) 섹션 참조
      for (const m of findall(SECTION_REF, line)) {
        const [, doc, section, kind] = m
        if (SKIP.test(doc)) continue
        const target = exists(pjoin(root, doc)) ? pjoin(root, doc) : pjoin(pathParent(f), doc)
        if (!isFile(target)) continue // 경로 자체는 2번에서 잡힌다
        if (![...headers(target)].some((header) => header.includes(section))) broken.push([rel, i, `${kind}명`, `${doc} → "${section}"`])
      }

      // 4) 스킬 참조
      for (const m of findall(SKILL_REF, line)) {
        if (!skills.has(m[1]) && !plugins.has(m[1])) broken.push([rel, i, '스킬', m[1]])
      }

      // 5) 절 이름 참조 — 「제목」
      for (const [name, title] of brokenGuideRefs(f, line, null)) broken.push([rel, i, '절 제목', `${name} → 「${title}」`])
    }
  }

  // 지침이 아닌 추적 파일(코드 주석, 프롬프트)이 지침의 절을 가리키는 참조
  for (const [f, text] of trackedTextFiles()) {
    if (scanned.has(pyResolve(f))) continue
    for (const [i, line] of outsideFences(pySplitLines(text))) {
      for (const [name, title] of brokenGuideRefs(f, line, instructions)) broken.push([relativeTo(f, root), i, '절 제목', `${name} → 「${title}」`])
    }
  }

  let out = ''
  if (broken.length) {
    out += `깨진 참조 ${broken.length}건\n\n`
    for (const [rel, i, kind, what] of broken) out += `  ${rel}:${i}  [${kind}] ${what}\n`
  } else {
    out += '깨진 참조 0건\n'
  }
  if (warnings.length) {
    out += `\n경고 ${warnings.length}건 — 이 머신의 홈에 없는 경로. 다른 사람의 경로일 수 있어 실패로 세지 않는다\n\n`
    for (const [rel, i, cand] of warnings) out += `  ${rel}:${i}  [홈 경로] ${cand}\n`
  }
  write(1, out)
  return broken.length ? 1 : 0
}

// str.rstrip(chars)
function rstripChars(text: string, chars: string): string {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1])) end--
  return text.slice(0, end)
}

export function main(argv: string[]): number {
  return run(argv)
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
