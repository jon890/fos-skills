#!/usr/bin/env node
// 승인받은 홈서버 정리 후보를 지운다. 홈서버에서 돈다. 기본은 dry-run 이고 --apply 일 때만 지운다.
//
// 사용법(이 맥에서, 잠금이 필요한 것은 --lock 으로 돌린다):
//   remote.ts --host HOST --lock LOCK hs_delete.ts images [--apply] REF...
//   remote.ts --host HOST --lock LOCK --input CONFIG hs_delete.ts backup --config CONFIG [--apply] LABEL...
//   remote.ts --host HOST --lock LOCK --input GIT hs_delete.ts worktrees --survey GIT [--apply] PATH...
//   remote.ts --host HOST hs_delete.ts trash [--apply] NAME...
//   remote.ts --host HOST --input CONFIG hs_delete.ts hermes --config CONFIG [--apply] PROFILE:SESSION...
//
// images   태그나 이미지 ID 를 하나씩 `docker image rm` 한다. 지우기 직전에 컨테이너가 쓰는지 다시 보고, 쓰면 남긴다.
//          다른 이름이 가리켜 docker 가 거절한 것은 남김으로 센다. `docker image prune -a`, `docker system prune -a` 는 쓰지 않는다.
// backup   백업 루트 바로 아래 용도 폴더를 지운다. 이름은 [A-Za-z0-9][A-Za-z0-9._-]* 만 받고 심볼릭 링크는 지우지 않는다.
// worktrees  hs_classify.ts --git-out 파일에서 제거 후보인 워크트리만 지운다. 지우기 직전에 끝 커밋, 미커밋 변경,
//          이 사용자 uid 의 프로세스 cwd 를 다시 본다. 확인하지 못한 프로세스가 있으면 지우지 않는다. --force 는 쓰지 않는다.
// trash    ~/.local/share/Trash 의 files/NAME 과 info/NAME.trashinfo 를 함께 지운다.
// hermes   고른 세션 트리의 루트를 CONFIG 의 hermes.delete 명령으로 지운다. 보내기 직전에 세션 DB 와 assistant 연결 목록을
//          다시 읽어, 트리 안에 연결된 세션이나 30일 안에 활동한 세션이 생겼거나 다시 읽기가 실패하면 건너뛴다.
//          지운 뒤 연결된 세션이 세션 DB 에 모두 남았는지 확인해 낸다.
// images, backup, worktrees 의 --apply 는 운영 작업 잠금 아래(remote.ts --lock 이 주는 FOS_INFRA_LOCK_HELD=1)에서만 돈다.
// sudo 가 필요한 정리는 이 스크립트가 하지 않는다.
//
// 종료 코드: 0 실패 없음, 1 실패나 없음이 하나라도 있음, 2 사용법 오류, 4 잠금 없이 --apply 를 받음(아무것도 지우지 않음).

import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { gitRun, isMain, runText, write } from './io.ts'
import { HERMES_DAYS, hermesCandidates } from './hs_classify.ts'
import { expandHome, hermesDbs, procCwds, readHermesDb, readLinked } from './hs_survey.ts'

type Json = Record<string, any>

export const LOCK_REQUIRED = 4
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KEPT = ['referenced in multiple repositories', 'image is being used by', 'is using its referenced image']
const REMOVABLE = new Set(['제거 후보', '제거 후보(PR 머지됨)', '기록만 남음'])

export const keptReason = (stderr: string): string | null => KEPT.find((k) => stderr.includes(k)) ?? null

const lockHeld = (): boolean => process.env.FOS_INFRA_LOCK_HELD === '1'

const run = (argv: string[], timeoutSec = 120) => runText(argv, { timeoutSec, closeStdin: true })

function images(refs: string[], apply: boolean): number {
  const ids = run(['docker', 'ps', '-aq', '--no-trunc']).stdout.split(/\s+/).filter(Boolean)
  const used = new Set(ids.length ? run(['docker', 'inspect', '--format', '{{.Image}}', ...ids]).stdout.split(/\s+/).filter(Boolean) : [])
  let removed = 0
  let kept = 0
  let failed = 0
  let missing = 0
  for (const ref of refs) {
    const found = run(['docker', 'image', 'inspect', '--format', '{{.Id}} {{join .RepoTags " "}}', ref])
    if (found.code !== 0) {
      write(2, `없음 ${ref}: ${found.stderr.trim()}\n`)
      missing += 1
      continue
    }
    const [image, ...tags] = found.stdout.trim().split(/\s+/)
    const others = tags.filter((t) => t !== ref)
    if (used.has(image)) {
      write(1, `남김 ${ref}: 컨테이너가 쓰는 중\n`)
      kept += 1
      continue
    }
    if (!apply) {
      if (others.length && (ref.startsWith('sha256:') || image.includes(ref)) && tags.length > 1) {
        write(1, `남김 ${ref}: 다른 이름이 가리킴 ${others.join(' ')}\n`)
        kept += 1
      } else if (others.length && ref.includes(':') && !ref.startsWith('sha256:')) write(1, `태그만 뗌 ${ref}: 이미지는 ${others.join(' ')} 로 남음\n`)
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

function backup(cfg: Json, labels: string[], apply: boolean): number {
  const root = expandHome(cfg.backup.root).replace(/\/+$/, '')
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
    if (!apply) {
      write(1, `지울 것 ${dir}\n`)
      continue
    }
    try {
      rmSync(dir, { recursive: true })
      write(1, `지움 ${dir}\n`)
    } catch (error) {
      write(2, `실패 ${dir}: ${(error as Error).message}\n`)
      bad += 1
    }
  }
  return bad ? 1 : 0
}

function worktrees(survey: Json[], paths: string[], apply: boolean): number {
  const { cwds, unreadable } = procCwds(process.getuid?.() ?? -1)
  let bad = 0
  for (const path of paths) {
    const repo = survey.find((r) => (r.worktrees ?? []).some((w: Json) => w.path === path))
    const wt = repo?.worktrees.find((w: Json) => w.path === path)
    if (!repo || !wt || !REMOVABLE.has(wt.class)) {
      write(2, `거부 ${path}: 조사 파일의 제거 후보가 아니다\n`)
      bad += 1
      continue
    }
    if (wt.class === '기록만 남음') {
      if (apply) {
        const done = gitRun(repo.repo, ['worktree', 'prune'])
        write(done.code === 0 ? 1 : 2, `${done.code === 0 ? '정리' : '실패'} ${path}: worktree prune ${done.stderr.trim()}\n`)
        if (done.code !== 0) bad += 1
      } else write(1, `정리할 것 ${path}: 기록만 남음(worktree prune)\n`)
      continue
    }
    const tip = gitRun(path, ['rev-parse', 'HEAD']).stdout.trim()
    const dirty = gitRun(path, ['status', '--porcelain']).stdout.split('\n').filter(Boolean).length
    const busy = [...cwds].some((c) => c === path || c.startsWith(`${path}/`))
    const reason = unreadable ? `사용 여부를 확인하지 못함(프로세스 ${unreadable}개의 cwd 를 읽지 못함)` : busy ? '안에서 도는 프로세스가 있다' : tip !== wt.tip ? '끝 커밋이 조사 때와 다르다' : dirty ? `미커밋 변경 ${dirty}개` : null
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
function hermesSnapshot(cfg: Json): Json {
  const data = expandHome(cfg.hermes.data)
  const profiles = hermesDbs(data).map(({ profile, db }) => {
    try {
      return { profile, sessions: readHermesDb(db).map((s) => [s.id, s.parent, s.source, s.activity]) }
    } catch (error) {
      return { profile, error: (error as Error).message }
    }
  })
  const linked = readLinked(cfg.hermes.linked)
  return { profiles, ...('ids' in linked ? { linked: linked.ids } : { linked_error: linked.error }) }
}

function hermes(cfg: Json, picks: string[], apply: boolean): number {
  const before = hermesSnapshot(cfg)
  const now = Date.now() / 1000
  const judged = hermesCandidates(before, now, HERMES_DAYS)
  if ('error' in judged) {
    write(2, `다시 읽기 실패로 아무것도 지우지 않는다: ${judged.error}\n`)
    return 1
  }
  for (const p of before.profiles) if (p.error) write(2, `${p.profile}: 세션 DB 를 읽지 못했다: ${p.error}\n`)
  const ok = new Set(judged.candidates.map((c) => `${c.profile}:${c.root}`))
  let bad = 0
  let removed = 0
  for (const pick of picks) {
    const colon = pick.indexOf(':')
    if (colon <= 0) {
      write(2, `거부 ${pick}: PROFILE:SESSION 꼴이 아니다\n`)
      bad += 1
      continue
    }
    if (!ok.has(pick)) {
      write(1, `건너뜀 ${pick}: 지금은 후보가 아니다(조사 뒤 연결됐거나 ${HERMES_DAYS}일 안에 활동했거나 이미 없음)\n`)
      continue
    }
    if (!apply) {
      write(1, `지울 것 ${pick}\n`)
      continue
    }
    const [profile, session] = [pick.slice(0, colon), pick.slice(colon + 1)]
    const argv = cfg.hermes.delete.map((a: string) => (a === '{profile}' ? profile : a === '{session}' ? session : a))
    const done = run(argv)
    if (done.code === 0) {
      write(1, `지움 ${pick}\n`)
      removed += 1
    } else {
      write(2, `실패 ${pick}: ${(done.stderr.trim() || done.message).slice(0, 200)}\n`)
      bad += 1
    }
  }
  if (apply && removed) {
    // assistant 대화가 가리키는 세션이 그대로 남았는지 본다
    const linkedBefore = new Set<string>(before.linked)
    const existed = new Set<string>(before.profiles.flatMap((p: Json) => (p.sessions ?? []).map((s: any[]) => s[0])))
    const after = hermesSnapshot(cfg)
    const present = new Set<string>(after.profiles.flatMap((p: Json) => (p.sessions ?? []).map((s: any[]) => s[0])))
    const lost = [...linkedBefore].filter((id) => existed.has(id) && !present.has(id))
    if (lost.length) {
      write(2, `연결된 세션이 사라짐 ${lost.length}개: ${lost.join(', ')}\n`)
      bad += 1
    } else write(1, `연결된 세션 ${[...linkedBefore].filter((id) => existed.has(id)).length}개가 모두 남음\n`)
  }
  return bad ? 1 : 0
}

export function main(argv: string[]): number {
  const [sub, ...rest] = argv
  let parsed
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { apply: { type: 'boolean' }, config: { type: 'string' }, survey: { type: 'string' } } })
  } catch (error) {
    write(2, `${(error as Error).message}\n`)
    return 2
  }
  const { values, positionals } = parsed
  const apply = Boolean(values.apply)
  if (!['images', 'backup', 'worktrees', 'trash', 'hermes'].includes(sub ?? '') || positionals.length === 0) {
    write(2, 'usage: hs_delete.ts {images|backup|worktrees|trash|hermes} [--config FILE] [--survey FILE] [--apply] ITEM...\n')
    return 2
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
  return sub === 'backup' ? backup(cfg, positionals, apply) : hermes(cfg, positionals, apply)
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
