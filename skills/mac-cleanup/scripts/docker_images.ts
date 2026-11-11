#!/usr/bin/env node
// Docker 이미지를 사용 중, 미사용, 최근 생성으로 나눈다. 읽기 전용이다.
//
// 사용법:
//   docker_images.ts [--context NAME] [--recent-hours 24]
//
// --context NAME 은 그 docker context 의 엔진을 조사한다. 현재 context 설정은 바꾸지 않는다. 주면 출력 첫 줄에 `## context: NAME` 이 붙는다.
//
// 종료 코드: 0 조사 완료, 1 docker 를 쓸 수 없음.
// 각 줄 끝의 rmi= 값을 `docker rmi` 에 그대로 넘긴다. 태그가 있으면 repo:tag, 저장소나 태그가 <none> 이거나 repo:tag 로 조회되지 않으면(repo:tag@digest 로 저장된 이미지) 이미지 ID 다.
// 컨테이너의 Image 값과 repo:tag 를 비교할 때 태그 생략(:latest)을 맞춘다.

import { readArgs, type Entry } from './cli.ts'
import { isMain, ljust, rjust, runText, write } from './io.ts'
import { pySplitLines } from './kit/py.ts'
import { loadJson, mktimeLocal, parsePyFloat, pyTime, splitWhitespace } from './pylike.ts'
import { docker, dockerArgv, useContext } from './docker_volumes.ts'

const USAGE = `usage: docker_images.ts [-h] [--context CONTEXT] [--recent-hours RECENT_HOURS]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
Docker 이미지를 사용 중, 미사용, 최근 생성으로 나눈다. 읽기 전용이다.

options:
  -h, --help            show this help message and exit
  --context CONTEXT
  --recent-hours RECENT_HOURS
`

const ENTRY: Entry = {
  prog: 'docker_images.ts',
  usage: USAGE,
  help: HELP,
  spec: { options: [{ name: 'context', value: true }, { name: 'recent-hours', value: true, float: true }], positionals: [] },
}

// 태그가 없으면 :latest 를 붙인다. digest(@sha256) 가 있으면 그대로 둔다. 레지스트리 포트의 ':' 는 태그로 보지 않는다
export function normalizeImage(ref: string): string {
  if (ref.includes('@')) return ref
  const last = ref.split('/').at(-1)!
  return last.includes(':') ? ref : `${ref}:latest`
}

// image 는 {ref, id, created_ts}. 사용 중 / 최근 생성 / 미사용 으로 나눈다
export function classifyImage(image: { ref: string; id: string; created_ts: number }, usedRefs: Set<string>, usedIds: Set<string | undefined>, now: number, recentHours: number): string {
  if (usedIds.has(image.id) || usedRefs.has(normalizeImage(image.ref))) return '사용 중'
  if (now - image.created_ts < recentHours * 3600) return '확인 필요(최근 생성)'
  return '미사용'
}

// `sha256:` 접두사를 떼고 12자리로 줄인다. `docker images` 가 보이는 짧은 ID 와 같다
export function shortId(imageId: string): string {
  return Array.from(imageId.startsWith('sha256:') ? imageId.slice(7) : imageId).slice(0, 12).join('')
}

// `docker rmi` 에 그대로 넘길 값. 저장소나 태그가 <none> 이면 repo:<none> 이 invalid reference format 이라 이미지 ID 를 쓴다.
// 태그는 있어도 repo:tag 로 조회되지 않으면(이름이 repo:tag@digest 로 저장된 경우) 이미지 ID 를 쓴다. resolves 는 조회 결과다
export function rmiTarget(repository: string, tag: string, imageId: string, resolves = true): string {
  if (repository === '<none>' || tag === '<none>' || !resolves) return shortId(imageId)
  return `${repository}:${tag}`
}

// `docker image inspect <ref>` 가 성공하면 true. 시간 초과나 실행 실패는 확인하지 못한 것이라 true 로 둔다. 확인하지 못했는데 ID 로 바꾸면 태그가 여럿인 이미지가 -f 없이 거절된다
export function dockerRefResolves(ref: string): boolean {
  const done = runText(dockerArgv(['image', 'inspect', ref]), { timeoutSec: 60 })
  if (done.failure) return true
  return done.code === 0
}

const jsonLines = (text: string): Record<string, any>[] => pySplitLines(text).filter((l) => l).map((l) => loadJson(l) as Record<string, any>)

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const recentHours = args.options['recent-hours'] === undefined ? 24 : parsePyFloat(args.options['recent-hours'] as string)
  const context = (args.options.context as string | undefined) ?? null
  useContext(context)
  let containers: Record<string, any>[]
  let images: Record<string, any>[]
  let inspect: Record<string, any>[]
  try {
    containers = jsonLines(docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}'], 60))
    images = jsonLines(docker(['images', '--no-trunc', '--format', '{{json .}}'], 60))
    const ids = splitWhitespace(docker(['ps', '-aq', '--no-trunc'], 60))
    inspect = ids.length ? (loadJson(docker(['inspect', ...ids], 60)) as Record<string, any>[]) : []
  } catch (error) {
    write(2, `docker 를 쓸 수 없다: ${(error as Error).message}\n`)
    return 1
  }
  if (context) write(1, `## context: ${context}\n`)
  const usedRefs = new Set(containers.map((c) => normalizeImage(c.Image)))
  const usedIds = new Set<string | undefined>(inspect.map((c) => c.Image))
  const now = pyTime()
  for (const img of images) {
    const ref = img.Repository === '<none>' ? '<none>' : `${img.Repository}:${img.Tag}`
    const inspected = (loadJson(docker(['inspect', img.ID], 60)) as Record<string, any>[])[0]
    const createdText = Array.from(inspected.Created ?? '').slice(0, 19).join('')
    const createdTs = createdText ? mktimeLocal(createdText) : 0
    const cls = classifyImage({ ref, id: inspected.Id, created_ts: createdTs }, usedRefs, usedIds, now, recentHours)
    const resolves = img.Repository === '<none>' || img.Tag === '<none>' || dockerRefResolves(ref)
    const target = rmiTarget(img.Repository, img.Tag, img.ID, resolves)
    write(1, `${ljust(cls, 22)} ${rjust(img.Size, 9)}  ${ref}  (${img.CreatedSince})  rmi=${target} id=${shortId(img.ID)}\n`)
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
