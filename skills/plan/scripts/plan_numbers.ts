// plan_number.ts 가 모은 git 이력, main 트리, PR 브랜치 이름에서 쓰인 plan 번호와 다음 번호를 낸다.
//
// 직접 부르지 않는다. 입력은 plan_number.ts 가 git 과 gh 에서 읽어 넘긴다.
//
//     log        git log --all --full-history --name-status --format=%x01%S -- TASKS_DIR 의 출력
//     mainTree   main 의 TASKS_DIR 디렉터리 목록(git ls-tree -d --name-only)
//     heads      PR head 브랜치 이름. null 이면 PR 이력을 보지 못한 것이다
//
// 이름 형식은 디렉터리 이름 앞에서부터 맞춘다. 캡처 그룹이 하나이고 그 그룹이 번호다.
// nameRegex 가 없으면 `{prefix}plan(\d+)-` 이다.
//
// 종료 코드: 0 성공, 2 인자 오류 또는 tasks 이력의 이름을 하나도 해석하지 못함.

import { pyInt, pyLen, pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'
import { escapeRegExp, stripChars } from './pylike.ts'

const PR_WARNING = 'PR 이력을 보지 못했다 (gh 미설치 또는 인증 실패). squash 머지 후 브랜치를 지운 번호는 빠졌을 수 있다.'
const STATUS_LINE = /^([A-Z])\p{Nd}*\t(.+)$/u

export type History = Map<string, [alive: boolean, sources: string[]]>

// tasks_dir 바로 아래 디렉터리 이름이다. 디렉터리 안의 파일이 아니면 null
function dirOf(path: string, tasksDir: string): string | null {
  const prefix = `${tasksDir}/`
  if (!path.startsWith(prefix)) return null
  const parts = path.slice(prefix.length).split('/')
  return parts.length >= 2 ? parts[0] : null
}

// 디렉터리 이름마다 [지금 살아 있는지, 살아 있는 쪽의 ref 목록] 을 낸다.
// log 는 최신 커밋부터 나온다. 파일마다 처음 만난 상태가 마지막 상태다. 디렉터리는 살아 있는 파일이 하나라도 있으면 살아 있다
export function parseLog(lines: string[], tasksDir: string): History {
  let source = ''
  const last = new Map<string, string>()
  const sources = new Map<string, string[]>()
  for (const line of lines) {
    if (line.startsWith('\x01')) {
      source = line.slice(1)
      if (source.startsWith('refs/heads/')) source = source.slice('refs/heads/'.length)
      if (source.startsWith('refs/remotes/')) source = source.slice('refs/remotes/'.length)
      continue
    }
    const found = STATUS_LINE.exec(line)
    if (!found) continue
    const name = dirOf(found[2], tasksDir)
    if (name === null || last.has(`${name}\0${found[2]}`)) continue
    last.set(`${name}\0${found[2]}`, found[1])
    if (found[1] !== 'D') {
      if (!sources.has(name)) sources.set(name, [])
      if (source && !sources.get(name)!.includes(source)) sources.get(name)!.push(source)
    }
  }
  const alive = new Set<string>()
  const names = new Set<string>()
  for (const [key, status] of last) {
    const name = key.split('\0')[0]
    names.add(name)
    if (status !== 'D') alive.add(name)
  }
  return new Map([...names].map((name) => [name, [alive.has(name), sources.get(name) ?? []] as [boolean, string[]]]))
}

function mainNames(lines: string[], tasksDir: string): Set<string> {
  const prefix = `${tasksDir}/`
  return new Set(lines.filter((line) => pyStrip(line)).map((line) => stripChars(line.startsWith(prefix) ? line.slice(prefix.length) : line, '/')))
}

function headPatterns(prefix: string): RegExp[] {
  const escaped = escapeRegExp(prefix)
  return [new RegExp(`^(?:.*/)?${escaped}plan(\\p{Nd}+)(?:-.*)?$`, 'u'), new RegExp(`^plan/${escaped}(\\p{Nd}+)(?:-.*)?$`, 'u')]
}

// PR head 브랜치 이름에서 번호를 읽는다.
// 기본 형식은 `{접두사}plan{N}-...` 와 `plan/{접두사}{N}-...` 다. nameRegex 가 있으면 브랜치 이름의 어느 `/` 뒤에서든 그 형식을 앞에서부터 맞춘다
function branchNumbers(heads: string[], nameRegex: RegExp | null, prefix: string): Set<number> {
  const numbers = new Set<number>()
  for (const head of heads) {
    if (nameRegex === null) {
      for (const pattern of headPatterns(prefix)) {
        const found = pattern.exec(head)
        if (found) numbers.add(pyInt(found[1]))
      }
      continue
    }
    const pieces = head.split('/')
    for (let i = 0; i < pieces.length; i++) {
      const found = matchAtStart(nameRegex, pieces.slice(i).join('/'))
      if (found && /^\p{Nd}+$/u.test(found[1] ?? '')) {
        numbers.add(pyInt(found[1]))
        break
      }
    }
  }
  return numbers
}

// re.match 처럼 앞에서부터 맞춘다
function matchAtStart(regex: RegExp, text: string): RegExpExecArray | null {
  regex.lastIndex = 0
  return regex.exec(text)
}

export type Input = {
  tasksDir: string
  prefix: string
  nameRegex: string | null
  allowEmpty: boolean
  log: string
  mainTree: string
  mainRef: string
  heads: string | null
}
export type Output = { code: number; stdout: string; stderr: string }

const fail = (message: string): Output => ({ code: 2, stdout: '', stderr: `plan_numbers: error: ${message}\n` })

export function planNumbers(input: Input): Output {
  let regex: RegExp
  if (input.nameRegex !== null) {
    if (input.prefix) return fail('--name-regex 와 --prefix 는 함께 쓰지 않는다. 접두사는 정규식에 넣는다')
    try {
      regex = new RegExp(input.nameRegex, 'y')
    } catch (error) {
      return fail(`--name-regex 가 정규식이 아니다: ${(error as Error).message}`)
    }
    if (new RegExp(`${input.nameRegex}|`).exec('')!.length - 1 !== 1) return fail("--name-regex 에는 번호를 잡는 캡처 그룹이 하나여야 한다. 예: 'area-(\\d{3})-'")
  } else {
    regex = new RegExp(`${escapeRegExp(input.prefix)}plan(\\p{Nd}+)-`, 'uy')
  }
  const numberOf = (name: string): number | null => {
    const found = matchAtStart(regex, name)
    return found && /^\p{Nd}+$/u.test(found[1] ?? '') ? pyInt(found[1]) : null
  }
  const history = parseLog(pySplitLines(input.log), input.tasksDir)
  const inMain = mainNames(pySplitLines(input.mainTree), input.tasksDir)
  const names = [...new Set([...history.keys(), ...inMain])].sort(pyStrCompare)

  const numbers = new Map<number, string[]>() // 번호 -> 그 번호로 읽힌 디렉터리 이름
  for (const name of names) {
    const number = numberOf(name)
    if (number !== null) {
      if (!numbers.has(number)) numbers.set(number, [])
      numbers.get(number)!.push(name)
    }
  }

  if (numbers.size === 0 && !input.allowEmpty) {
    // 접두사를 준 기본 형식은 그 접두사로 시작하는 디렉터리가 있을 때만 형식 불일치로 본다.
    // 모노레포에서 다른 하위 프로젝트의 계획만 있는 경우는 정상이다
    const relevant = names.filter((n) => input.nameRegex !== null || n.startsWith(input.prefix))
    if (relevant.length > 0) {
      return {
        code: 2,
        stdout: '',
        stderr:
          `tasks 이력에 계획 디렉터리 ${relevant.length}개가 있는데 이름 형식으로 해석한 번호가 0개다: ${relevant.slice(0, 5).join(', ')}\n` +
          "저장소의 이름 형식을 --name-regex 로 준다. 예: --name-regex 'area-(\\d{3})-' (캡처 그룹이 번호). 다른 형식의 계획만 있는 정상 상태면 --allow-empty 를 준다\n",
      }
    }
  }

  const prSeen = input.heads !== null
  const prNumbers = prSeen ? branchNumbers(pySplitLines(input.heads!), input.nameRegex !== null ? regex : null, input.prefix) : new Set<number>()
  const all = [...new Set([...numbers.keys(), ...prNumbers])].sort((a, b) => a - b)

  const out: string[] = []
  if (all.length === 0) {
    out.push('쓰인 번호가 없다')
    if (!prSeen) out.push(PR_WARNING)
    out.push('다음 번호: 1')
    return { code: 0, stdout: `${out.join('\n')}\n`, stderr: '' }
  }

  out.push('쓰인 번호:')
  const mainLabels = new Set([input.mainRef, input.mainRef.startsWith('origin/') ? input.mainRef.slice('origin/'.length) : input.mainRef])
  for (const number of all) {
    const dirs = numbers.get(number) ?? []
    const label = input.nameRegex === null ? `${input.prefix}plan${number}` : dirs.slice(0, 2).join(', ') || `번호 ${number}`
    const padded = `${label}${' '.repeat(Math.max(0, 12 - pyLen(label)))}`
    if (dirs.some((d) => inMain.has(d))) {
      out.push(`  ${padded} ${input.mainRef} 안에 있다`)
      continue
    }
    // main 은 위에서 트리로 판정했다. main 에서 지운 계획이 main 쪽 이력에서 살아 있는 것으로 읽혀도 밖에 있는 것으로 세지 않는다
    const outside: string[] = []
    for (const d of dirs) {
      const entry = history.get(d) ?? [false, []]
      if (entry[0]) for (const src of entry[1]) if (!mainLabels.has(src)) outside.push(src)
    }
    if (outside.length > 0) out.push(`  ${padded} ${input.mainRef} 밖에만 있다: ${[...new Set(outside)].join(' ')}`)
    else if (dirs.length > 0) out.push(`  ${padded} 지워졌고 git 이력에만 있다`)
    else out.push(`  ${padded} PR 브랜치 이름에만 있다`)
  }
  if (!prSeen) out.push(PR_WARNING)
  out.push(`다음 번호: ${all.at(-1)! + 1}`)
  return { code: 0, stdout: `${out.join('\n')}\n`, stderr: '' }
}
