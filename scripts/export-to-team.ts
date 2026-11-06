#!/usr/bin/env node
// 공용 스킬을 팀 저장소로 내보낸다.
//
// 이 저장소가 원본이다. 팀 저장소의 것은 사본이므로 거기서 고치면 다음 내보내기에 덮인다.
// 팀원이 저장소를 둘 받지 않아도 되게 사본을 두는 대신, 어긋남을 이 명령이 잡는다.
//
// 사용법:
//   node scripts/export-to-team.ts            어긋난 파일만 출력한다. 어긋나면 종료 코드 1
//   node scripts/export-to-team.ts --apply    이 저장소의 내용을 팀 저장소로 복사한다
//   --source-ref <커밋>                       작업 트리 대신 그 커밋의 내용을 원본으로 쓴다. --apply 와 함께 쓸 수 있다
//
// 원본은 기본으로 이 저장소(이 파일의 상위 폴더)의 작업 트리다. 체크아웃이 다른 브랜치로 바뀌면 내보내는 내용도 바뀌므로,
// 다른 작업 중에 내보낼 때는 --source-ref origin/main 처럼 커밋을 준다. 옛 커밋(스킬을 저장소 루트에 두던 배치,
// Python 으로 쓰던 때의 team-export 브랜치)도 --source-ref 로 그대로 내보낸다.
// 결과 첫 줄에 원본의 커밋 SHA 를 적는다. 팀 저장소의 커밋 메시지에 옮겨 적으면 어느 원본을 냈는지 남는다.
//
// 팀 저장소 위치는 TEAM_SKILLS_DIR 로 바꾼다(기본 ~/projects/AiSdtSkill). 없으면 검사를 건너뛰고 0 으로 끝난다.
//
// 출력 줄
//   원본: <설명>                    첫 줄. 작업 트리면 HEAD SHA 와 커밋하지 않은 변경 여부, --source-ref 면 그 이름과 SHA
//     없음|다름|남음   <팀 경로>    어긋난 파일. 남음은 팀에만 있는 파일이다
//
// 종료 코드
//   0  같다, --apply 로 내보냈다, 팀 저장소가 없다
//   1  어긋남이 있다(--apply 없이)
//   2  인자 오류, 커밋을 찾지 못했다, 원본에 내보낼 디렉터리가 없다
//   3  팀 저장소의 스킬 버전이 더 높다. 아무것도 쓰지 않았다
//
// 내보내는 목록(SHARED_SKILLS, SHARED_TOOLS)은 한 줄 상수로 둔다. githooks/post-commit.ts 와
// scripts/tests/exported-imports.spec.ts 가 scripts/export-lists.ts 로 이 파일의 글에서 읽는다.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { PY_SPACE, pyDecode, pyPathCompare, pyReadText, pySplitLines } from '../modules/kit/py.ts'
import { isDir, isFile, SKILL_ROOTS, sourcePath } from './skill_paths.ts'
import { isMainModule } from './is-main.ts'

// 팀 저장소로 내보내는 스킬. 늘어나면 여기에 추가한다
export const SHARED_SKILLS = ['content-preview', 'spec', 'technical-design', 'plan', 'implementation', 'verify', 'docs-consolidate', 'docs-audit', 'review-fix', 'korean-check', 'presentation']
// 스킬이 아닌 공용 도구. 이 저장소의 tools/<이름> 이 팀 저장소의 tools/<이름> 이 된다
export const SHARED_TOOLS = ['browser-driver']
// 개인 자산이라 내보내지 않는 경로 (스킬 디렉터리 기준 상대 경로)
const EXCLUDE = new Set(['references/work-writing-persona.md'])

const REPO_DIR = join(import.meta.dirname, '..')
const SELF = 'scripts/export-to-team.ts'

class Exit extends Error {
  code: number
  constructor(code: number) {
    super(`exit ${code}`)
    this.code = code
  }
}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`)
  throw new Exit(code)
}

function gitOut(args: string[], extra: { input?: Buffer } = {}): { ok: boolean; stdout: string } {
  const done = spawnSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...extra })
  return { ok: !done.error && done.status === 0, stdout: done.stdout ?? '' }
}

function isJunk(rel: string): boolean {
  // 빌드 부산물, git 내부 파일, 런타임 상태. 어느 스킬에서나 내보내지 않는다
  const parts = rel.split('/')
  return (
    parts.includes('__pycache__') ||
    parts.includes('.git') ||
    parts.includes('.omc') ||
    parts.includes('.orch') ||
    parts.includes('.DS_Store') ||
    rel.startsWith('changes/') || // 머지 때 workflow 가 지우는 변경 이력 조각(docs/adr/023-version-at-merge.md)
    rel.endsWith('.pyc') ||
    rel.endsWith('.pyo')
  )
}

const S = PY_SPACE
const VERSION_RE = new RegExp(`(?<![^\\n])(?:metadata:\\n${S}+version:${S}*"?|version:${S}*"?)([0-9]+)\\.([0-9]+)\\.([0-9]+)"?${S}*(?![^\\n])`)
const TEAM_FRONTMATTER = new RegExp(`(?<![^\\n])metadata:\\n${S}+version:${S}*"?([0-9]+\\.[0-9]+\\.[0-9]+)"?\\n`)

// SKILL.md frontmatter 의 버전. 두 저장소의 표기가 달라 둘 다 읽는다
function versionOf(text: string): number[] | null {
  const match = VERSION_RE.exec(text)
  return match ? match.slice(1, 4).map(Number) : null
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// 이 저장소의 metadata.version 을 팀 저장소가 검사하는 최상위 version 으로 바꾼다.
// 두 저장소의 frontmatter 규약이 달라, 그대로 복사하면 팀 쪽 validate.sh 가 막는다
function toTeamFrontmatter(text: string): string {
  return text.replace(TEAM_FRONTMATTER, 'version: $1\n')
}

type Pair = [source: string, target: string]

// posixpath.normpath 와 relpath. node 의 normalize 는 끝 / 를 남기고 relative 는 같은 경로에 빈 문자열을 낸다
function normpath(path: string): string {
  const normal = posix.normalize(path)
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal
}

function relpath(target: string, start: string): string {
  return posix.relative(start, target) || '.'
}

// 문서의 링크 주소만 옮긴다. 코드와 명령 예시의 경로는 실행 의미를 갖는다
const LINK_OR_CODE = new RegExp(
  '(?<ticks>`+)(?!`)[\\s\\S]*?(?<!`)\\k<ticks>(?!`)' +
    '|(?<leader>\\]\\([ \\t]*<?|(?<![^\\n])[ \\t]{0,3}\\[[^\\]\\n]+\\]:[ \\t]*<?)' +
    '(?<destination>(?:\\.{1,2}/)+(?:[A-Za-z0-9_.*-]+/?)+)',
  'g',
)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rendered(repo: string, pairs: Pair[], src: string, rel: string): Buffer {
  const raw = readFileSync(src)
  if (posix.extname(posix.basename(src)) !== '.md' || rel.split('/').includes('tests')) return raw
  let text = pyDecode(raw)
  if (rel === 'SKILL.md') text = toTeamFrontmatter(text)
  // 원본의 두 스킬 루트를 팀의 skills/ 한곳으로 내보낼 때 상대 참조도 함께 옮긴다
  const sourceFile = src.slice(repo.length + 1)
  const [prefix, dst] = pairs.find(([before]) => sourceFile.startsWith(`${before}/`))!
  const targetFile = dst + sourceFile.slice(prefix.length)
  const relocate = (value: string) => {
    const resolved = normpath(posix.join(posix.dirname(sourceFile), value))
    for (const [before, after] of pairs) {
      if (resolved === before || resolved.startsWith(`${before}/`)) {
        const target = after + resolved.slice(before.length)
        const result = relpath(target, posix.dirname(targetFile))
        return value.startsWith('./') && !result.startsWith('.') ? `./${result}` : result
      }
    }
    return value
  }
  const rewriteProse = (prose: string) =>
    prose.replace(LINK_OR_CODE, (all, ...args) => {
      const groups = args.at(-1) as { leader?: string; destination?: string }
      return groups.destination ? groups.leader + relocate(groups.destination) : all
    })

  const result: string[] = []
  const prose: string[] = []
  let fence: string | null = null
  for (const line of pySplitLines(text, true)) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      result.push(line)
      if (new RegExp(`^[ \\t]*${escapeRegExp(fence[0])}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`).test(line)) fence = null
    } else if (marker || line.startsWith('    ') || line.startsWith('\t')) {
      result.push(rewriteProse(prose.join('')))
      prose.length = 0
      result.push(line)
      if (marker) fence = marker[1]
    } else {
      prose.push(line)
    }
  }
  result.push(rewriteProse(prose.join('')))
  return Buffer.from(result.join(''), 'utf8')
}

// rglob("*") 의 파일을 Path 정렬 순서로. 링크 폴더는 따라 들어가지 않는다
function walkFiles(base: string): string[] {
  const found: string[] = []
  const visit = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const sub = rel ? `${rel}/${name}` : name
      const stat = lstatSync(path)
      if (stat.isDirectory()) visit(path, sub)
      else if (isFile(path)) found.push(sub)
    }
  }
  visit(base, '')
  return found.sort(pyPathCompare)
}

// pathlib.Path 의 꼴. 겹친 / 와 . 조각, 끝의 / 를 지우고 .. 는 그대로 둔다. 옛 명령의 팀 경로 출력이 이 꼴이었다
function pathlibForm(path: string): string {
  const parts = path.split('/').filter((part, i) => (part !== '' || i === 0) && part !== '.')
  const joined = parts.join('/')
  return joined === '' ? (path.startsWith('/') ? '/' : '.') : joined
}

function exportFiles(repo: string, teamDir: string, apply: boolean): number {
  const team = pathlibForm(teamDir)
  const pairs: Pair[] = [
    ...SHARED_SKILLS.map((name): Pair => [sourcePath(repo, name).slice(repo.length + 1), `skills/${name}`]),
    ...SHARED_TOOLS.map((name): Pair => [`tools/${name}`, `tools/${name}`]),
  ]

  // 방향 보호. 이 저장소가 원본이라는 전제는 이쪽 버전이 뒤처지지 않았을 때만 성립한다.
  // 팀 쪽에서 직접 고친 뒤 버전을 올리면 --apply 가 그것을 옛 내용으로 되돌린다 (실측).
  // 한 파일도 건드리기 전에 전부 본다. 복사하면서 검사하면 뒤 스킬에서 막아도 앞 스킬은 이미 덮인다.
  const regressions: string[] = []
  for (const [srcRel, dstRel] of pairs) {
    if (!isDir(join(repo, srcRel))) fail(2, `이 저장소에 없다: ${srcRel}`)
    const ourSkill = join(repo, srcRel, 'SKILL.md')
    const theirSkill = join(team, dstRel, 'SKILL.md')
    if (!(isFile(ourSkill) && isFile(theirSkill))) continue
    const ours = versionOf(pyReadText(ourSkill))
    const theirs = versionOf(pyReadText(theirSkill))
    if (ours && theirs && newer(theirs, ours)) regressions.push(`  ${srcRel}: 팀 ${theirs.join('.')} > 이 저장소 ${ours.join('.')}`)
  }
  if (regressions.length > 0) {
    out('팀 저장소의 버전이 더 높다. 내보내면 팀의 수정을 되돌린다:')
    out(regressions.join('\n'))
    out('\n팀 쪽 변경을 이 저장소로 먼저 가져온 뒤 다시 실행한다.')
    return 3
  }

  const drift: string[] = []
  for (const [srcRel, dstRel] of pairs) {
    const srcDir = join(repo, srcRel)
    const dstDir = join(team, dstRel)
    const seen = new Set<string>()
    for (const rel of walkFiles(srcDir)) {
      if (EXCLUDE.has(rel) || isJunk(rel)) continue
      seen.add(rel)
      const src = join(srcDir, rel)
      const dst = join(dstDir, rel)
      const want = rendered(repo, pairs, src, rel)
      if (!existsSync(dst)) drift.push(`  없음   ${dstRel}/${rel}`)
      else if (!readFileSync(dst).equals(want)) drift.push(`  다름   ${dstRel}/${rel}`)
      else continue
      if (apply) {
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, want)
        chmodSync(dst, statSync(src).mode & 0o7777)
      }
    }
    // 이 저장소에서 지운 파일이 사본에만 남는 것도 어긋남이다
    if (isDir(dstDir)) {
      for (const rel of walkFiles(dstDir)) {
        if (EXCLUDE.has(rel) || isJunk(rel) || seen.has(rel)) continue
        drift.push(`  남음   ${dstRel}/${rel}`)
        if (apply) unlinkSync(join(dstDir, rel))
      }
    }
  }

  if (drift.length === 0) {
    out('팀 저장소의 사본이 원본과 같다.')
    return 0
  }
  if (apply) {
    out('팀 저장소에 내보냈다:')
    out(drift.join('\n'))
    out(`\n${team} 에서 커밋해야 팀에 전파된다.`)
    return 0
  }
  out('팀 저장소의 사본이 원본과 어긋난다:')
  out(drift.join('\n'))
  out(`\n팀 저장소: ${team}`)
  out(`반영: ${SELF} --apply`)
  return 1
}

// 그 원본에서 스킬의 실제 경로를 고른다. 옛 커밋도 내보낼 수 있게 저장소 루트도 본다
function sharedPaths(sourceRef: string, sourceSha: string): string[] {
  if (!sourceRef) {
    const paths: string[] = []
    for (const name of SHARED_SKILLS) {
      try {
        paths.push(sourcePath(REPO_DIR, name).slice(REPO_DIR.length + 1))
      } catch {
        // 찾지 못한 스킬은 아래 개수 대조에서 걸린다
      }
    }
    return paths
  }
  const files = pySplitLines(gitOut(['ls-tree', '-r', '--name-only', sourceSha]).stdout)
  const paths: string[] = []
  for (const name of SHARED_SKILLS) {
    for (const prefix of [...SKILL_ROOTS, '']) {
      const candidate = prefix ? `${prefix}/${name}` : name
      if (files.some((file) => file.startsWith(`${candidate}/`))) {
        paths.push(candidate)
        break
      }
    }
  }
  return paths
}

export function main(argv: string[]): number {
  let apply = false
  let sourceRef = ''
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') apply = true
    else if (arg === '--source-ref') {
      const value = argv[i + 1] ?? ''
      if (value === '' || value.startsWith('-')) fail(2, '--source-ref 뒤에 커밋이나 브랜치를 준다')
      sourceRef = value
      i++
    } else fail(2, `알 수 없는 인자: ${arg}  (쓸 수 있는 것은 --apply, --source-ref 다)`)
  }
  const team = process.env.TEAM_SKILLS_DIR || join(homedir(), 'projects/AiSdtSkill')

  // 잘못된 ref 는 팀 저장소가 없는 환경에서도 드러나게, 팀 저장소 확인보다 앞에서 푼다
  let sourceSha = ''
  if (sourceRef) {
    const found = gitOut(['rev-parse', '--verify', '--quiet', `${sourceRef}^{commit}`])
    if (!found.ok) fail(2, `커밋을 찾지 못했다: ${sourceRef}`)
    sourceSha = found.stdout.trim()
  }

  if (!isDir(join(team, 'skills'))) {
    out(`팀 저장소가 없어 건너뛴다: ${team}`)
    return 0
  }

  const paths = sharedPaths(sourceRef, sourceSha)
  if (paths.length !== SHARED_SKILLS.length) fail(2, '그 원본에 내보낼 스킬 디렉터리가 없다')
  const exported = [...paths, ...SHARED_TOOLS.map((name) => `tools/${name}`)]

  let srcDir = REPO_DIR
  let description: string
  let cleanup = ''
  if (sourceRef) {
    srcDir = mkdtempSync(join(tmpdir(), 'export-to-team-'))
    cleanup = srcDir
    // .gitattributes 의 export-ignore 가 붙은 파일은 archive 에서 빠져 팀 쪽 사본이 「남음」 으로 지워진다.
    // 이 경로는 추적하는 파일만 원본으로 본다. 기본 경로는 작업 트리의 추적하지 않는 파일도 본다.
    // 내보내는 디렉터리만 풀어 양을 줄인다.
    // 그 커밋에 내보낼 디렉터리가 없으면 pathspec 오류이므로 기본 경로와 같게 종료 코드 2 로 끝낸다.
    const archive = spawnSync('git', ['-C', REPO_DIR, 'archive', sourceSha, '--', ...exported], { maxBuffer: 1024 * 1024 * 1024 })
    const untar = archive.status === 0 ? spawnSync('tar', ['-x', '-C', srcDir], { input: archive.stdout }) : null
    if (!untar || untar.status !== 0) {
      rmSync(cleanup, { recursive: true, force: true })
      fail(2, `그 커밋에 내보낼 디렉터리가 없다: ${sourceRef}`)
    }
    description = `${sourceRef} (${sourceSha})`
  } else {
    // git archive 로 푼 사본처럼 git 저장소가 아니어도 기본 경로는 돌아야 한다. SHA 와 변경 표시만 생략한다
    const head = gitOut(['rev-parse', 'HEAD'])
    if (head.ok) {
      description = `작업 트리 (HEAD ${head.stdout.trim()})`
      if (gitOut(['status', '--porcelain', '--', ...exported]).stdout) description += ', 커밋하지 않은 변경 있음'
    } else {
      description = '작업 트리 (git 저장소 아님)'
    }
  }
  out(`원본: ${description}`)
  try {
    return exportFiles(srcDir, team, apply)
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true })
  }
}

function run(argv: string[]): number {
  try {
    return main(argv)
  } catch (error) {
    if (error instanceof Exit) return error.code
    throw error
  }
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
const isMain = isMainModule(import.meta.url, import.meta.main)
if (isMain) process.exitCode = run(process.argv.slice(2))
