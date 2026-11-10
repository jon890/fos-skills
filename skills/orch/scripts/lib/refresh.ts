// 상주 루프의 「뒤처진 PR 최신화」 판정 한 벌이다. 루프(orch-loop.ts)가 읽기, 기록, 부르기를 하고 여기는 설정 읽기와 판정만 한다.
// 단계의 차례와 알림은 orch-loop.ts 머리 주석의 「최신화」 가 소유한다. 결정의 배경은 docs/adr/020-orch-loop-refresh.md 다.
//
// 설정(refreshSettings):
//   pipeline.refresh_slots         0 이상의 정수. 기본 0 이고 0 이면 단계가 돌지 않는다. 루프가 건 최신화 가운데
//                                  CI 가 아직 도는 것의 상한이다. CI runner 수보다 작게 둔다(worker 의 push 와 머지 큐도 runner 를 쓴다)
//   pipeline.refresh_worker_paths  정규식 문자열이나 그 목록(Python 정규식, 목록은 `|` 로 잇는다). PR 과 base 가 모두 바꾼 파일이
//                                  맞으면 update-branch 대신 worker 에게 합치기를 보낸다. 계약 버전처럼 글자 충돌은 없어도
//                                  worker 가 판단해야 하는 파일을 적는다
//   queue.require_up_to_date, queue.up_to_date_when, queue.shared_paths, queue.unit_prefix, queue.unit_groups, queue.docs_glob
//                                  머지 큐(merge-with-finish 가 넘기는 옵션)와 같은 값으로 판정한다. 차례가 온 PR 에 머지 큐가 할
//                                  update-branch 를 미리 하는 것이라 기준이 다르면 안 된다. require_up_to_date 가 false 면 머지 큐가
//                                  최신화하지 않으므로 이 단계도 돌지 않는다
//
// 판정(verdict): PR 하나의 파일 목록으로 정한다. git 조회는 부르는 쪽(forkFiles)이 한다.
//   최신(base 를 품는다)이면 skip. up_to_date_when 이 overlap 이면 lib/overlap.ts 의 judge 가 갱신 필요일 때만, always 면 뒤처지면 늘 최신화한다.
//   최신화할 PR 가운데 refresh_worker_paths 에 맞는 파일을 양쪽이 모두 바꿨으면 worker 다.
//
// 큐 뒤로 미루기(aheadInQueue): 도는 머지 큐에 아직 머지되지 않은 앞 PR 이 있고 그 PR 의 변경이 이 PR 과 겹치면 미룬다.
//   그 PR 이 머지되면 이 PR 은 다시 뒤처져 방금 돌린 CI 가 쓸모없어지기 때문이다. 큐에 든 PR 의 「앞」 은 큐 순서에서 앞선 PR 이고,
//   큐에 없는 PR 의 「앞」 은 큐의 남은 PR 전부다. always 면 겹침을 따지지 않고 앞 PR 이 하나라도 있으면 미룬다.

import { isRecord } from '../core/refresh.ts'
import type { ForkFiles, RefreshRecord } from '../core/refresh.ts'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.ts'
import { makeParent, pathOf } from './paths.ts'

export function forkFiles(repo: string, base: string, head: string): { ok: true; files: ForkFiles } | { ok: false; error: string } {
  const lines = (args: string[]): string[] | null => {
    const done = git(repo, args)
    return done.code === 0 ? done.stdout.split('\n').filter((line) => line) : null
  }
  const ancestor = git(repo, ['merge-base', '--is-ancestor', base, head])
  if (ancestor.code !== 0 && ancestor.code !== 1) return { ok: false, error: `git merge-base --is-ancestor ${base} ${head}: ${ancestor.stderr.trim() || `종료 코드 ${ancestor.code}`}` }
  const mb = lines(['merge-base', base, head])?.[0]
  if (!mb) return { ok: false, error: `git merge-base ${base} ${head} 가 커밋을 내지 않았다` }
  const pr = lines(['diff', '--name-only', '--no-renames', mb, head])
  const theirs = lines(['diff', '--name-only', '--no-renames', mb, base])
  if (pr === null || theirs === null) return { ok: false, error: `git diff ${mb.slice(0, 8)} 를 읽지 못했다` }
  return { ok: true, files: { behind: ancestor.code === 1, pr, base: theirs } }
}

export function refreshFile(repo: string): string {
  return join(pathOf('state', repo), 'refresh.json')
}

export function readRefresh(file: string): Record<string, RefreshRecord> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => /^\d+$/.test(key) && isRecord(value))) as Record<string, RefreshRecord>
}

export function writeRefresh(file: string, repo: string, records: Record<string, RefreshRecord>): void {
  makeParent(file, repo)
  const sorted = Object.fromEntries(Object.keys(records).sort((a, b) => Number(a) - Number(b)).map((key) => [key, records[key]]))
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

export { joined, refreshSettings, verdict, aheadInQueue, isRecord, LANDING_MS, IN_FLIGHT_MS, inFlight } from '../core/refresh.ts'
export type { RefreshSettings, ForkFiles, Verdict, RefreshRecord } from '../core/refresh.ts'
