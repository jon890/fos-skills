// 지시서에 `보드 항목 id:` 가 없을 때 붙일 보드 항목을 고른다. 띄우기 전 검사(spec-lint 의 `보드`)와 띄우기(lib/board.ts 의 registerBoard)가 같이 쓴다.
// 규칙의 원본은 docs/features/board-feature-items/design.md 「띄울 때 항목 찾기」 다. 파일과 프로세스를 읽지 않는다.
//
// decide, done 항목은 보지 않는다. 지시서가 기능 폴더를 가리키면 다른 기능 폴더가 적힌 항목은 어느 단계에서도 후보가 아니다.
// 아래 순서로 보고 앞 단계에서 찾으면 멈춘다.
//   1. 같은 워크트리의 worker 줄이 있는 항목
//   2. 같은 워크트리나 브랜치의 항목(항목의 worktree, branch 칸과 worker 줄의 브랜치)
//   3. 같은 task-ref 의 항목, 그다음 task-ref 가 빈 항목 가운데 제목에 업무 번호가 든 항목
//   4. 같은 기능 폴더의 항목
// 1, 2 단계에서 둘 이상이면 가장 최근 stepAt 을 고른다. 3, 4 단계에서 둘 이상이면 고르지 않고 many 다(같은 업무·기능의 열린 항목이 둘이면 잘못 만든 것이다).
// explicit(지시서의 `보드 항목 id:`)가 있으면 순서를 보지 않는다. 그 항목이 다른 기능 폴더를 따라가면 conflict, 보드에 없으면 none 이다(새로 만든다).

import type { BoardItem } from './board-details.ts'
import { detailText } from './board-details.ts'
import { boardWorkerRows } from './board-workers.ts'
import { featureStageOfLine, featureStageText, type FeatureStage } from './feature-stages.ts'

export type FeatureRef = { path: string; repo: string }
export type BoardQuery = { worktree: string; branch: string; ref: string | null; taskNumber: string | null; feature: FeatureRef | null; explicit?: string }
export type BoardFind = { item: BoardItem } | { none: true } | { many: string[] } | { conflict: string }

// 제목에 업무 번호가 든 항목인지. 번호 뒤에 숫자가 이어지면(`/282` 와 `/2821`) 다른 업무다
export function hasTask(title: unknown, number: string): boolean {
  if (typeof title !== 'string') return false
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_/-])${escaped}(?!\\p{N})`, 'u').test(title)
}

// 기능 폴더가 같다는 것은 경로와 저장소가 모두 같다는 뜻이다. 저장소 칸이 빈 옛 항목은 경로만 본다
export function sameFeature(item: Record<string, unknown>, feature: FeatureRef): boolean {
  return item.feature === feature.path && (!item['feature-repo'] || item['feature-repo'] === feature.repo)
}

// 항목이 지시서와 다른 기능 폴더를 따라가는가. 항목의 칸이 비었거나 지시서가 폴더를 모르면 아니다
export function otherFeature(item: Record<string, unknown>, feature: FeatureRef | null): boolean {
  return !!feature && typeof item.feature === 'string' && item.feature !== '' && !sameFeature(item, feature)
}

function latest(rows: BoardItem[]): BoardItem | undefined {
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => String(a.row.stepAt ?? '').localeCompare(String(b.row.stepAt ?? '')) || a.index - b.index).at(-1)?.row
}

export function findBoardItem(items: BoardItem[], q: BoardQuery): BoardFind {
  if (q.explicit) {
    const given = items.find((item) => item.id === q.explicit)
    if (!given) return { none: true }
    return otherFeature(given, q.feature) ? { conflict: given.id } : { item: given }
  }
  const open = items.filter((item) => typeof item.id === 'string' && !['done', 'decide'].includes(String(item.status)) && !otherFeature(item, q.feature))
  const one = (rows: BoardItem[]): BoardFind | null => (rows.length === 1 ? { item: rows[0] } : rows.length > 1 ? { many: rows.map((row) => row.id) } : null)
  const recent = (rows: BoardItem[]): BoardFind | null => {
    const row = latest(rows)
    return row ? { item: row } : null
  }
  const ownRow = q.worktree ? recent(open.filter((item) => boardWorkerRows(item).some((row) => row.worktree === q.worktree))) : null
  if (ownRow) return ownRow
  const byPlace = recent(open.filter((item) => (q.worktree && item.worktree === q.worktree) ||
    (q.branch && (item.branch === q.branch || boardWorkerRows(item).some((row) => row.branch === q.branch)))))
  if (byPlace) return byPlace
  if (q.ref) {
    const byRef = one(open.filter((item) => item['task-ref'] === q.ref))
    if (byRef) return byRef
  }
  if (q.taskNumber) {
    const byTitle = one(open.filter((item) => !item['task-ref'] && hasTask(item.title, q.taskNumber!)))
    if (byTitle) return byTitle
  }
  if (q.feature) {
    const byFeature = one(open.filter((item) => sameFeature(item, q.feature!)))
    if (byFeature) return byFeature
  }
  return { none: true }
}

type StageLine = { stage: FeatureStage; ask: boolean; done: boolean }

function stageLines(item: Record<string, unknown>): StageLine[] {
  const found: StageLine[] = []
  for (const [key, value] of [['details', item.details], ['next', item.next]] as const) {
    const rows = Array.isArray(value) ? value : value ? String(value).split('\n') : []
    for (const row of rows) {
      const raw = detailText(row)
      const text = raw.replace(/^\s*(?:✓|\[[xX ]\]|▶|◇)\s*/, '')
      const stage = featureStageOfLine(text)
      if (!stage) continue
      const done = key === 'details' && (typeof row === 'string' ? /^\s*(?:✓|\[[xX]\])/.test(row) : row?.done === true)
      found.push({ stage, ask: /^\s*\d+[.)]?\s+\[ask\]\s/.test(text), done })
    }
  }
  return found
}

// 지시서의 첫 기능 단계가 보드 항목과 맞는지. 맞으면 null, 아니면 spec-lint 의 `보드` 발견 문구(지시서 이름과 줄 번호 뒤)다.
// item 이 없으면(지시서 id 의 항목이 아직 없다) 단계 줄이 없는 항목과 같이 본다.
//   - 끝나지 않은 `[ask] 기능 <X>` 줄이 있으면 X 하나만 받는다. implementation 은 차수까지 같아야 한다.
//     단 `[ask] 기능 implementation 1/1` 은 구현 PR 수를 모를 때의 자리 줄이라 implementation 1/n 을 받는다
//   - `[ask]` 없이 끝나지 않은 기능 단계 줄이 있으면 그 단계를 다시 띄우는 것으로 보고 그 단계만 받는다
//   - 기능 단계 줄이 모두 끝났으면 막는다
//   - 기능 단계 줄이 없으면 새 스펙(`스펙: 새로 쓴다`)은 spec, 확인된 스펙은 technical-design, 설계가 있으면 implementation 1/n 도 받는다
export function startStageProblem(item: BoardItem | undefined, first: FeatureStage, opts: { id: string; newSpec: boolean; hasDesign: boolean }): string | null {
  const want = featureStageText(first)
  const lines = item ? stageLines(item) : []
  const open = lines.filter((line) => !line.done)
  const asked = open.filter((line) => line.ask)
  const allowed = asked.length > 0 ? asked : open
  if (allowed.length > 0) {
    const texts = [...new Set(allowed.map((line) => featureStageText(line.stage)))]
    // 설계 PR 머지 뒤의 `[ask] 기능 implementation 1/1` 은 구현 PR 수를 모를 때의 자리 줄이라 1/n 지시서도 받는다(work-board 의 worker-add 와 같다)
    const placeholder = first.name === 'implementation' && first.part === 1 &&
      asked.some((line) => line.stage.name === 'implementation' && line.stage.part === 1 && line.stage.total === 1)
    return texts.includes(want) || placeholder ? null : `항목 ${opts.id} 의 다음 단계는 ${texts.join(', ')} 인데 지시서는 ${want} 부터 시작한다`
  }
  if (lines.length > 0) return `항목 ${opts.id} 의 기능 단계 줄이 모두 끝났고 다음 단계 줄이 없다. 단계 줄을 정리하거나 \`보드 항목 id:\` 로 다른 항목을 고른다`
  if (opts.newSpec) return first.name === 'spec' ? null : `항목 ${opts.id} 의 다음 단계는 spec 인데 지시서는 ${want} 부터 시작한다`
  if (first.name === 'technical-design' || (opts.hasDesign && first.name === 'implementation' && first.part === 1)) return null
  return `항목 ${opts.id} 의 다음 단계는 ${opts.hasDesign ? 'technical-design, implementation 1/n' : 'technical-design'} 인데 지시서는 ${want} 부터 시작한다`
}
