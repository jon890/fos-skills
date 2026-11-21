#!/usr/bin/env node
// 홈서버 조사 JSON 에 등급과 원인 판정을 붙여 보고한다. 이 맥에서 돈다. 읽기 전용이다.
//
// 사용법:
//   hs_classify.ts SURVEY --config CONFIG [--json-out FILE] [--git-out FILE] [--orphans-out FILE] [--hermes-out FILE] [--images-out FILE]
//
// SURVEY 는 hs_survey.ts 의 출력, CONFIG 는 hs_overlay.ts 의 출력이다. 등급 규칙은 references/homeserver-targets.md 가 소유하고,
// 이 스크립트는 그 규칙대로 후보마다 등급(유지, 안전, 확인 필요)과 이유를 붙인다.
// 유지 등급은 승인 후보에 넣지 않는다. 유지인데 규칙보다 많이 남은 것은 매일 정리 시각과 비교해
// `정상(마지막 매일 정리 뒤에 생김)` 이나 `원인 확인 필요: <용도>` 를 붙인다.
// 보관 규칙 표에 없는 백업 용도는 「표에 올릴 용도」 로 따로 낸다. sudo 가 필요한 정리는 사용자 터미널용 명령 문자열만 낸다.
// 메모리 절은 제안만 낸다. 조사만 하는 저장소(survey_only)의 항목은 승인 후보에 넣지 않는다.
// Hermes 세션은 부모·자식 트리 단위로 보고, 트리 안에 assistant 에 연결된 세션이나 30일 안에 활동한 세션이 있으면 트리 전체를 뺀다.
// 연결 조회가 실패했으면 Hermes 후보를 하나도 내지 않는다. 후보는 출처(source)별 묶음으로 보이고, 사람이 다시 이어 쓰는
// 채팅 출처(discord)는 권장 묶음에서 뺀다. --hermes-out 은 `출처<탭>profile:세션` 줄을 써서 묶음별로 hs_delete.ts 에 넘기게 한다.
// --git-out 은 브랜치 삭제 입력(delete_branches.ts 가 읽는 survey_git 형식, 조사만 하는 저장소 제외),
// --orphans-out 은 워크트리가 사라진 대화 기록 삭제 입력(delete_sessions.ts 형식)을 쓴다. 둘 다 홈서버 경로를 담는다.
// --images-out 은 `등급<탭>태그=이미지ID` 줄(태그가 없으면 이미지 ID)을 쓴다. 승인한 줄을 hs_delete.ts images 에 그대로 넘겨
// 실행 때 태그가 조사 때의 이미지를 가리키는지 확인하게 한다.
//
// 필수 조사가 실패한 범주(Docker 접속, 백업 루트, git 저장소, 대화 기록, Hermes 세션과 연결 조회, 휴지통, 경로)는 「실행 차단」 절에 적고
// 종료 코드 3 으로 끝낸다. 그 범주는 승인 묶음에 올리지 않고 그 범주의 삭제를 돌리지 않는다. 나머지 범주의 보고는 그대로 낸다.
//
// 종료 코드: 0 완료, 2 입력 오류, 3 완료했으나 실행 차단된 범주가 있음.

import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { isMain, write } from './io.ts'

type Json = Record<string, any>

export const HERMES_DAYS = 30
// 사람이 채팅 스레드에서 다시 이어 쓸 수 있는 출처. 후보여도 권장 묶음에 넣지 않는다
export const CHAT_SOURCES = new Set(['discord'])
const DAY = 86400

export function human(size: number | null | undefined): string {
  if (size === null || size === undefined) return '-'
  let n = size
  for (const unit of ['B', 'K', 'M', 'G', 'T']) {
    if (n < 1024 || unit === 'T') return unit === 'B' ? `${n}B` : `${n.toFixed(1)}${unit}`
    n /= 1024
  }
  return '-'
}

const shq = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
export const sudoCommand = (host: string, command: string): string => `ssh -t ${host} ${shq(`sudo ${command}`)}`

// ---------- 백업 ----------

export type Grade = { grade: '유지' | '안전' | '확인 필요'; reason: string }

// 「백업」 표의 보관 칸을 등급으로 옮긴다. 규칙이 없으면 null
export function backupGrade(rule: string | null): Grade {
  if (rule === null) return { grade: '확인 필요', reason: '보관 규칙 표에 없다' }
  if (rule.includes('명시적 정리')) return { grade: '안전', reason: `만드는 스크립트의 정리 명령이 보관 개수를 지킨다(${rule})` }
  if (rule.includes('사람이')) return { grade: '확인 필요', reason: `사람이 정한다(${rule})` }
  if (/매일 정리|최신 \d+개|timer|타이머|보존 기간/.test(rule)) return { grade: '유지', reason: `자동 정리가 소유한다(${rule})` }
  return { grade: '확인 필요', reason: `보관 칸을 읽지 못했다(${rule})` }
}

// 유지 백업이 규칙보다 많이 남았는지 본다. 판정할 수 없거나 많지 않으면 null
export function backupOverRetention(row: Json, lastPrune: number): string | null {
  const rule: string | null = row.rule
  if (!rule) return null
  const m = /최신 (\d+)개/.exec(rule)
  if (!m) return null
  // `{서비스}` 자리 없이 「서비스별」 규칙이 붙은 용도는 한 폴더에 여러 서비스가 섞여 개수로 판정하지 않는다
  if (/별 최신/.test(rule) && !String(row.rule_key ?? '').includes('{')) return null
  const keep = Number(m[1])
  const entries: Json[] = row.entries ?? []
  if (entries.length <= keep) return null
  const beforePrune = entries.filter((e) => e.mtime !== null && e.mtime <= lastPrune).length
  return beforePrune <= keep ? '정상(마지막 매일 정리 뒤에 생김)' : `원인 확인 필요: ${row.label}`
}

// ---------- 이미지 ----------

const globRe = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`)

export function ownerOf(image: Json, owned: Json[]): Json | null {
  const names = [...(image.tags ?? []), ...(image.repos ?? [])]
  return owned.find((o) => names.some((n) => globRe(o.pattern).test(n))) ?? null
}

export function imageGrade(image: Json, owned: Json[]): Grade & { owner?: string } {
  const o = ownerOf(image, owned)
  if (o) return { grade: '유지', reason: `${o.owner} 가 소유한다`, owner: o.pattern }
  if (image.configured) return { grade: '유지', reason: '설정이 가리킴. 컨테이너가 없어도 작업이 생기면 바로 쓴다' }
  if (image.running_other_version) return { grade: '확인 필요', reason: '실행 중인 다른 버전이 있다. 레지스트리에서 다시 받을 수 있다' }
  return { grade: '확인 필요', reason: '쓰는 곳이 없어 보인다. 저장소에서 이름을 찾아 쓰는 곳이 없을 때만 지운다' }
}

const createdSec = (image: Json): number | null => {
  const t = Date.parse(image.created)
  return Number.isNaN(t) ? null : t / 1000
}

// 개수 규칙(keep)이 있는 소유 이미지가 규칙보다 많이 남았는지 본다
export function imageOverRetention(images: Json[], owned: Json[], lastPrune: number): { pattern: string; count: number; keep: number; verdict: string }[] {
  const out: { pattern: string; count: number; keep: number; verdict: string }[] = []
  for (const o of owned) {
    if (o.keep === undefined) continue
    const mine = images.filter((i) => ownerOf(i, [o]))
    if (mine.length <= o.keep) continue
    const before = mine.filter((i) => (createdSec(i) ?? 0) <= lastPrune).length
    out.push({ pattern: o.pattern, count: mine.length, keep: o.keep, verdict: before <= o.keep ? '정상(마지막 매일 정리 뒤에 생김)' : `원인 확인 필요: ${o.pattern}` })
  }
  return out
}

// ---------- 경로 ----------

const PATH_GRADES: Record<string, Grade & { command?: string; sudo?: boolean }> = {
  '~/.npm': { grade: '안전', reason: '다시 받으면 되는 사본이다', command: 'npm cache clean --force' },
  '~/.local/share/pnpm': { grade: '안전', reason: '다시 받으면 되는 사본이다', command: 'pnpm store prune' },
  '~/.local/share/Trash': { grade: '확인 필요', reason: '사람이나 다른 세션이 옮긴 파일이다. 휴지통 절에서 항목별로 고른다' },
  '~/.cache': { grade: '확인 필요', reason: '하위 폴더별로 고른다' },
  '/var/cache/apt': { grade: '안전', reason: '패키지 내려받기 사본이다', command: 'apt-get clean', sudo: true },
  '/tmp': { grade: '유지', reason: '시스템이 정리한다. 참고로만 보인다' },
  '/var/tmp': { grade: '유지', reason: '시스템이 정리한다. 참고로만 보인다' },
  '/var/log': { grade: '유지', reason: '로그 회전이 소유한다. journal 은 따로 본다' },
}

export function pathGrade(row: Json): Grade & { command?: string; sudo?: boolean } {
  if (row.owner) return { grade: '유지', reason: `${row.owner} 가 소유한다` }
  return PATH_GRADES[row.path] ?? { grade: '확인 필요', reason: '규칙이 없는 경로다' }
}

// ---------- Hermes ----------

export type HermesCandidate = { profile: string; root: string; source: string; activity: number; sessions: number }

// profile 마다 세션 트리를 만들고, 연결이나 최근 활동이 없는 트리의 루트만 후보로 낸다
export function hermesCandidates(hermes: Json, now: number, days = HERMES_DAYS): { candidates: HermesCandidate[] } | { error: string } {
  if (!hermes || hermes.error) return { error: hermes?.error ?? 'Hermes 조사 결과가 없다' }
  if (hermes.linked_error || !Array.isArray(hermes.linked)) return { error: hermes.linked_error ?? 'assistant 연결 세션 목록이 없다' }
  const linked = new Set<string>(hermes.linked)
  const cutoff = now - days * DAY
  const out: HermesCandidate[] = []
  for (const p of hermes.profiles ?? []) {
    if (p.error) continue
    const sessions: Json[] = p.sessions.map(([id, parent, source, activity]: any[]) => ({ id, parent, source, activity }))
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const rootOf = (s: Json): string => {
      const seen = new Set<string>()
      let cur = s
      while (cur.parent && byId.has(cur.parent) && !seen.has(cur.id)) {
        seen.add(cur.id)
        cur = byId.get(cur.parent)!
      }
      return cur.id
    }
    const trees = new Map<string, Json[]>()
    for (const s of sessions) trees.set(rootOf(s), [...(trees.get(rootOf(s)) ?? []), s])
    for (const [root, members] of trees) {
      if (members.some((m) => linked.has(m.id) || m.activity >= cutoff)) continue
      const r = byId.get(root)!
      out.push({ profile: p.profile, root, source: r.source, activity: Math.max(...members.map((m) => m.activity)), sessions: members.length })
    }
  }
  return { candidates: out.sort((a, b) => a.activity - b.activity) }
}

// 출처별 묶음. 권장 묶음(채팅 출처가 아닌 것)을 앞에 두고 개수가 많은 순서다
export function hermesBySource(candidates: HermesCandidate[]): [string, HermesCandidate[]][] {
  const groups = new Map<string, HermesCandidate[]>()
  for (const c of candidates) groups.set(c.source || '?', [...(groups.get(c.source || '?') ?? []), c])
  return [...groups].sort((a, b) => Number(CHAT_SOURCES.has(a[0])) - Number(CHAT_SOURCES.has(b[0])) || b[1].length - a[1].length)
}

// ---------- 메모리 ----------

export function memorySuggestions(memory: Json): string[] {
  const out: string[] = []
  if (!memory || memory.error) return out
  for (const c of memory.containers ?? []) {
    if (c.limit && c.usage && c.usage / c.limit >= 0.9) out.push(`${c.name}: 메모리 사용이 한도의 ${Math.round((c.usage / c.limit) * 100)}% 다. 한도 조정이나 원인 확인을 fos-home-infra 변경으로 검토한다`)
  }
  if (memory.mem_total && memory.mem_available !== null && memory.mem_available / memory.mem_total < 0.1) out.push('여유 메모리가 전체의 10% 아래다. 상위 컨테이너의 한도와 사용량을 fos-home-infra 에서 검토한다')
  if (memory.swap_used && memory.swap_used > 0 && (memory.swap_top ?? []).length) {
    const top = memory.swap_top.slice(0, 3).map((p: Json) => `${p.name}(${human(p.swap)})`).join(', ')
    out.push(`스왑 ${human(memory.swap_used)} 사용 중. 많이 쓰는 프로세스: ${top}. 재시작이나 한도 변경은 운영 서비스가 끊기므로 fos-home-infra 변경으로 정한다`)
  }
  return out
}

// 승인 목록에 쓸 [등급, 「태그=이미지ID」 또는 이미지 ID]. 유지 등급은 넣지 않는다
export function imageItems(images: Json[]): [string, string][] {
  return images.filter((i) => i.grade !== '유지').flatMap((i) => (i.tags?.length ? i.tags.map((t: string) => [i.grade, `${t}=${i.id}`]) : [[i.grade, i.id]]) as [string, string][])
}

// ---------- 실행 차단 ----------

const isErr = (x: any): string | null => (x && typeof x === 'object' && !Array.isArray(x) && x.error ? String(x.error) : null)

// 필수 조사가 실패해 삭제를 돌리면 안 되는 범주와 이유
export function blockedOf(survey: Json): { category: string; reason: string }[] {
  const out: { category: string; reason: string }[] = []
  const add = (category: string, reason: string | null) => {
    if (reason) out.push({ category, reason })
  }
  add('Docker 이미지', isErr(survey.docker) ?? (survey.docker ? null : '조사 결과가 없다'))
  add('백업', isErr(survey.backups) ?? (survey.backups ? null : '조사 결과가 없다'))
  add('휴지통', isErr(survey.trash))
  add('경로', isErr(survey.paths) ?? isErr(survey.cache_dirs))
  add('대화 기록', isErr(survey.sessions) ?? (survey.sessions ? null : '조사 결과가 없다'))
  const git = survey.git
  add('git 저장소', isErr(git) ?? (git ? null : '조사 결과가 없다'))
  for (const r of git?.repos ?? []) add(`git 저장소 ${r.path}`, r.error ?? null)
  const h = survey.hermes
  add('Hermes 세션', isErr(h) ?? (h ? h.linked_error ?? null : '조사 결과가 없다'))
  for (const p of h?.profiles ?? []) add(`Hermes 세션 ${p.profile}`, p.error ?? null)
  return out
}

// ---------- 보고 ----------

export function classify(survey: Json, cfg: Json): Json {
  const lastPrune = survey.last_daily_prune
  const docker = survey.docker ?? {}
  const images = (docker.unused_images ?? []).map((i: Json) => ({ ...i, ...imageGrade(i, cfg.owned_images) }))
  const backups = (survey.backups?.rows ?? []).map((r: Json) => ({ ...r, ...backupGrade(r.rule), over: null as string | null }))
  for (const b of backups) if (b.grade === '유지') b.over = backupOverRetention(b, lastPrune)
  const paths = (Array.isArray(survey.paths) ? survey.paths : []).map((p: Json) => ({ ...p, ...pathGrade(p) }))
  const sudo: string[] = []
  for (const p of paths) if (p.sudo && p.command) sudo.push(sudoCommand(cfg.host, p.command))
  if (survey.journal && typeof survey.journal === 'string') sudo.push(sudoCommand(cfg.host, 'journalctl --vacuum-size=1G'))
  for (const s of Array.isArray(survey.snaps) ? survey.snaps : []) sudo.push(sudoCommand(cfg.host, `snap remove ${s.name} --revision=${s.revision}`))
  const repos = (survey.git?.repos ?? []).map((r: Json) => {
    const patterns: RegExp[] = (r.build_worktrees ?? []).map((p: string) => globRe(p.startsWith('~/') ? `${survey.home}/${p.slice(2)}` : p))
    const build = (r.worktrees ?? []).filter((w: Json) => patterns.some((re) => re.test(w.path)))
    return { ...r, build_worktrees_found: build.map((w: Json) => w.path) }
  })
  const hermes = hermesCandidates(survey.hermes, survey.now)
  return {
    blocked: blockedOf(survey),
    images,
    image_over: imageOverRetention(docker.unused_images ?? [], cfg.owned_images, lastPrune),
    backups,
    to_table: backups.filter((b: Json) => b.rule === null).map((b: Json) => b.label),
    paths,
    sudo,
    repos,
    hermes,
    memory: memorySuggestions(survey.memory),
  }
}

export function report(survey: Json, cfg: Json, c: Json): string {
  const out: string[] = []
  const err = (x: any) => (x && typeof x === 'object' && !Array.isArray(x) && x.error ? x.error : null)
  const mem = survey.memory ?? {}
  if (c.blocked.length) {
    out.push('## 실행 차단 (필수 조사가 실패했다. 이 범주는 승인 묶음에 올리지 않고 지우지 않는다)')
    for (const b of c.blocked) out.push(`- ${b.category}: ${b.reason}`)
    out.push('')
  }
  out.push('## 정리 전 수치')
  out.push(`디스크 여유 ${human(survey.host?.disk_free)} / ${human(survey.host?.disk_total)}, 메모리 available ${human(mem.mem_available)} / ${human(mem.mem_total)}, 스왑 사용 ${human(mem.swap_used)} / ${human(mem.swap_total)}`)
  for (const row of survey.docker?.summary ?? []) out.push(`Docker ${row.Type}: ${row.Size} (회수 가능 ${row.Reclaimable})`)

  out.push('\n## 메모리와 스왑 (진단만)')
  if (err(mem)) out.push(`읽지 못함: ${err(mem)}`)
  else {
    out.push(`여유 메모리 ${human(mem.mem_available)}, 스왑 사용 ${human(mem.swap_used)}`)
    if (mem.containers_error) out.push(`컨테이너: ${mem.containers_error}`)
    out.push('| 컨테이너 | 사용 | 한도 | 메모리+스왑 한도 |')
    out.push('| --- | --- | --- | --- |')
    for (const ct of mem.containers ?? []) out.push(`| ${ct.name} | ${human(ct.usage)} | ${ct.limit ? human(ct.limit) : '없음'} | ${ct.swap_limit && ct.swap_limit > 0 ? human(ct.swap_limit) : '없음'} |`)
    out.push('스왑을 많이 쓰는 프로세스:')
    for (const p of mem.swap_top ?? []) out.push(`- ${p.pid} ${p.name}: ${human(p.swap)}`)
    if (!(mem.swap_top ?? []).length) out.push('- 없음')
  }
  out.push('제안(스킬은 재시작이나 한도 변경을 하지 않는다):')
  for (const s of c.memory) out.push(`- ${s}`)
  if (!c.memory.length) out.push('- 없음')

  out.push('\n## Docker 이미지 (컨테이너가 쓰지 않는 것. 크기는 공유 layer 를 겹쳐 센 값이다)')
  if (err(survey.docker)) out.push(`읽지 못함: ${err(survey.docker)}`)
  else {
    out.push(`dangling volume ${survey.docker.dangling_volumes ?? '읽지 못함'}${survey.docker.dangling_volumes === null ? '' : '개'}`)
    out.push('| 등급 | 이미지 | 이름 | 만든 날 | 크기 | 이유 |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const i of c.images) out.push(`| ${i.grade} | ${String(i.id).slice(7, 19)} | ${(i.tags.length ? i.tags : i.repos).join(', ') || '<none>'} | ${String(i.created).slice(0, 10)} | ${human(i.size)} | ${i.reason} |`)
    for (const o of c.image_over) out.push(`규칙보다 많음: ${o.pattern} ${o.count}개(규칙 ${o.keep}개) → ${o.verdict}`)
  }

  out.push(`\n## 백업 루트 ${survey.backups?.root ?? ''}`)
  if (err(survey.backups)) out.push(`읽지 못함: ${err(survey.backups)}`)
  else {
    if (!survey.backups.rules_found) out.push('보관 규칙 표를 읽지 못했다. 모든 용도가 「표에 없음」 으로 나온다. 오버레이의 backup.rules 와 section 을 확인한다')
    out.push('| 등급 | 용도 | 항목 | 크기 | 「백업」 표의 보관 | 판정 |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const b of c.backups) out.push(`| ${b.grade} | ${b.label} | ${b.entries.length} | ${human(b.size)}${b.complete ? '' : ' (일부)'} | ${b.rule ?? '표에 없음'} | ${b.over ?? ''} |`)
  }
  out.push('표에 올릴 용도(지울지와 함께 표에 올릴지 묻는다):')
  for (const t of c.to_table) out.push(`- ${t}`)
  if (!c.to_table.length) out.push('- 없음')

  out.push('\n## 경로')
  if (err(survey.paths)) out.push(`읽지 못함: ${err(survey.paths)}`)
  for (const p of c.paths) out.push(`- [${p.grade}${p.sudo ? ', sudo' : ''}] ${p.path}: ${human(p.size)}${p.complete ? '' : ' (권한 없는 곳 제외)'}. ${p.reason}${p.command && !p.sudo ? `. 명령: ${p.command}` : ''}`)
  out.push('\n## ~/.cache 하위 (확인 필요)')
  for (const d of Array.isArray(survey.cache_dirs) ? survey.cache_dirs.slice(0, 15) : []) out.push(`- ${d.name}: ${human(d.size)}`)
  out.push('\n## 휴지통 (확인 필요, 오늘 옮긴 것은 권하지 않는다)')
  const trash = Array.isArray(survey.trash) ? survey.trash : []
  for (const t of trash) out.push(`- ${t.name}: ${human(t.size)}, 옮긴 시각 ${t.moved || '모름'}`)
  if (!trash.length) out.push('- 없음')
  out.push(`\n## journal\n${typeof survey.journal === 'string' ? survey.journal : '읽지 못함'}`)
  out.push('\n## snap 이전 리비전')
  for (const s of Array.isArray(survey.snaps) ? survey.snaps : []) out.push(`- ${s.name} ${s.revision}: ${human(s.size)}`)
  out.push('\n## sudo 가 필요한 정리 (스킬이 돌리지 않는다. 사용자 터미널에서 돌린다)')
  for (const s of c.sudo) out.push(`- ${s}`)
  if (!c.sudo.length) out.push('- 없음')

  out.push('\n## git 저장소')
  if (err(survey.git)) out.push(`읽지 못함: ${err(survey.git)}`)
  else out.push(`워크트리 사용 확인: ${survey.git.cwd_check}`)
  for (const r of c.repos) {
    out.push(`### ${r.path}${r.survey_only ? ' (조사만. 승인 후보에 넣지 않는다)' : ''}${r.ops ? ' (운영 checkout. 지울 때 잠금을 잡는다)' : ''}`)
    if (r.error) {
      out.push(`읽지 못함: ${r.error}`)
      continue
    }
    out.push(`fetch: ${r.fetch}, 기준 ${r.base}`)
    for (const w of r.worktrees ?? []) out.push(`  [워크트리 ${w.class}] ${w.path}  브랜치=${w.branch} 변경=${w.dirty} 사용중=${w.in_use} 경과=${w.age_days}일${w.pr_state === 'error' ? ' gh확인실패' : ''}`)
    for (const b of r.branches ?? []) out.push(`  [브랜치 ${b.class}] ${b.name}${b.pr_state === 'error' ? ' gh확인실패' : ''}`)
    if (r.build_worktrees_found.length) out.push(`  원인 수정 제안: 빌드 스크립트가 남긴 워크트리 ${r.build_worktrees_found.length}개(${r.build_worktrees_found.join(', ')}). 만든 스크립트가 끝날 때 지우게 고친다`)
  }

  const s = survey.sessions ?? {}
  out.push('\n## Claude·Codex 대화 기록')
  if (err(s)) out.push(`읽지 못함: ${err(s)}`)
  else {
    const old = (s.agents ?? []).filter((a: Json) => a.old)
    out.push(`오래 떠 있는 에이전트 프로세스: ${old.length ? old.map((a: Json) => `${a.pid}(${a.hours}h, ${a.cwd})`).join(', ') : '없음'}`)
    if (!(s.logs ?? []).length) out.push(`대화 기록 (오래된 기준 ${s.log_age_days}일): 없음`)
    for (const l of s.logs ?? []) out.push(`${l.dir}: ${human(l.total)} 중 오래된 것 ${human(l.older_than_days)}`)
    const orphans = s.orphans?.orphans ?? []
    out.push(`워크트리가 사라진 대화 기록: ${orphans.length ? `${orphans.length}개 ${human(orphans.reduce((n: number, o: Json) => n + o.size_bytes, 0))}` : '없음'}`)
  }

  out.push(`\n## Hermes 세션 (${HERMES_DAYS}일 지났고 assistant 대화에 연결되지 않은 트리의 루트. 확인 필요)`)
  if ('error' in c.hermes) out.push(`후보를 내지 않음: ${c.hermes.error}`)
  else {
    for (const p of survey.hermes.profiles ?? []) if (p.error) out.push(`${p.profile}: ${p.error}`)
    for (const [source, items] of hermesBySource(c.hermes.candidates)) {
      const chat = CHAT_SOURCES.has(source)
      out.push(`### 출처 ${source}: 루트 ${items.length}개, 세션 ${items.reduce((n, h) => n + h.sessions, 0)}개${chat ? ' (사람이 다시 이어 쓸 수 있다. 권장 묶음에서 뺀다)' : ' (권장 묶음)'}`)
      for (const h of items.slice(0, 10)) out.push(`- ${h.profile}:${h.root}  마지막 활동=${new Date(h.activity * 1000).toISOString().slice(0, 10)} 세션 ${h.sessions}개`)
      if (items.length > 10) out.push(`- 외 ${items.length - 10}개(전체는 --hermes-out 파일)`)
    }
    if (!c.hermes.candidates.length) out.push('- 없음')
  }
  return out.join('\n')
}

export function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { config: { type: 'string' }, 'json-out': { type: 'string' }, 'git-out': { type: 'string' }, 'orphans-out': { type: 'string' }, 'hermes-out': { type: 'string' }, 'images-out': { type: 'string' } } })
  } catch (error) {
    write(2, `usage: hs_classify.ts SURVEY --config CONFIG [--json-out FILE] [--git-out FILE] [--orphans-out FILE] [--hermes-out FILE] [--images-out FILE]\n${(error as Error).message}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (positionals.length !== 1 || !values.config) {
    write(2, 'usage: hs_classify.ts SURVEY --config CONFIG [--json-out FILE] [--git-out FILE] [--orphans-out FILE] [--hermes-out FILE] [--images-out FILE]\n')
    return 2
  }
  let survey: Json
  let cfg: Json
  try {
    survey = JSON.parse(readFileSync(positionals[0], 'utf8'))
    cfg = JSON.parse(readFileSync(values.config, 'utf8'))
  } catch (error) {
    write(2, `입력을 읽지 못했다: ${(error as Error).message}\n`)
    return 2
  }
  const c = classify(survey, cfg)
  if (values['json-out']) writeFileSync(values['json-out'], `${JSON.stringify(c, null, 2)}\n`)
  if (values['git-out']) {
    const repos = c.repos.filter((r: Json) => !r.survey_only && !r.error).map((r: Json) => ({ repo: r.repo, base: r.base, gh_errors: r.gh_errors, worktrees: r.worktrees, branches: r.branches }))
    writeFileSync(values['git-out'], `${JSON.stringify(repos, null, 2)}\n`)
  }
  if (values['images-out']) writeFileSync(values['images-out'], imageItems(c.images).map(([g, item]) => `${g}\t${item}\n`).join(''))
  if (values['hermes-out']) writeFileSync(values['hermes-out'], 'candidates' in c.hermes ? c.hermes.candidates.map((h: HermesCandidate) => `${h.source}\t${h.profile}:${h.root}\n`).join('') : '')
  if (values['orphans-out'] && survey.sessions?.orphans) writeFileSync(values['orphans-out'], JSON.stringify(survey.sessions.orphans))
  write(1, `${report(survey, cfg, c)}\n`)
  return c.blocked.length ? 3 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
