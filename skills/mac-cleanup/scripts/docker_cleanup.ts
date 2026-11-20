#!/usr/bin/env node
// 승인한 런타임의 엔진에 이미지 삭제(`docker rmi`)와 빌드 캐시 삭제(`docker builder prune -af`)를 보낸다. 기본은 dry-run 이다.
//
// 사용법:
//   docker_cleanup.ts --runtime ID [--apply] RUNTIMES_JSON builder-prune
//   docker_cleanup.ts --runtime ID [--apply] RUNTIMES_JSON rmi REF [REF ...]
//   docker_cleanup.ts --runtime ID [--apply] --images-json FILE --class 미사용 RUNTIMES_JSON rmi
//
// 옵션은 위치 인자(RUNTIMES_JSON, 동작, REF) 앞에 둔다. 위치 인자는 이어진 덩어리 하나만 받는다.
// RUNTIMES_JSON 은 `container_runtimes.ts --json-out FILE` 이 쓴 파일이고 ID 는 그 파일의 런타임 id 다. REF 는 `docker_images.ts` 줄 끝의 `rmi=` 값이다.
// --images-json FILE 은 `survey_docker.ts` 가 쓴 이미지 조사 파일(`docker_images.ts --json-out`)이다. REF 대신 그 파일에서 --class 분류의 `rmi` 값을 모두 지운다.
// --class 는 `미사용` 이나 `확인 필요(최근 생성)` 이다. `사용 중` 은 받지 않는다. 파일의 context 가 그 런타임의 context 와 다르면 입력 오류다.
// 그 분류의 이미지가 없으면 아무것도 보내지 않고 0 으로 끝난다.
// 명령은 그 런타임의 context 를 지정해(`docker --context <context> ...`) 보낸다. 사용자의 현재 context 설정은 바꾸지 않는다.
// 이 맥 밖의 엔진에는 보내지 않는다(`delete_volumes.ts` 와 같다). 조사 파일에서 이 맥 안의 런타임이 아니거나, 지금 context 의 엔드포인트를 읽어
// 이 맥의 unix 소켓이 아니거나 비어 있으면 dry-run 과 --apply 모두 거부하고 종료 코드 5 로 끝난다. 조사 뒤 context 가 다른 엔진을 가리키게 바뀐 경우도 막는다.
// `rmi` 는 REF 마다 `docker rmi` 를 따로 부르고 `-f` 를 쓰지 않는다. `-` 로 시작하는 REF 는 옵션으로 읽히므로 입력 오류다.
// --apply 가 없으면 아무것도 바꾸지 않고 보낼 명령만 보인다.
//
// 종료 코드: 0 실패 없음, 1 명령이 하나라도 실패함, 2 입력 오류, 4 docker 를 쓸 수 없음, 5 이 맥 밖의 엔진이라 거부.

import { readFileSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { contextEndpoint, isLocalEndpoint, readRuntimesFile } from './container_runtimes.ts'
import { dockerArgv, DockerError, docker, formatSize, useContext } from './docker_volumes.ts'
import { isMain, write } from './io.ts'
import { loadJson, osErrorMessage } from './pylike.ts'

const USAGE = `usage: docker_cleanup.ts [-h] --runtime RUNTIME [--apply]
                         [--images-json IMAGES_JSON]
                         [--class {미사용,확인 필요(최근 생성)}]
                         runtimes_json {builder-prune,rmi} [ref ...]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
승인한 런타임의 엔진에 이미지 삭제와 빌드 캐시 삭제를 보낸다. 기본은 dry-run 이다.

positional arguments:
  runtimes_json
  {builder-prune,rmi}
  ref

options:
  -h, --help            show this help message and exit
  --runtime RUNTIME
  --apply
  --images-json IMAGES_JSON
  --class {미사용,확인 필요(최근 생성)}
`

const ENTRY: Entry = {
  prog: 'docker_cleanup.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [
      { name: 'runtime', value: true, required: true },
      { name: 'apply', value: false },
      { name: 'images-json', value: true },
      { name: 'class', value: true, choices: ['미사용', '확인 필요(최근 생성)'] },
    ],
    positionals: [{ name: 'runtimes_json', nargs: 1 }, { name: 'action', nargs: 1 }, { name: 'refs', nargs: '*' }],
  },
}

export const ACTIONS = ['builder-prune', 'rmi']

type ImageItem = { class: string; rmi: string; size_bytes: number | null }

// 이미지 조사 파일을 읽어 {context, images} 를 돌려준다. 형식이 맞지 않으면 Error 다
export function readImagesFile(text: string): { context: string | null; images: ImageItem[] } {
  const data = loadJson(text) as any
  const bad = new Error('docker_images.ts --json-out 형식이 아니다')
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.images)) throw bad
  if (data.context !== undefined && data.context !== null && typeof data.context !== 'string') throw bad
  for (const i of data.images) {
    if (i === null || typeof i !== 'object' || typeof i.class !== 'string' || typeof i.rmi !== 'string') throw bad
    if (i.size_bytes !== undefined && i.size_bytes !== null && typeof i.size_bytes !== 'number') throw bad
  }
  return { context: data.context ?? null, images: data.images.map((i: any) => ({ class: i.class, rmi: i.rmi, size_bytes: i.size_bytes ?? null })) }
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const file = args.positionals.runtimes_json as string
  const action = args.positionals.action as string
  let refs = (args.positionals.refs as string[] | undefined) ?? []
  const apply = args.options.apply === true
  const id = args.options.runtime as string
  const imagesJson = args.options['images-json'] as string | undefined
  const cls = args.options.class as string | undefined
  if (!ACTIONS.includes(action)) {
    write(2, `입력 오류: 동작은 ${ACTIONS.join(', ')} 중 하나다(받은 값 ${action})\n`)
    return 2
  }
  if ((imagesJson === undefined) !== (cls === undefined)) {
    write(2, '입력 오류: --images-json 과 --class 는 함께 준다\n')
    return 2
  }
  const fromFile = imagesJson !== undefined
  if (fromFile && (action !== 'rmi' || refs.length)) {
    write(2, '입력 오류: --images-json 은 REF 없이 rmi 에만 쓴다\n')
    return 2
  }
  if (!fromFile && ((action === 'rmi') === (refs.length === 0) || (action === 'builder-prune' && refs.length))) {
    write(2, action === 'rmi' ? '입력 오류: rmi 는 REF 가 하나 이상 필요하다\n' : '입력 오류: builder-prune 은 REF 를 받지 않는다\n')
    return 2
  }
  let rt
  try {
    rt = readRuntimesFile(file).find((r) => r.id === id)
  } catch (error) {
    write(2, `입력을 읽을 수 없다: ${osErrorMessage(error, file)}\n`)
    return 2
  }
  let picked: ImageItem[] = []
  if (fromFile) {
    let survey
    try {
      survey = readImagesFile(readFileSync(imagesJson, 'utf8'))
    } catch (error) {
      write(2, `입력을 읽을 수 없다: ${osErrorMessage(error, imagesJson)}\n`)
      return 2
    }
    if (rt && survey.context !== rt.context) {
      write(2, `입력 오류: 이미지 조사 파일의 context(${survey.context ?? '없음'})가 런타임 ${rt.id} 의 context(${rt.context ?? '없음'})와 다르다\n`)
      return 2
    }
    picked = survey.images.filter((i) => i.class === cls)
    refs = picked.map((i) => i.rmi)
  }
  const bad = refs.find((r) => r.startsWith('-'))
  if (bad !== undefined) {
    write(2, `입력 오류: REF 가 -로 시작한다(${bad}). 옵션으로 읽히므로 보내지 않는다\n`)
    return 2
  }
  if (!rt) {
    write(2, `입력 오류: 런타임 ${id} 가 조사 파일에 없다\n`)
    return 2
  }
  if (!rt.local || rt.kind === 'remote') {
    write(2, `거부: ${rt.label}(${rt.id}) 는 이 맥 밖의 엔진이다. 맥 밖 엔진의 이미지와 빌드 캐시는 지우지 않는다\n`)
    return 5
  }
  if (!rt.context) {
    write(2, `입력 오류: ${rt.label}(${rt.id}) 는 조사 파일에 context 가 없어 대상 엔진을 정할 수 없다\n`)
    return 2
  }

  if (fromFile && refs.length === 0) {
    write(1, `이미지 조사 파일에 ${cls} 이미지가 없다. 보낼 명령이 없다\n`)
    return 0
  }

  useContext(rt.context)
  let endpoint: string
  try {
    endpoint = contextEndpoint(rt.context)
  } catch (error) {
    write(2, `docker 를 쓸 수 없다: ${(error as Error).message}\n`)
    return 4
  }
  if (!isLocalEndpoint(endpoint)) {
    write(2, `거부: context ${rt.context} 의 엔드포인트가 이 맥의 unix 소켓이 아니다(${endpoint || '비어 있음'}). 맥 밖 엔진의 이미지와 빌드 캐시는 지우지 않는다\n`)
    return 5
  }

  const commands = action === 'builder-prune' ? [['builder', 'prune', '-af']] : refs.map((ref) => ['rmi', ref])
  write(1, apply ? '## 실행\n' : '## dry-run (변경 없음, 실제 삭제는 --apply)\n')
  write(1, `런타임: ${rt.label}(${rt.id}), context: ${rt.context}\n`)
  if (fromFile) {
    const total = picked.reduce((sum, i) => sum + (i.size_bytes ?? 0), 0)
    write(1, `대상: 이미지 조사 파일의 ${cls} ${picked.length}개, 합계 최대 ${formatSize(total)}\n`)
  }
  let failed = false
  for (const command of commands) {
    const shown = dockerArgv(command).join(' ')
    if (!apply) {
      write(1, `[삭제 예정] ${shown}\n`)
      continue
    }
    try {
      const out = docker(command, 300)
      write(1, `[삭제] ${shown}\n${out}`)
    } catch (error) {
      failed = true
      write(1, `[실패] ${shown}  ${error instanceof DockerError ? error.message : String(error)}\n`)
    }
  }
  return failed ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
