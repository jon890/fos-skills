#!/usr/bin/env node
// fos-home-infra 오버레이를 찾아 읽고 형식을 검사한다. 이 맥에서 돈다. 읽기 전용이다.
//
// 사용법:
//   hs_overlay.ts [--overlay FILE] [--json-out FILE]
//
// --overlay 가 없으면 개인 오버레이(overlay_path.ts 와 같은 순서)에서 아래 꼴의 줄을 찾아 그 파일을 읽는다.
//   fos-home-infra 오버레이: <fos-home-infra 체크아웃>/.claude/machine-cleanup-overlay.md
// 파일 안의 첫 ```json 코드 블록이 값이다. 검사를 통과하면 그 JSON 을 표준 출력에 내고, --json-out 이 있으면 그 파일에도 쓴다.
// 이 출력이 hs_survey.ts, hs_classify.ts, hs_delete.ts 의 --config 입력이다. 스크립트는 홈서버 값을 기본값으로 갖지 않는다.
//
// 키(모두 필수, 표시한 것만 선택). 경로의 `~/` 는 홈서버 사용자의 홈이다.
//   host               ssh 접속 이름
//   lock               운영 작업 잠금 파일 경로
//   checkout           운영 checkout 경로
//   daily_prune        매일 정리 시각 "HH:MM"(홈서버 현지 시각)
//   backup.root        백업 루트
//   backup.rules       보관 규칙 표가 든 문서의 checkout 상대 경로
//   backup.section     그 문서에서 규칙 표가 든 `## ` 절 제목
//   owned_images[]     자동 정리가 소유한 이미지. { pattern: "이름:태그" glob(`*` 는 아무 글자), owner, keep?: 남기는 개수 }
//   owned_paths[]      자동 정리가 소유한 경로. { path, owner }
//   configured_images  설정이 가리키는 이미지를 찾을 자리(checkout 상대 glob 목록). { compose[], dockerfile[], settings[],
//                      content_tags[]: { name, files[], length } } 내용 해시로 태그를 정하는 이미지
//   repos[]            조사할 git 저장소. { path, survey_only?: true 면 조사만, build_worktrees?: 빌드 스크립트가 만드는 워크트리 경로 glob[] }
//   hermes             { container, data: 호스트의 Hermes 데이터 폴더, delete: 세션 삭제 argv, linked: assistant 연결 세션 조회 argv }
//                      delete 의 "{profile}", "{session}" 낱말은 그 값으로 바뀐다. linked 는 세션 id 를 줄마다 낸다(탭이나 공백으로 여럿 가능).
//                      argv 는 셸을 거치지 않는다. 자격 증명 값은 두지 않고, 컨테이너 안 환경 변수를 쓰는 꼴로 적는다.
//
// 종료 코드: 0 통과, 1 오버레이를 찾지 못함(개인 오버레이나 그 줄, 가리킨 파일이 없음), 2 사용법 오류, 3 형식 오류.

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { isMain, write } from './io.ts'
import { findOverlay } from './overlay_path.ts'

export const POINTER = 'fos-home-infra 오버레이:'

type Json = Record<string, any>

export class OverlayError extends Error {}

// 개인 오버레이 본문에서 fos-home-infra 오버레이 경로를 찾는다. `~/` 는 이 맥의 홈으로 푼다
export function pointerPath(text: string, home: string): string | null {
  for (const line of text.split('\n')) {
    const at = line.indexOf(POINTER)
    if (at < 0) continue
    const value = line.slice(at + POINTER.length).trim().replace(/^`|`$/g, '')
    if (!value) continue
    return value.startsWith('~/') ? `${home}/${value.slice(2)}` : value
  }
  return null
}

// 첫 ```json 블록을 읽는다
export function jsonBlock(text: string): unknown {
  const m = /^```json[ \t]*\n([\s\S]*?)^```/m.exec(text)
  if (!m) throw new OverlayError('```json 코드 블록이 없다')
  try {
    return JSON.parse(m[1])
  } catch (error) {
    throw new OverlayError(`JSON 을 읽지 못했다: ${(error as Error).message}`)
  }
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

// 값을 검사한다. 틀린 곳을 모두 모아 던진다
export function validate(value: unknown): Json {
  const errors: string[] = []
  const need = (ok: boolean, key: string, what: string) => {
    if (!ok) errors.push(`${key}: ${what}`)
  }
  if (!isObj(value)) throw new OverlayError('최상위가 객체가 아니다')
  for (const key of ['host', 'lock', 'checkout']) need(isStr(value[key]), key, '비지 않은 문자열이어야 한다')
  need(isStr(value.daily_prune) && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.daily_prune), 'daily_prune', '"HH:MM" 이어야 한다')
  const backup = value.backup
  need(isObj(backup) && isStr(backup.root) && isStr(backup.rules) && isStr(backup.section), 'backup', 'root, rules, section 문자열이 있어야 한다')
  need(Array.isArray(value.owned_images) && value.owned_images.every((i: unknown) => isObj(i) && isStr(i.pattern) && isStr(i.owner) && (i.keep === undefined || (Number.isInteger(i.keep) && i.keep >= 0))), 'owned_images', '{ pattern, owner, keep? } 목록이어야 한다')
  need(Array.isArray(value.owned_paths) && value.owned_paths.every((i: unknown) => isObj(i) && isStr(i.path) && isStr(i.owner)), 'owned_paths', '{ path, owner } 목록이어야 한다')
  const ci = value.configured_images
  need(
    isObj(ci) && isStrList(ci.compose) && isStrList(ci.dockerfile) && isStrList(ci.settings) &&
      Array.isArray(ci.content_tags) && ci.content_tags.every((t: unknown) => isObj(t) && isStr(t.name) && isStrList(t.files) && Number.isInteger(t.length) && t.length > 0),
    'configured_images', 'compose, dockerfile, settings 목록과 content_tags[{ name, files, length }] 가 있어야 한다',
  )
  need(
    Array.isArray(value.repos) && value.repos.length > 0 &&
      value.repos.every((r: unknown) => isObj(r) && isStr(r.path) && (r.survey_only === undefined || typeof r.survey_only === 'boolean') && (r.build_worktrees === undefined || isStrList(r.build_worktrees))),
    'repos', '{ path, survey_only?, build_worktrees? } 가 하나 이상 있어야 한다',
  )
  const h = value.hermes
  need(isObj(h) && isStr(h.container) && isStr(h.data) && isStrList(h.delete) && h.delete.length > 0 && isStrList(h.linked) && h.linked.length > 0, 'hermes', 'container, data 문자열과 delete, linked argv 목록이 있어야 한다')
  if (isObj(h) && isStrList(h.delete)) need(h.delete.includes('{session}'), 'hermes.delete', '"{session}" 낱말이 있어야 한다')
  if (errors.length) throw new OverlayError(errors.join('\n'))
  return value
}

export type Located = { path: string } | { missing: string } | { error: string }

// --overlay 가 없을 때 개인 오버레이를 따라가 fos-home-infra 오버레이 경로를 찾는다
export function locate(home: string): Located {
  const found = findOverlay(home)
  if (!found) return { missing: '개인 오버레이가 없다(~/.claude/overlays/machine-cleanup.md)' }
  if ('error' in found) return { error: `개인 오버레이 자리를 확인하지 못했다: ${found.path} (${found.error})` }
  const path = pointerPath(readFileSync(found.path, 'utf8'), home)
  if (!path) return { missing: `개인 오버레이 ${found.path} 에 「${POINTER} <경로>」 줄이 없다` }
  return { path }
}

export function main(argv: string[]): number {
  let values
  try {
    values = parseArgs({ args: argv, options: { overlay: { type: 'string' }, 'json-out': { type: 'string' }, help: { type: 'boolean', short: 'h' } } }).values
  } catch (error) {
    write(2, `usage: hs_overlay.ts [--overlay FILE] [--json-out FILE]\n${(error as Error).message}\n`)
    return 2
  }
  if (values.help) {
    write(1, 'usage: hs_overlay.ts [--overlay FILE] [--json-out FILE]\nfos-home-infra 오버레이를 찾아 읽고 형식을 검사한다.\n')
    return 0
  }
  const home = process.env.HOME || homedir()
  let path = values.overlay
  if (!path) {
    const where = locate(home)
    if ('missing' in where) {
      write(2, `홈서버 오버레이를 찾지 못함: ${where.missing}. 홈서버는 조사도 정리도 하지 않는다\n`)
      return 1
    }
    if ('error' in where) {
      write(2, `${where.error}. 홈서버는 조사도 정리도 하지 않는다\n`)
      return 3
    }
    path = where.path
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    write(2, `홈서버 오버레이를 찾지 못함: ${path} (${(error as NodeJS.ErrnoException).code ?? error}). 홈서버는 조사도 정리도 하지 않는다\n`)
    return 1
  }
  let config: Json
  try {
    config = validate(jsonBlock(text))
  } catch (error) {
    if (!(error instanceof OverlayError)) throw error
    write(2, `홈서버 오버레이 형식 오류: ${path}\n${error.message}\n홈서버는 조사도 정리도 하지 않는다\n`)
    return 3
  }
  const out = `${JSON.stringify(config, null, 2)}\n`
  if (values['json-out']) writeFileSync(values['json-out'], out)
  write(1, out)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
