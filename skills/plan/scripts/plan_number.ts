#!/usr/bin/env node
// 원격 브랜치와 git 이력까지 훑어 이미 쓰인 plan 번호와 다음 번호를 낸다.
//
// 왜 로컬만 보면 안 되나:
//   main 에 머지되지 않은 원격 브랜치가 이미 다음 번호를 쓰고 있을 수 있다.
//   그 브랜치를 체크아웃하지 않으면 로컬 작업 트리의 tasks/ 에 나타나지 않는다.
//
// 왜 git 이력도 보나:
//   구현이 끝난 계획서는 지운다. 지운 뒤에는 어느 브랜치의 트리에도 없어서
//   트리만 보면 마지막 번호를 다시 내준다. 지운 계획서는 커밋 이력에만 남는다.
//
// 왜 PR 의 head 브랜치 이름도 보나:
//   같은 PR 안에서 계획서를 더하고 지운 뒤 squash 머지하면 main 이력에 계획서가 남지 않는다.
//   머지 후 원 브랜치를 지우면 git log --all 도 그 번호를 보지 못한다.
//   PR 목록은 브랜치를 지워도 남으므로 gh pr list --state all 의 headRefName 에서 번호를 읽는다.
//   기본 형식은 `{접두사}plan{N}-...` 와 `plan/{접두사}{N}-...` 두 가지다. 다른 형식은 읽지 못한다.
//   --name-regex 를 주면 브랜치 이름의 어느 `/` 뒤에서든 그 형식을 앞에서부터 맞춘다.
//   gh 가 없거나 실패하면 번호를 내되, 마지막 줄 앞에 PR 이력을 보지 못했다고 알린다.
//
// 사용법:
//   node plan_number.ts [--tasks-dir DIR] [--prefix PREFIX | --name-regex REGEX] [--allow-empty] [DIR]
//
//   --tasks-dir   계획서를 담는 디렉터리. 저장소 루트 기준이다. 기본값 tasks
//                 이전 호출과 같이 첫 위치 인자로 줘도 된다
//   --prefix      plan 접두사. 모노레포에서 하위 프로젝트마다 번호를 따로 셀 때 쓴다
//                 `fe-` 면 `fe-plan{N}-*` 만 센다. 주지 않으면 접두사 없는 `plan{N}-*` 만 센다
//   --name-regex  저장소가 `plan{N}` 이 아닌 이름을 쓸 때 디렉터리 이름 형식을 정규식으로 준다.
//                 이름 앞에서부터 맞추고, 번호를 잡는 캡처 그룹이 정확히 하나다. `\d` 를 쓸 수 있다
//                 예: `--name-regex 'area-(\d{3})-'` 는 `tasks/area-032-foo/` 에서 32 를 읽는다
//                 접두사도 정규식에 넣으므로 --prefix 와 함께 쓰지 않는다
//   --allow-empty tasks 이력이 있는데 읽은 번호가 0개여도 1 을 낸다. 다른 하위 프로젝트의 계획만 있는 정상 상태용이다
//
// cwd 는 그 저장소 안이어야 한다.
// 번호는 앞의 0 을 떼고 센다. `plan027` 은 27 이다. 자릿수 맞춤은 저장소 관례를 따른다.
// git 은 이력 조회 한 번(`git log --all --full-history -- tasks`)과 main 트리 조회 한 번만 부른다.
// 그래서 main 밖의 계획이 어느 ref 에 있는지는 이력에서 가장 최근 커밋이 닿은 ref 로 근사한다.
//
// 종료 코드:
//   0  훑기 성공. 마지막 줄이 다음 번호다
//   1  옵션에 값이 없다(옛 셸 구현의 `${2:?}` 가 이 코드로 끝났다)
//   2  인자가 잘못됐거나, 저장소가 아니거나, fetch 가 실패했다.
//      또는 tasks 이력에 계획 디렉터리가 있는데 이름 형식으로 해석한 번호가 0개다(형식이 저장소와 다르다)

import { spawnSync } from 'node:child_process'
import { capture, isMain, write } from './io.ts'
import { looksLikeOption } from './cli.ts'
import { planNumbers } from './plan_numbers.ts'

const HELP = `원격 브랜치와 git 이력까지 훑어 이미 쓰인 plan 번호와 다음 번호를 낸다.

사용법:
  plan_number.ts [--tasks-dir DIR] [--prefix PREFIX | --name-regex REGEX] [--allow-empty] [DIR]

  --tasks-dir   계획서를 담는 디렉터리. 저장소 루트 기준이다. 기본값 tasks
                이전 호출과 같이 첫 위치 인자로 줘도 된다
  --prefix      plan 접두사. 모노레포에서 하위 프로젝트마다 번호를 따로 셀 때 쓴다
                \`fe-\` 면 \`fe-plan{N}-*\` 만 센다. 주지 않으면 접두사 없는 \`plan{N}-*\` 만 센다
  --name-regex  저장소가 \`plan{N}\` 이 아닌 이름을 쓸 때 디렉터리 이름 형식을 정규식으로 준다.
                이름 앞에서부터 맞추고, 번호를 잡는 캡처 그룹이 정확히 하나다
                접두사도 정규식에 넣으므로 --prefix 와 함께 쓰지 않는다
  --allow-empty tasks 이력이 있는데 읽은 번호가 0개여도 1 을 낸다

cwd 는 그 저장소 안이어야 한다.
종료 코드: 0 성공, 1 옵션에 값이 없다, 2 인자 오류·저장소 아님·fetch 실패·이름 형식 불일치
`

type Args = { tasksDir: string; prefix: string; nameRegex: string; allowEmpty: boolean }

// 셸의 case 문과 같은 순서로 읽는다. 옵션 이름은 줄여 쓰지 못한다. 종료 코드를 정했으면 그 값을 낸다
function parseArgs(argv: string[]): Args | number {
  const args: Args = { tasksDir: 'tasks', prefix: '', nameRegex: '', allowEmpty: false }
  const valueOf = (option: string, value: string | undefined): string | null => {
    // ${2:?} 는 값이 없거나 빈 문자열이면 멈춘다
    if (value === undefined || value === '') {
      write(2, `plan_number.ts: 2: ${option} 에 값이 없다\n`)
      return null
    }
    return value
  }
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i]
    if (arg === '--tasks-dir' || arg === '--prefix' || arg === '--name-regex') {
      const value = valueOf(arg, argv[i + 1])
      if (value === null) return 1
      if (arg === '--tasks-dir') args.tasksDir = value
      else if (arg === '--prefix') args.prefix = value
      else args.nameRegex = value
      i += 2
    } else if (arg === '--allow-empty') {
      args.allowEmpty = true
      i += 1
    } else if (arg === '-h' || arg === '--help') {
      write(1, HELP)
      return 0
    } else if (arg.startsWith('-')) {
      write(2, `모르는 옵션: ${arg}\n`)
      return 2
    } else {
      args.tasksDir = arg
      i += 1
    }
  }
  if (args.tasksDir.endsWith('/')) args.tasksDir = args.tasksDir.slice(0, -1)
  return args
}

function gitOut(args: string[]): string {
  const done = capture(['git', ...args])
  return done.code === 0 ? done.stdout : ''
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv)
  if (typeof parsed === 'number') return parsed
  const { tasksDir, prefix, nameRegex, allowEmpty } = parsed

  if (nameRegex !== '' && prefix !== '') {
    write(2, '--name-regex 와 --prefix 는 함께 쓰지 않는다. 접두사는 정규식에 넣는다\n')
    return 2
  }
  // 접두사는 정규식 안에서 escape 해 쓰지만 디렉터리 이름 규칙에 맞는 문자만 받는다
  if (/[^A-Za-z0-9_-]/.test(prefix)) {
    write(2, `접두사는 영문, 숫자, -, _ 만 쓴다: ${prefix}\n`)
    return 2
  }
  if (tasksDir === '' || /[^A-Za-z0-9_./-]/.test(tasksDir)) {
    write(2, `tasks 경로는 영문, 숫자, -, _, ., / 만 쓴다: ${tasksDir}\n`)
    return 2
  }

  if (capture(['git', 'rev-parse', '--git-dir']).code !== 0) {
    write(2, `git 저장소가 아니다: ${process.cwd()}\n`)
    return 2
  }

  // fetch 없이 훑으면 다른 세션이 방금 올린 브랜치를 보지 못한다
  if (spawnSync('git', ['fetch', '--all', '--quiet'], { stdio: 'inherit' }).status !== 0) {
    write(2, 'git fetch 가 실패했다. 원격을 보지 못한 번호는 신뢰할 수 없다.\n')
    return 2
  }

  // 이력은 한 번만 읽는다. ref 마다 git 을 따로 부르지 않는다(원격 ref 가 수백 개인 저장소에서 수 분이 걸렸다).
  // --full-history: 머지 전후 경로가 모두 없어도 중간에 지운 계획서를 빠뜨리지 않는다
  const log = gitOut(['-c', 'core.quotepath=off', 'log', '--all', '--full-history', '--no-renames', '--name-status', '--format=%x01%S', '--', tasksDir])

  // main 에 있는 번호는 머지됐지만 아직 지우지 않은 계획이다. 판단이 필요한 것은 main 밖에만 있는 번호다
  const mainRef = capture(['git', 'rev-parse', '--verify', '--quiet', 'origin/main']).code === 0 ? 'origin/main' : 'HEAD'
  const mainTree = gitOut(['-c', 'core.quotepath=off', 'ls-tree', '-d', '--name-only', mainRef, `${tasksDir}/`])

  // 브랜치 이름은 `fe-plan027-login` 이나 `plan/fe-027-login` 이다. 앞에 `feature/` 같은 디렉터리가 붙어도 읽는다
  let heads: string | null = null
  try {
    const done = capture(['gh', 'pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'headRefName', '--jq', '.[].headRefName'])
    if (done.code === 0) heads = done.stdout
  } catch {
    heads = null
  }

  // plan_numbers.py 는 argparse 가 값 자리의 `-` 로 시작하는 인자를 옵션으로 읽어 사용법 오류(2)로 끝났다
  for (const value of [tasksDir, prefix, nameRegex]) {
    if (value !== '' && looksLikeOption(value)) {
      write(2, `plan_numbers: error: expected one argument\n`)
      return 2
    }
  }

  const result = planNumbers({ tasksDir, prefix, nameRegex: nameRegex === '' ? null : nameRegex, allowEmpty, log, mainTree, mainRef, heads })
  if (result.stdout) write(1, result.stdout)
  if (result.stderr) write(2, result.stderr)
  return result.code
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
