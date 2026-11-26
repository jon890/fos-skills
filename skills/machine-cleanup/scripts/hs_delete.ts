#!/usr/bin/env node
// 승인받은 홈서버 정리 후보를 지운다. 홈서버에서 돈다. 기본은 dry-run 이고 --apply 일 때만 지운다.
//
// 사용법(이 맥에서, 잠금이 필요한 것은 --lock 으로 돌린다):
//   remote.ts --host HOST --lock LOCK hs_delete.ts images [--apply] TAG=IMAGE_ID...
//   remote.ts --host HOST --lock LOCK --input CONFIG hs_delete.ts backup --config CONFIG [--keep N] [--apply] LABEL...
//   remote.ts --host HOST --lock LOCK --input GIT hs_delete.ts worktrees --survey GIT [--apply] PATH...
//   remote.ts --host HOST hs_delete.ts trash [--apply] NAME...
//   remote.ts --host HOST --input CONFIG hs_delete.ts hermes --config CONFIG [--apply] PROFILE:SESSION...
//
// images   `태그=이미지ID`(태그가 없으면 이미지 ID 자체)를 하나씩 `docker image rm` 한다. 항목마다 지우기 직전에 태그가 조사 때의
//          이미지 ID 를 그대로 가리키는지, 컨테이너가 쓰는지 다시 본다. 다르거나 컨테이너 조회가 실패하면 건너뛴다.
//          다른 이름이 가리켜 docker 가 거절한 것은 남김으로 센다. `docker image prune -a`, `docker system prune -a` 는 쓰지 않는다.
// backup   백업 루트 바로 아래 용도 폴더를 지운다. 이름은 [A-Za-z0-9][A-Za-z0-9._-]* 만 받고 심볼릭 링크는 지우지 않는다.
//          --keep N 이면 폴더 안에서 수정 시각이 새로운 N 개를 남기고 나머지 항목만 지운다. 지우기 전에 보관 규칙 표를 다시 읽어
//          자동 정리가 소유한 용도는 거부하고, 「명시적 정리」 용도는 --keep 이 없거나 규칙의 개수보다 적으면 거부한다.
//          표를 읽지 못하면 --keep 없이 폴더째 지우지 않는다.
// worktrees  hs_classify.ts --git-out 파일에서 제거 후보인 워크트리만 지운다. 항목마다 지우기 직전에 끝 커밋, 미커밋 변경,
//          이 사용자 uid 의 프로세스 cwd 를 다시 본다. 읽지 못하거나 확인하지 못한 프로세스가 있으면 지우지 않는다. --force 는 쓰지 않는다.
//          기록만 남은 워크트리는 그 저장소의 남은 기록이 모두 승인 목록에 있을 때만 `git worktree prune` 한다.
// trash    ~/.local/share/Trash 의 files/NAME 과 info/NAME.trashinfo 를 함께 지운다.
// hermes   고른 세션 트리의 루트를 CONFIG 의 hermes.delete 명령으로 지운다. 루트마다 보내기 직전에 세션 DB 와 assistant 연결 목록을
//          다시 읽는다. 트리 안에 연결된 세션이나 30일 안에 활동한 세션이 생겼으면 그 루트를 건너뛰고,
//          다시 읽기가 실패하면 그 루트와 남은 루트를 모두 지우지 않는다.
//          지운 뒤 연결된 세션이 세션 DB 에 모두 남았는지 확인해 낸다.
//          세션을 지운 profile 마다 세션 DB 파일 크기(-wal 포함)를 낸다. 지워도 파일은 줄지 않는다. 공간 회수(optimize)는
//          Hermes 를 멈춰야 해서 이 스크립트가 하지 않고 사용자 몫으로 보고한다.
// images, backup, worktrees 의 --apply 는 운영 작업 잠금 아래(remote.ts --lock 이 주는 FOS_INFRA_LOCK_HELD=1)에서만 돈다.
// sudo 가 필요한 정리는 이 스크립트가 하지 않는다.
//
// --apply 는 hs_classify.ts --clearance-out 파일을 --clearance 로 받아야 돈다. 그 파일에 실행 차단 범주가 하나라도 있으면
// 어떤 하위 명령도 지우지 않는다(스펙 REQ12: 홈서버 조사가 실패하면 홈서버는 아무것도 지우지 않는다).
//
// 종료 코드: 0 실패 없음, 1 실패나 없음이 하나라도 있음, 2 사용법 오류, 4 잠금 없이 --apply 를 받음, 5 실행 차단(둘 다 아무것도 지우지 않음).

import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { gitRun, isMain, runText, write } from './io.ts'
import { backupGrade, HERMES_DAYS, hermesCandidates, keptCount } from './hs_classify.ts'
import { type BackupRule, backupRules, expandHome, hermesDbs, procCwds, readHermesDb, readLinked, readText, ruleFor } from './hs_survey.ts'
import { parseWorktrees } from './lib/git_survey.ts'

type Json = Record<string, any>

export const LOCK_REQUIRED = 4
export const BLOCKED = 5

// hs_classify.ts --clearance-out 파일을 본다. 없거나, 못 읽거나, 실행 차단 범주가 있으면 그 이유를 돌려준다
export function clearanceProblem(path: string | undefined): string | null {
  if (!path) return '--clearance 가 없다(hs_classify.ts --clearance-out 파일을 넘긴다)'
  let data: Json
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return `--clearance 를 읽지 못했다: ${(error as Error).message}`
  }
  if (!Array.isArray(data.blocked)) return '--clearance 형식이 아니다'
  if (data.blocked.length) return `필수 조사가 실패했다(${data.blocked.map((b: Json) => b.category).join(', ')})`
  return null
}
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KEPT = ['referenced in multiple repositories', 'image is being used by', 'is using its referenced image']
const REMOVABLE = new Set(['제거 후보', '제거 후보(PR 머지됨)', '기록만 남음'])

export const keptReason = (stderr: string): string | null => KEPT.find((k) => stderr.includes(k)) ?? null

const lockHeld = (): boolean => process.env.FOS_INFRA_LOCK_HELD === '1'

const run = (argv: string[], timeoutSec = 120) => runText(argv, { timeoutSec, closeStdin: true })

// 지금 컨테이너가 쓰는 이미지 ID. docker ps 나 inspect 가 실패하면 null 이다(빈 목록으로 다루지 않는다)
export function usedImages(): Set<string> | null {
  const ps = run(['docker', 'ps', '-aq', '--no-trunc'])
  if (ps.failure || ps.code !== 0) return null
  const ids = ps.stdout.split(/\s+/).filter(Boolean)
  if (!ids.length) return new Set()
  const inspect = run(['docker', 'inspect', '--format', '{{.Image}}', ...ids])
  if (inspect.failure || inspect.code !== 0) return null
  return new Set(inspect.stdout.split(/\s+/).filter(Boolean))
}

// 승인 항목 `태그=이미지ID` 나 `sha256:...`(ID 자체)를 [넘길 이름, 기대하는 ID] 로 나눈다. 꼴이 아니면 null
export const FULL_ID = /^sha256:[0-9a-f]{64}$/

export function parseImageItem(item: string): [string, string] | null {
  if (FULL_ID.test(item)) return [item, item]
  const eq = item.lastIndexOf('=')
  if (eq <= 0) return null
  const ref = item.slice(0, eq)
  const id = item.slice(eq + 1)
  return FULL_ID.test(id) ? [ref, id] : null
}

function images(items: string[], apply: boolean): number {
  let removed = 0
  let kept = 0
  let failed = 0
  let missing = 0
  for (const item of items) {
    const parsed = parseImageItem(item)
    if (!parsed) {
      write(2, `거부 ${item}: 「태그=이미지ID」 나 이미지 ID(sha256: 뒤 64자리) 꼴이 아니다. 조사 때의 이미지 ID 를 함께 넘긴다\n`)
      failed += 1
      continue
    }
    const [ref, expected] = parsed
    // 항목마다 지우기 직전에 다시 본다. 앞 항목을 지우는 동안 작업이 컨테이너를 띄웠을 수 있다
    const used = usedImages()
    if (used === null) {
      write(1, `건너뜀 ${ref}: 컨테이너가 쓰는 이미지를 읽지 못함\n`)
      kept += 1
      continue
    }
    const found = run(['docker', 'image', 'inspect', '--format', '{{.Id}} {{join .RepoTags " "}}', ref])
    if (found.code !== 0) {
      write(2, `없음 ${ref}: ${found.stderr.trim()}\n`)
      missing += 1
      continue
    }
    const [image, ...tags] = found.stdout.trim().split(/\s+/)
    if (!FULL_ID.test(image ?? '')) {
      write(1, `건너뜀 ${ref}: 지금 이미지 ID 를 읽지 못함\n`)
      kept += 1
      continue
    }
    if (image !== expected) {
      write(1, `건너뜀 ${ref}: 조사 뒤 다른 이미지를 가리킨다(조사 ${expected.slice(7, 19)}, 지금 ${image.slice(7, 19)})\n`)
      kept += 1
      continue
    }
    const others = tags.filter((t) => t !== ref)
    if (used.has(image)) {
      write(1, `남김 ${ref}: 컨테이너가 쓰는 중\n`)
      kept += 1
      continue
    }
    if (!apply) {
      if (others.length && ref.startsWith('sha256:') && tags.length > 1) {
        write(1, `남김 ${ref}: 다른 이름이 가리킴 ${others.join(' ')}\n`)
        kept += 1
      } else if (others.length && !ref.startsWith('sha256:')) write(1, `태그만 뗌 ${ref}: 이미지는 ${others.join(' ')} 로 남음\n`)
      else write(1, `지울 것 ${ref}\n`)
      continue
    }
    const done = run(['docker', 'image', 'rm', ref])
    if (done.code === 0) {
      write(1, `지움 ${ref}\n`)
      removed += 1
    } else if (keptReason(done.stderr)) {
      write(1, `남김 ${ref}: 다른 이름이 가리킴 ${others.join(' ')}\n`)
      kept += 1
    } else {
      write(2, `실패 ${ref}: ${done.stderr.trim()}\n`)
      failed += 1
    }
  }
  write(1, `지움 ${removed}개, 남김 ${kept}개, 실패 ${failed}개, 없음 ${missing}개${apply ? '' : ' (dry-run)'}\n`)
  return failed || missing ? 1 : 0
}

// 승인한 용도를 보관 규칙과 맞춰 본다. 지울 수 없으면 거부 이유, 지울 수 있으면 남길 개수(null 이면 폴더째)
export function backupPlan(rule: BackupRule | null, rulesRead: boolean, keep: number | null): { keep: number | null } | { refuse: string } {
  if (!rulesRead) {
    // 표를 못 읽으면 조사도 모든 용도를 「표에 없음」 으로 냈다. 개수를 지키는 용도일 수 있어 폴더째 지우지 않는다
    return keep === null ? { refuse: '보관 규칙 표를 읽지 못해 폴더째 지우지 않는다. 남길 개수를 --keep N 으로 넘긴다' } : { keep }
  }
  if (rule === null) return { keep }
  const grade = backupGrade(rule.keep)
  if (grade.grade === '유지') return { refuse: `자동 정리가 소유한다(${rule.keep})` }
  const n = keptCount(rule.keep)
  if (n !== null && /별 최신/.test(rule.keep) && !rule.key.includes('{')) {
    return { refuse: `한 폴더에 여러 대상이 섞여 개수로 지우지 않는다(${rule.keep})` }
  }
  if (rule.keep.includes('명시적 정리')) {
    if (keep === null) return { refuse: `보관 규칙이 남길 개수를 정한다(${rule.keep}). --keep ${n ?? 'N'} 으로 넘긴다` }
    if (n !== null && keep < n) return { refuse: `--keep ${keep} 이 보관 규칙의 ${n}개보다 적다(${rule.keep})` }
  }
  return { keep }
}

function backup(cfg: Json, labels: string[], apply: boolean, keep: number | null): number {
  const root = expandHome(cfg.backup.root).replace(/\/+$/, '')
  // 지우기 직전에 보관 규칙 표를 다시 읽는다. 승인 묶음의 문구와 달리 폴더째 지우는 일을 막는다
  const doc = cfg.checkout && cfg.backup.rules ? readText(`${expandHome(cfg.checkout)}/${cfg.backup.rules}`) : null
  const rules = doc === null ? [] : backupRules(doc, cfg.backup.section)
  const rulesRead = rules.length > 0
  let bad = 0
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      write(2, `거부 ${label}: 용도 이름 꼴이 아니다\n`)
      bad += 1
      continue
    }
    const dir = `${root}/${label}`
    let st
    try {
      st = lstatSync(dir)
    } catch {
      write(2, `없음 ${label}\n`)
      bad += 1
      continue
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      write(2, `거부 ${label}: 폴더가 아니다\n`)
      bad += 1
      continue
    }
    const plan = backupPlan(ruleFor(label, rules), rulesRead, keep)
    if ('refuse' in plan) {
      write(2, `거부 ${label}: ${plan.refuse}\n`)
      bad += 1
      continue
    }
    const targets = plan.keep === null ? [dir] : oldEntries(dir, plan.keep)
    if (targets === null) {
      write(2, `실패 ${label}: 항목을 읽지 못했다\n`)
      bad += 1
      continue
    }
    if (plan.keep !== null) write(1, `남김 ${label}: 최신 ${plan.keep}개, 지울 것 ${targets.length}개\n`)
    for (const target of targets) {
      if (!apply) {
        write(1, `지울 것 ${target}\n`)
        continue
      }
      try {
        rmSync(target, { recursive: true })
        write(1, `지움 ${target}\n`)
      } catch (error) {
        write(2, `실패 ${target}: ${(error as Error).message}\n`)
        bad += 1
      }
    }
  }
  return bad ? 1 : 0
}

// 폴더 안 항목을 수정 시각이 새로운 순서로 세워 앞 keep 개를 뺀 나머지 경로를 오래된 것부터 낸다. 시각이 같으면 이름이 뒤인 것을 새것으로 본다
export function oldEntries(dir: string, keep: number): string[] | null {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const dated: [string, number][] = []
  for (const name of names) {
    try {
      dated.push([name, lstatSync(`${dir}/${name}`).mtimeMs])
    } catch {
      // 시각을 모르는 항목은 오래된 쪽으로 세지 않고 남긴다
      return null
    }
  }
  dated.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
  return dated.slice(keep).reverse().map(([name]) => `${dir}/${name}`)
}

// 저장소의 지금 「기록만 남음」 워크트리 경로. 목록을 읽지 못하면 null
function prunablePaths(repo: string): Set<string> | null {
  const done = gitRun(repo, ['worktree', 'list', '--porcelain'])
  if (done.code !== 0) return null
  return new Set(parseWorktrees(done.stdout).filter((w) => w.prunable).map((w) => w.path))
}

function worktrees(survey: Json[], paths: string[], apply: boolean): number {
  let bad = 0
  const approved = new Set(paths)
  const pruned = new Set<string>()
  for (const path of paths) {
    const repo = survey.find((r) => (r.worktrees ?? []).some((w: Json) => w.path === path))
    const wt = repo?.worktrees.find((w: Json) => w.path === path)
    if (!repo || !wt || !REMOVABLE.has(wt.class)) {
      write(2, `거부 ${path}: 조사 파일의 제거 후보가 아니다\n`)
      bad += 1
      continue
    }
    if (wt.class === '기록만 남음') {
      // git worktree prune 은 저장소 전체의 기록을 지운다. 지금 남은 기록이 모두 승인한 경로일 때만 돌린다
      if (pruned.has(repo.repo)) {
        write(1, `정리 ${path}: 같은 저장소의 prune 에 포함됨\n`)
        continue
      }
      const current = prunablePaths(repo.repo)
      if (current === null) {
        write(1, `건너뜀 ${path}: 워크트리 목록을 읽지 못함\n`)
        continue
      }
      if (!current.has(path)) {
        write(1, `건너뜀 ${path}: 지금은 기록만 남은 워크트리가 아니다\n`)
        continue
      }
      const extra = [...current].filter((p) => !approved.has(p))
      if (extra.length) {
        write(1, `건너뜀 ${path}: prune 하면 승인하지 않은 기록 ${extra.length}개(${extra.join(', ')})도 함께 지워진다\n`)
        continue
      }
      if (!apply) {
        write(1, `정리할 것 ${path}: 기록만 남음(worktree prune)\n`)
        continue
      }
      const done = gitRun(repo.repo, ['worktree', 'prune'])
      write(done.code === 0 ? 1 : 2, `${done.code === 0 ? '정리' : '실패'} ${path}: worktree prune ${done.stderr.trim()}\n`)
      if (done.code === 0) pruned.add(repo.repo)
      else bad += 1
      continue
    }
    // 항목마다 지우기 직전에 다시 본다. 앞 워크트리를 지우는 동안 이 경로에서 프로세스가 시작됐을 수 있다
    const head = gitRun(path, ['rev-parse', 'HEAD'])
    const status = gitRun(path, ['status', '--porcelain'])
    // git 조회가 끝난 뒤 프로세스를 본다. 지우기 직전 마지막 확인이 프로세스가 되어 git 조회 중 시작한 작업도 잡는다
    const { cwds, unreadable } = procCwds(process.getuid?.() ?? -1)
    const dirty = status.stdout.split('\n').filter(Boolean).length
    const busy = [...cwds].some((c) => c === path || c.startsWith(`${path}/`))
    const reason = unreadable
      ? `사용 여부를 확인하지 못함(프로세스 ${unreadable}개를 읽지 못함)`
      : busy ? '안에서 도는 프로세스가 있다'
      : head.code !== 0 || status.code !== 0 ? '끝 커밋이나 변경 상태를 읽지 못함'
      : head.stdout.trim() !== wt.tip ? '끝 커밋이 조사 때와 다르다'
      : dirty ? `미커밋 변경 ${dirty}개` : null
    if (reason) {
      write(1, `남김 ${path}: ${reason}\n`)
      continue
    }
    if (!apply) {
      write(1, `지울 것 ${path}\n`)
      continue
    }
    const done = gitRun(repo.repo, ['worktree', 'remove', path], { timeoutSec: 120 })
    if (done.code === 0) write(1, `지움 ${path}\n`)
    else {
      write(2, `실패 ${path}: ${done.stderr.trim()}\n`)
      bad += 1
    }
  }
  return bad ? 1 : 0
}

function trash(names: string[], apply: boolean): number {
  const base = expandHome('~/.local/share/Trash')
  let bad = 0
  for (const name of names) {
    if (name.includes('/') || name === '.' || name === '..' || !name) {
      write(2, `거부 ${name}: 이름 꼴이 아니다\n`)
      bad += 1
      continue
    }
    const files = `${base}/files/${name}`
    const info = `${base}/info/${name}.trashinfo`
    try {
      lstatSync(info)
    } catch {
      write(2, `없음 ${name}\n`)
      bad += 1
      continue
    }
    if (!apply) {
      write(1, `지울 것 ${name}\n`)
      continue
    }
    rmSync(files, { recursive: true, force: true })
    rmSync(info, { force: true })
    write(1, `지움 ${name}\n`)
  }
  return bad ? 1 : 0
}

// 세션 DB 와 연결 목록을 다시 읽어 조사 JSON 의 hermes 절과 같은 꼴로 만든다
// 연결 목록을 먼저 읽고 세션 DB 를 그 뒤에 읽는다. 삭제 직전 마지막 확인이 세션 활동이 되어, 연결 조회 동안 활동한 세션을 놓치지 않는다
function hermesSnapshot(cfg: Json): Json {
  const linked = readLinked(cfg.hermes.linked)
  const data = expandHome(cfg.hermes.data)
  const profiles = hermesDbs(data).map(({ profile, db }) => {
    try {
      return { profile, sessions: readHermesDb(db).map((s) => [s.id, s.parent, s.source, s.activity]) }
    } catch (error) {
      return { profile, error: (error as Error).message }
    }
  })
  return { profiles, ...('ids' in linked ? { linked: linked.ids } : { linked_error: linked.error }) }
}

const sessionIds = (snap: Json): string[] => (snap.profiles ?? []).flatMap((p: Json) => (p.sessions ?? []).map((x: any[]) => x[0]))

function hermes(cfg: Json, picks: string[], apply: boolean): number {
  const now = () => Date.now() / 1000
  let bad = 0
  let removed = 0
  const touched = new Set<string>()
  const linkedSeen = new Set<string>()
  const existed = new Set<string>()
  for (const [i, pick] of picks.entries()) {
    const colon = pick.indexOf(':')
    if (colon <= 0) {
      write(2, `거부 ${pick}: PROFILE:SESSION 꼴이 아니다\n`)
      bad += 1
      continue
    }
    const [profile, session] = [pick.slice(0, colon), pick.slice(colon + 1)]
    // 세션마다 보내기 직전에 세션 DB 와 연결 목록을 다시 읽는다. 앞 세션을 지우는 동안 연결되거나 활동했을 수 있다
    const snap = hermesSnapshot(cfg)
    const judged = hermesCandidates(snap, now(), HERMES_DAYS)
    const profileError = (snap.profiles ?? []).find((p: Json) => p.profile === profile)?.error
    if ('error' in judged || profileError) {
      write(2, `다시 읽기 실패로 남은 ${picks.length - i}개를 지우지 않는다: ${'error' in judged ? judged.error : profileError}\n`)
      bad += 1
      break
    }
    for (const id of snap.linked ?? []) linkedSeen.add(id)
    for (const id of sessionIds(snap)) existed.add(id)
    if (!judged.candidates.some((c) => c.profile === profile && c.root === session)) {
      write(1, `건너뜀 ${pick}: 지금은 후보가 아니다(조사 뒤 연결됐거나 ${HERMES_DAYS}일 안에 활동했거나 이미 없음)\n`)
      continue
    }
    if (!apply) {
      write(1, `지울 것 ${pick}\n`)
      continue
    }
    const argv = cfg.hermes.delete.map((a: string) => (a === '{profile}' ? profile : a === '{session}' ? session : a))
    const done = run(argv)
    if (done.code === 0) {
      write(1, `지움 ${pick}\n`)
      removed += 1
      touched.add(profile)
    } else {
      write(2, `실패 ${pick}: ${(done.stderr.trim() || done.message).slice(0, 200)}\n`)
      bad += 1
    }
  }
  if (apply && removed) {
    // assistant 대화가 가리키는 세션이 그대로 남았는지 본다. 마지막으로 읽은 연결 목록까지 합친다
    const after = hermesSnapshot(cfg)
    if (after.linked_error || (after.profiles ?? []).some((p: Json) => p.error)) {
      write(2, `지운 뒤 확인하지 못함: ${after.linked_error ?? 'Hermes 세션 DB 를 읽지 못함'}\n`)
      bad += 1
    } else {
      for (const id of after.linked ?? []) linkedSeen.add(id)
      const present = new Set(sessionIds(after))
      const kept = [...linkedSeen].filter((id) => existed.has(id))
      const lost = kept.filter((id) => !present.has(id))
      if (lost.length) {
        write(2, `연결된 세션이 사라짐 ${lost.length}개: ${lost.join(', ')}\n`)
        bad += 1
      } else write(1, `연결된 세션 ${kept.length}개가 모두 남음\n`)
    }
    const dbs = new Map(hermesDbs(expandHome(cfg.hermes.data)).map((d) => [d.profile, d.db]))
    for (const profile of touched) {
      const db = dbs.get(profile)
      if (db) write(1, `세션 DB 크기 ${profile}: ${mb(dbBytes(db))}. 공간 회수는 Hermes 를 멈춘 점검 시간에 사용자가 한다\n`)
    }
  }
  return bad ? 1 : 0
}

const dbBytes = (db: string): number => ['', '-wal'].reduce((n, ext) => {
  try {
    return n + lstatSync(`${db}${ext}`).size
  } catch {
    return n
  }
}, 0)

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}M`

export function main(argv: string[]): number {
  const [sub, ...rest] = argv
  let parsed
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { apply: { type: 'boolean' }, config: { type: 'string' }, survey: { type: 'string' }, clearance: { type: 'string' }, keep: { type: 'string' } } })
  } catch (error) {
    write(2, `${(error as Error).message}\n`)
    return 2
  }
  const { values, positionals } = parsed
  const apply = Boolean(values.apply)
  const keep = values.keep === undefined ? null : Number(values.keep)
  if (keep !== null && (sub !== 'backup' || !/^[1-9][0-9]*$/.test(values.keep!))) {
    write(2, '--keep 은 backup 에만 쓰고 1 이상의 정수다\n')
    return 2
  }
  if (!['images', 'backup', 'worktrees', 'trash', 'hermes'].includes(sub ?? '') || positionals.length === 0) {
    write(2, 'usage: hs_delete.ts {images|backup|worktrees|trash|hermes} [--config FILE] [--survey FILE] [--keep N] [--clearance FILE --apply] ITEM...\n')
    return 2
  }
  if (apply) {
    const blocked = clearanceProblem(values.clearance)
    if (blocked) {
      write(2, `실행 차단: ${blocked}. 홈서버는 아무것도 지우지 않는다\n`)
      return BLOCKED
    }
  }
  if (apply && ['images', 'backup', 'worktrees'].includes(sub) && !lockHeld()) {
    write(2, '운영 작업 잠금 없이 지우지 않는다. remote.ts --lock 으로 돌린다\n')
    return LOCK_REQUIRED
  }
  const readJson = (path: string | undefined, name: string): Json | null => {
    if (!path) {
      write(2, `${sub} 는 --${name} 이 필요하다\n`)
      return null
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      write(2, `--${name} 을 읽지 못했다: ${(error as Error).message}\n`)
      return null
    }
  }
  if (sub === 'images') return images(positionals, apply)
  if (sub === 'trash') return trash(positionals, apply)
  if (sub === 'worktrees') {
    const survey = readJson(values.survey, 'survey')
    return survey ? worktrees(survey as Json[], positionals, apply) : 2
  }
  const cfg = readJson(values.config, 'config')
  if (!cfg) return 2
  return sub === 'backup' ? backup(cfg, positionals, apply, keep) : hermes(cfg, positionals, apply)
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
