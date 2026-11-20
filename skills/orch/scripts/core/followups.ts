// 배포 뒤 할 일 목록의 값을 정한다. 파일 읽기와 쓰기, 보드 반영, 알림은 lib/followups.ts 가 맡는다.
//
// 항목 하나는 기능 PR 하나의 「후속 검증: 대기 | <글>」 이다. 마무리(queue/finish-pr.ts)가 PR 정리를 끝낸 뒤 이 목록으로 옮기고,
// 상주 루프(loop/steps/followups.ts)가 배포를 확인하면 코디네이터에게 한 번 묶어 알리고, 코디네이터가 `orch followup done <PR>` 로 끝낸다.
//
// 항목 칸:
//     pr            PR 번호
//     title         PR 제목. 알림과 보드 제목에 쓴다
//     text          후속 검증 줄의 `대기 |` 뒤 글
//     merge_commit  머지 커밋. 루프가 배포를 다시 확인할 때 쓴다
//     deploy        success(배포 성공), none(배포 설정 없음, 머지 즉시 확인한 것으로 본다), failure, timeout
//     added_at      목록에 옮긴 시각
//     notified_at   코디네이터에게 알린 시각. 알린 항목은 다시 알리지 않는다
//     done_at       코디네이터가 끝낸 시각
//     note          끝낼 때 남긴 한 줄
//     finish_args   처음 마무리에 준 옵션(queue/finish-pr.ts 의 replayArgs). `orch followup done` 이 그 보드에 쓰고 마무리를 다시 띄울 때 그대로 준다.
//                   옛 항목에는 없어 빈 목록으로 읽는다
//
// 끝난 항목은 DONE_KEEP_DAYS(30일) 동안 남긴다. 그 안에 마무리를 다시 돌려도 후속 검증을 끝난 것으로 본다.

export type FollowupDeploy = 'success' | 'none' | 'failure' | 'timeout'
export const FOLLOWUP_DEPLOYS: readonly FollowupDeploy[] = ['success', 'none', 'failure', 'timeout']
export const DONE_KEEP_DAYS = 30

export type Followup = {
  pr: number
  title: string
  text: string
  merge_commit: string
  deploy: FollowupDeploy
  added_at: string
  notified_at: string | null
  done_at: string | null
  note: string | null
  finish_args: string[]
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const optional = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

// 파일의 값을 항목 목록으로 읽는다. 형식이 틀린 항목은 버린다
export function parseFollowups(data: unknown): Followup[] {
  const items = data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : []
  return items.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const row = raw as Record<string, unknown>
    const pr = Number(row.pr)
    if (!Number.isInteger(pr) || pr < 1 || !str(row.text)) return []
    const deploy = FOLLOWUP_DEPLOYS.includes(row.deploy as FollowupDeploy) ? row.deploy as FollowupDeploy : 'timeout'
    return [{
      pr, title: str(row.title), text: str(row.text), merge_commit: str(row.merge_commit), deploy,
      added_at: str(row.added_at), notified_at: optional(row.notified_at), done_at: optional(row.done_at), note: optional(row.note),
      finish_args: Array.isArray(row.finish_args) ? row.finish_args.filter((arg): arg is string => typeof arg === 'string') : [],
    }]
  })
}

export type Upsert = { items: Followup[]; result: 'added' | 'updated' | 'done' }

// 마무리가 옮긴 항목을 더한다. 같은 PR 이 이미 끝났으면 그대로 두고 done 이다.
// 끝나지 않은 같은 PR 은 글과 배포 결과만 새로 쓰고 알림 기록은 지킨다. 같은 PR 의 마무리를 다시 돌려도 알림이 되풀이되지 않는다
export type Entry = Omit<Followup, 'added_at' | 'notified_at' | 'done_at' | 'note' | 'finish_args'> & { finish_args?: string[] }

export function upsertFollowup(items: Followup[], entry: Entry, at: string): Upsert {
  const found = items.find((item) => item.pr === entry.pr)
  if (found?.done_at) return { items, result: 'done' }
  if (found) {
    return { items: items.map((item) => (item.pr === entry.pr ? { ...item, ...entry, finish_args: entry.finish_args ?? item.finish_args, deploy: deployedValue(item.deploy) ? item.deploy : entry.deploy } : item)), result: 'updated' }
  }
  return { items: [...items, { ...entry, finish_args: entry.finish_args ?? [], added_at: at, notified_at: null, done_at: null, note: null }], result: 'added' }
}

// 배포를 확인한 값인가. 배포 설정이 없으면(none) 머지 즉시 확인한 것으로 본다
export function deployedValue(deploy: FollowupDeploy): boolean {
  return deploy === 'success' || deploy === 'none'
}

export function openFollowups(items: Followup[]): Followup[] {
  return items.filter((item) => !item.done_at)
}

// 배포를 확인했고 아직 알리지 않은 항목
export function dueFollowups(items: Followup[]): Followup[] {
  return openFollowups(items).filter((item) => deployedValue(item.deploy) && !item.notified_at)
}

// 배포를 아직 확인하지 못한 항목. 루프가 배포 설정이 있을 때 다시 확인한다
export function undeployedFollowups(items: Followup[]): Followup[] {
  return openFollowups(items).filter((item) => !deployedValue(item.deploy))
}

export function markDeployed(items: Followup[], prs: number[]): Followup[] {
  return items.map((item) => (prs.includes(item.pr) ? { ...item, deploy: 'success' as const } : item))
}

export function markNotified(items: Followup[], prs: number[], at: string): Followup[] {
  return items.map((item) => (prs.includes(item.pr) && !item.notified_at ? { ...item, notified_at: at } : item))
}

export type Done = { items: Followup[]; result: 'done' | 'already' | 'missing' }

export function markDone(items: Followup[], pr: number, at: string, note: string | null): Done {
  const found = items.find((item) => item.pr === pr)
  if (!found) return { items, result: 'missing' }
  if (found.done_at) return { items, result: 'already' }
  return { items: items.map((item) => (item.pr === pr ? { ...item, done_at: at, note } : item)), result: 'done' }
}

// 끝난 지 DONE_KEEP_DAYS 가 지난 항목을 뺀다. now 는 밀리초다
export function pruneFollowups(items: Followup[], now: number): Followup[] {
  const limit = DONE_KEEP_DAYS * 24 * 60 * 60 * 1000
  return items.filter((item) => !item.done_at || !(now - Date.parse(item.done_at) > limit))
}

const flat = (text: string, max = 120): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

// 루프가 코디네이터에게 한 번 보내는 묶은 알림. 항목마다 한 줄이다
export function noticeText(items: Followup[]): string {
  const lines = items.map((item) => `- #${item.pr} ${flat(item.title, 60)}: ${flat(item.text)}`)
  return [`배포 뒤 할 일 ${items.length}건이 배포까지 끝났다. 확인한 뒤 PR 마다 orch followup done <PR> 로 끝내면 업무 완료와 보드 done 이 이어서 돈다.`, ...lines].join('\n')
}

// orch status 와 orch followup list 의 한 줄
export function followupLine(item: Followup): string {
  const state = item.done_at ? '끝남' : !deployedValue(item.deploy) ? `배포 확인 전(${item.deploy})` : item.notified_at ? '알림 보냄' : '배포 확인'
  return `FOLLOWUP #${item.pr} ${state} ${flat(item.text)}`
}

export const boardItemId = (pr: number): string => `followup-${pr}`
export const boardTitle = (item: Followup): string => flat(`배포 뒤 확인 #${item.pr} ${item.title}`, 80)
