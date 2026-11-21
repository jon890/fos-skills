#!/usr/bin/env node
// `docker_volumes.ts --json-out` 결과의 익명 volume 을 지운다. 기본은 dry-run 이다.
//
// 사용법:
//   delete_volumes.ts VOLUMES_JSON [--context NAME] [--kind postgres mysql other ...] [--apply]
//
// VOLUMES_JSON 은 `docker_volumes.ts --peek all --json-out FILE` 이 쓴 파일이고, `-` 이면 표준 입력을 읽는다.
// 지우는 대상은 분류가 `후보` 이고, 내용을 열어 본 결과가 있고(peek_error 없음), kind 가 --kind 에 든 volume 뿐이다.
// --kind 는 여러 번 또는 여러 값으로 받는다. 기본은 postgres 와 mysql 이다. 에이전트 홈과 SQLite 파일 같은
// `other` 는 기본으로 지우지 않으며, 사용자가 따로 승인한 뒤 `--kind other` 로만 지운다.
// 열어 보지 않은 volume 과 `최근` volume 은 `유지` 로 보인다.
// 실행 직전에 dangling 목록을 다시 읽어, 그사이 컨테이너에 붙었거나 이미 없는 volume 은 `유지` 로 보인다.
// 지우기는 이름마다 `docker volume rm` 을 따로 부른다. `docker volume prune` 은 쓰지 않는다.
// ryuk 컨테이너가 떠 있으면 dry-run 은 경고만 내고 `--apply` 는 거부한다.
// --apply 가 없으면 아무것도 바꾸지 않고 무엇을 할지만 보인다.
// 지우는 엔진은 조사 JSON 의 `context`(`docker_volumes.ts --context` 가 적는다)다. `--context` 를 함께 주면 JSON 의 값과 같아야 하고, 둘 다 없으면 현재 context 다.
// 조사한 런타임과 지우는 런타임이 달라지지 않게 하려는 것이다. 사용자의 현재 context 설정은 바꾸지 않는다.
// 지우기 전에 그 엔진의 엔드포인트를 읽어, 이 맥의 unix 소켓이 아니거나(ssh, tcp 등) 비어 있으면 dry-run 과 --apply 모두 거부한다. 맥 밖 엔진의 데이터는 지우지 않는다.
//
// 종료 코드: 0 실패 없음, 1 실패가 하나라도 있음, 2 입력 오류, 3 ryuk 가 떠 있어 --apply 거부, 4 docker 를 쓸 수 없음, 5 이 맥 밖의 엔진이라 거부.

import { readArgs, type Entry } from './cli.ts'
import { isMain, readInput, rjust, rstrip, write } from './io.ts'
import { pySplitLines, pyStrCompare } from './kit/py.ts'
import { loadJson, splitWhitespace } from './pylike.ts'
import { contextEndpoint, isLocalEndpoint } from './container_runtimes.ts'
import { docker, formatSize, hasRyuk, isAnonymous, KINDS, useContext } from './docker_volumes.ts'

const USAGE = `usage: delete_volumes.ts [-h] [--context CONTEXT]
                         [--kind {postgres,mysql,other} [{postgres,mysql,other} ...]]
                         [--apply]
                         volumes_json
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
\`docker_volumes.py --json-out\` 결과의 익명 volume 을 지운다. 기본은 dry-run 이다.

positional arguments:
  volumes_json

options:
  -h, --help            show this help message and exit
  --context CONTEXT
  --kind {postgres,mysql,other} [{postgres,mysql,other} ...]
  --apply
`

const DEFAULT_KINDS = ['postgres', 'mysql']

const ENTRY: Entry = {
  prog: 'delete_volumes.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [{ name: 'context', value: true }, { name: 'kind', value: true, plus: true, extend: true, choices: KINDS }, { name: 'apply', value: false }],
    positionals: [{ name: 'volumes_json', nargs: 1 }],
  },
}

type Json = Record<string, any>
type Result = { name: string; status: string; detail: string; size_bytes: number }

const result = (vol: Json, status: string, detail = ''): Result => ({ name: vol.name, status, detail, size_bytes: vol.size_bytes || 0 })

// 지금 dangling 인 volume 이름 집합. docker 를 쓸 수 없으면 던진다
export function listDangling(): Set<string> {
  return new Set(splitWhitespace(docker(['volume', 'ls', '-f', 'dangling=true', '-q'])))
}

export function ryukRunning(): boolean {
  return hasRyuk(pySplitLines(docker(['ps', '--format', '{{.Image}}'])))
}

// `docker volume rm <이름>` 하나를 부른다. [성공 여부, 오류 문장] 을 돌려준다
export function removeVolume(name: string): [boolean, string] {
  try {
    docker(['volume', 'rm', name])
  } catch (error) {
    return [false, (error as Error).message]
  }
  return [true, '']
}

// volume 하나를 처리한다. status: 삭제, 삭제 예정, 유지, 실패
export function processVolume(vol: Json, kinds: Set<string>, apply: boolean, dangling: Set<string>, remove: (name: string) => [boolean, string]): Result {
  const name = vol.name
  if (!isAnonymous(name)) return result(vol, '유지', '익명 volume 이름이 아니다')
  if (vol.class !== '후보') return result(vol, '유지', `분류 ${vol.class ?? 'None'}`)
  if (vol.peek_error) return result(vol, '유지', `내용을 열지 못했다: ${vol.peek_error}`)
  if (vol.kind === null || vol.kind === undefined) return result(vol, '유지', '내용을 열어 보지 않았다')
  if (!kinds.has(vol.kind)) return result(vol, '유지', `종류 ${vol.kind} 는 --kind 에 없다`)
  if (!dangling.has(name)) return result(vol, '유지', 'dangling 목록에 없다(이미 없거나 컨테이너에 붙었다)')
  if (!apply) return result(vol, '삭제 예정', `docker volume rm (${vol.kind})`)
  const [ok, err] = remove(name)
  return ok ? result(vol, '삭제', `(${vol.kind})`) : result(vol, '실패', err)
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const given = args.options.kind as string[] | undefined
  const kinds = new Set(given && given.length ? given : DEFAULT_KINDS)
  const apply = args.options.apply === true
  let volumes: Json[]
  let context: string | null = (args.options.context as string | undefined) ?? null
  try {
    const data = loadJson(readInput(args.positionals.volumes_json as string)) as Json
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('docker_volumes.ts --json-out 형식이 아니다')
    volumes = data.volumes
    if (data.context !== undefined && data.context !== null && typeof data.context !== 'string') throw new Error('docker_volumes.ts --json-out 형식이 아니다')
    if (typeof data.context === 'string') {
      if (context !== null && context !== data.context) throw new Error(`--context ${context} 가 조사 파일의 context ${data.context} 와 다르다`)
      context = data.context
    }
    if (!Array.isArray(volumes) || volumes.some((v) => v === null || typeof v !== 'object' || !('name' in v) || typeof v.name !== 'string' || (v.size_bytes !== undefined && v.size_bytes !== null && typeof v.size_bytes !== 'number'))) throw new Error('docker_volumes.ts --json-out 형식이 아니다')
  } catch (error) {
    write(2, `입력을 읽을 수 없다: ${(error as Error).message}\n`)
    return 2
  }

  useContext(context)
  let endpoint: string
  try {
    endpoint = contextEndpoint(context)
  } catch (error) {
    write(2, `docker 를 쓸 수 없다: ${(error as Error).message}\n`)
    return 4
  }
  if (!isLocalEndpoint(endpoint)) {
    write(2, `거부: ${context ? `context ${context}` : '현재 docker 엔진'} 의 엔드포인트가 이 맥의 unix 소켓이 아니다(${endpoint || '비어 있음'}). 맥 밖 엔진의 volume 은 지우지 않는다\n`)
    return 5
  }

  let ryuk: boolean
  let dangling: Set<string>
  try {
    ryuk = ryukRunning()
    dangling = listDangling()
  } catch (error) {
    write(2, `docker 를 쓸 수 없다: ${(error as Error).message}\n`)
    return 4
  }
  if (ryuk) {
    if (apply) {
      write(2, '거부: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 --apply 를 하지 않는다\n')
      return 3
    }
    write(1, '경고: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 --apply 전에 사용자에게 알린다\n')
  }

  write(1, apply ? '## 실행\n' : '## dry-run (변경 없음, 실제 삭제는 --apply)\n')
  if (context) write(1, `context: ${context}\n`)
  write(1, `대상 종류: ${KINDS.filter((k) => kinds.has(k)).join(', ')}\n`)
  const results = volumes.map((v) => processVolume(v, kinds, apply, dangling, removeVolume))
  for (const r of results) write(1, `${rstrip(`[${r.status}] ${rjust(formatSize(r.size_bytes), 9)}  ${r.name}  ${r.detail}`)}\n`)
  const counts = new Map<string, [number, number]>()
  for (const r of results) {
    const slot = counts.get(r.status) ?? [0, 0]
    slot[0] += 1
    slot[1] += r.size_bytes
    counts.set(r.status, slot)
  }
  write(1, '\n## 합계\n')
  for (const key of [...counts.keys()].sort(pyStrCompare)) {
    const [count, size] = counts.get(key)!
    write(1, `${rjust(String(count), 4)}개 ${rjust(formatSize(size), 9)}  ${key}\n`)
  }
  return counts.get('실패') ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
