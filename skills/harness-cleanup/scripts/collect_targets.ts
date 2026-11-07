#!/usr/bin/env node
// 하네스 감사 대상과 줄 수를 출력한다.
//
// 사용법: node collect_targets.ts [repo-root] [--scope <저장소 안 경로>]
//
// 종료 코드:
//     0  대상 파일이 1 이상이다
//     2  저장소나 범위 경로가 없거나, 대상 파일이 0 이다.
//        범위에 Markdown 은 없고 스크립트만 있으면 그 수를 표준 오류로 알린다
// 1 은 내지 않는다. 판정은 출력의 대상 파일 수로 한다.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { isMain, ljust, readTextReplace, rjust, write } from './io.ts'
import { pyPathCompare, pySplitLines } from './kit/py.ts'
import { isDir, isRelativeTo, isSymlink, pjoin, pyPath, pyResolve, relativeTo, exists } from './pylike.ts'
import { countScripts, iterTargets, resolveScope, takeScope, ValueError } from './target_files.ts'

// plugins/*/skills 를 이름순으로 찾는다. pathlib 의 glob 처럼 숨은 폴더 이름도 `*` 에 든다
function pluginSkillRoots(root: string): string[] {
  const plugins = pjoin(root, 'plugins')
  if (!isDir(plugins)) return []
  return readdirSync(plugins)
    .filter((name) => isDir(pjoin(plugins, name)))
    .map((name) => pjoin(plugins, name, 'skills'))
    .filter((path) => exists(path))
    .sort(pyPathCompare)
}

// 스킬 루트 바로 밑에서 SKILL.md 도 없고 git 추적 파일도 없는 디렉터리를 찾는다.
// `__pycache__` 와 `.omc` 만 남은 옛 스킬 폴더가 여기 해당한다. git 저장소가 아니거나 git 이 없으면 비운다.
// `--scope` 가 스킬 하나를 가리키면 그 스킬만 본다
function straySkillDirs(root: string, scope: string | null): string[] {
  const roots = [pjoin(root, 'skills'), ...pluginSkillRoots(root)]
  const found: string[] = []
  for (const skillRoot of roots) {
    if (!isDir(skillRoot)) continue
    if (scope !== null && !(isRelativeTo(scope, skillRoot) || isRelativeTo(skillRoot, scope))) continue
    const directories = readdirSync(skillRoot)
      .map((name) => pjoin(skillRoot, name))
      .filter((d) => isDir(d) && !isSymlink(d))
      .sort(pyPathCompare)
    for (const directory of directories) {
      if (scope !== null && isRelativeTo(scope, skillRoot) && scope !== skillRoot) {
        if (!(isRelativeTo(scope, directory) || isRelativeTo(directory, scope))) continue
      }
      if (exists(pjoin(directory, 'SKILL.md'))) continue
      const done = spawnSync('git', ['-C', root, 'ls-files', '--', relativeTo(directory, root)], { encoding: 'utf8' })
      if (done.error) {
        if ((done.error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw done.error
      }
      if (done.status === 0 && done.stdout.trim() === '') found.push(directory)
    }
  }
  return found
}

export function main(argv: string[]): number {
  let rest: string[]
  let scopeArg: string | null
  try {
    ;[rest, scopeArg] = takeScope(argv)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }
  const root = pyResolve(pyPath(rest.length ? rest[0] : '.'))
  if (!isDir(root)) {
    write(2, `대상 저장소를 찾을 수 없다: ${root}\n`)
    return 2
  }
  let scope: string | null
  try {
    scope = resolveScope(root, scopeArg)
  } catch (error) {
    if (!(error instanceof ValueError)) throw error
    write(2, `${error.message}\n`)
    return 2
  }

  for (const directory of straySkillDirs(root, scope)) {
    write(2, `경고: git 이 추적하지 않는 스킬 폴더가 있다 (SKILL.md 없음): ${relativeTo(directory, root)}\n`)
  }

  let count = 0
  let lines = 0
  let external = 0
  let out = scope === null ? '감사 대상\n' : `감사 대상 (범위: ${relativeTo(scope, root)})\n`
  for (const path of iterTargets(root, false, scope)) {
    const relative = relativeTo(path, root)
    const resolved = pyResolve(path)
    if (!isRelativeTo(resolved, root)) {
      out += `  ${relative}  (외부 symlink, 대상 아님)\n`
      external += 1
      continue
    }
    const size = pySplitLines(readTextReplace(path)).length
    out += `  ${ljust(relative, 60)} ${rjust(String(size), 5)}\n`
    count += 1
    lines += size
  }

  out += `\n합계: ${count}개 파일, ${lines}줄\n`
  if (external) out += `외부 symlink: ${external}개\n`
  write(1, out)
  if (count === 0) {
    const scripts = scope !== null ? countScripts(scope) : 0
    if (scripts) {
      write(2, `Markdown 대상은 없고 스크립트 ${scripts}개가 있다.\n`)
      write(2, '저장소 루트는 맞다. references/script-audit.md 의 절차로 스크립트를 감사한다.\n')
    } else {
      write(2, '대상 파일을 찾지 못했다. 저장소 루트를 확인한다.\n')
    }
    return 2
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
