// worker 를 띄우기 전에 --agent, --model, --effort 가 그 에이전트에 있는 값인지 본다.
// 없는 모델로 띄우면 worker 가 오류로 멈춘 채 WORKER-STALLED 로만 드러나, 워크트리와 Task 가 헛되이 생긴다.
//
// 정본:
//     codex   `codex debug models` 의 JSON. 읽기와 캐시는 lib/model-generation.ts 의 readCodexModels 가 소유한다. CODEX_BIN 으로 실행 파일을 바꾼다
//     claude  모델 목록을 내는 명령이 없다(`claude --help` 의 명령 목록에 없다). 추측한 목록을 두지 않고 검사를 건너뛴다
//
// 결과:
//     reject   없는 모델이나 그 모델이 지원하지 않는 effort. message 에 쓸 수 있는 값과 한도 표의 같은 등급 대응을 함께 담는다
//     warnings 검사를 하지 못한 사정(조회 명령 실패, 출력 해석 실패, claude). 띄우기는 막지 않는다. 검사 불능과 잘못된 값은 다르다
//
// 검사하지 않는 경우: --agent 가 없으면 어느 쪽 모델인지 알 수 없다. --model 이 없으면 effort 가 어느 모델에 속하는지 몰라 effort 도 보지 않는다.

import { readCodexModels, codexBin, type CodexModel, type WorkerHome } from './model-generation.ts'
import { limitRowOf, readSelectionTable } from './limit-table.ts'

export type LaunchSettings = { agent: string | null; model: string | null; effort: string | null }
export type ModelCheck = { reject: string | null; warnings: string[] }

// 대체 후보는 agent-selection.md 「사용 한도에 걸렸을 때」 표의 「같은 등급 대응」 칸이다. 같은 계열이면 세대가 달라도 그 줄을 쓴다.
// 표를 읽지 못하거나 줄이 없으면 안내 줄을 붙이지 않는다
function suggestion(settings: LaunchSettings, table: string | null): string {
  let cell: string | null = null
  try {
    cell = limitRowOf(table ?? readSelectionTable(), settings)?.cell ?? null
  } catch { /* 표를 읽지 못하면 안내를 빼고 거절 사유만 낸다 */ }
  return cell ? `\n같은 등급 대체 모델: ${cell} — agent-selection.md 의 한도 표를 확인한다` : ''
}

function checkCodex(settings: LaunchSettings, table: string | null, worker?: WorkerHome): ModelCheck {
  const bin = codexBin()
  const list = readCodexModels(bin, worker)
  if (list.failure !== null) return { reject: null, warnings: [`${bin} debug models ${list.failure}라 --model, --effort 를 검사하지 못했다`] }
  const models: CodexModel[] = list.models
  // 이 계정의 선택 목록에 보이는 모델만 launch 대상으로 삼는다.
  const available = models.filter((m) => m.visibility === 'list').map((m) => `  ${m.slug}: ${m.efforts.join(', ')}`).join('\n')
  const model = models.find((m) => m.slug === settings.model)
  if (!model) {
    return { reject: `MODEL-UNAVAILABLE ${settings.model} ${settings.effort || '기본'}${suggestion(settings, table)}\n쓸 수 있는 모델과 effort:\n${available}`, warnings: [] }
  }
  if (settings.effort && !model.efforts.includes(settings.effort)) {
    return { reject: `EFFORT-UNAVAILABLE ${settings.model} ${settings.effort}${suggestion(settings, table)}\n${settings.model} 의 effort: ${model.efforts.join(', ')}\n쓸 수 있는 모델과 effort:\n${available}`, warnings: [] }
  }
  return { reject: null, warnings: [] }
}

export function checkLaunchSettings(settings: LaunchSettings, table: string | null = null, worker?: WorkerHome): ModelCheck {
  if (!settings.agent || !settings.model) return { reject: null, warnings: [] }
  if (settings.agent === 'codex') return checkCodex(settings, table, worker)
  if (settings.agent === 'claude') {
    return { reject: null, warnings: ['claude 는 모델 목록을 조회하는 명령이 없어 --model, --effort 를 검사하지 않는다'] }
  }
  return { reject: null, warnings: [] }
}
