// worker 를 띄우기 전에 --agent, --model, --effort 가 그 에이전트에 있는 값인지 본다.
// 없는 모델로 띄우면 worker 가 오류로 멈춘 채 WORKER-STALLED 로만 드러나, 워크트리와 Task 가 헛되이 생긴다.
//
// 정본:
//     codex   `codex debug models` 의 JSON(models[].slug, visibility, supported_reasoning_levels[].effort). CODEX_BIN 으로 실행 파일을 바꾼다
//     claude  모델 목록을 내는 명령이 없다(`claude --help` 의 명령 목록에 없다). 추측한 목록을 두지 않고 검사를 건너뛴다
//
// 결과:
//     reject   없는 모델이나 그 모델이 지원하지 않는 effort. message 에 쓸 수 있는 값을 함께 담는다
//     warnings 검사를 하지 못한 사정(조회 명령 실패, 출력 해석 실패, claude). 띄우기는 막지 않는다. 검사 불능과 잘못된 값은 다르다
//
// 검사하지 않는 경우: --agent 가 없으면 어느 쪽 모델인지 알 수 없다. --model 이 없으면 effort 가 어느 모델에 속하는지 몰라 effort 도 보지 않는다.

import { run } from './proc.ts'

export type LaunchSettings = { agent: string | null; model: string | null; effort: string | null }
export type ModelCheck = { reject: string | null; warnings: string[] }

type CodexModel = { slug?: unknown; visibility?: unknown; supported_reasoning_levels?: unknown }
const cache = new Map<string, { models: CodexModel[] | null; failure: string | null }>()

function efforts(model: CodexModel): string[] {
  const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []
  return levels.map((level) => (level as { effort?: unknown })?.effort).filter((effort): effort is string => typeof effort === 'string')
}

function checkCodex(settings: LaunchSettings): ModelCheck {
  const bin = process.env.CODEX_BIN || 'codex'
  const skipped = (why: string): ModelCheck => ({ reject: null, warnings: [`${bin} debug models ${why}라 --model, --effort 를 검사하지 못했다`] })
  if (!cache.has(bin)) {
    const done = run([bin, 'debug', 'models'], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 })
    if (done.code !== 0) cache.set(bin, { models: null, failure: `가 종료 코드 ${done.code} 로 끝났` })
    else {
      try {
        const list = (JSON.parse(done.stdout) as { models?: unknown }).models
        if (!Array.isArray(list)) cache.set(bin, { models: null, failure: '의 models 목록을 읽지 못했' })
        else cache.set(bin, { models: list.filter((m) => m && typeof m.slug === 'string' && Array.isArray(m.supported_reasoning_levels)) as CodexModel[], failure: null })
      } catch { cache.set(bin, { models: null, failure: '의 출력이 JSON 이 아니었' }) }
    }
  }
  const checked = cache.get(bin)!
  if (checked.failure) return skipped(checked.failure)
  const models = checked.models!
  // 이 계정의 선택 목록에 보이는 모델만 launch 대상으로 삼는다.
  const shown = models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
  const available = shown.map((m) => `  ${m.slug}: ${efforts(m).join(', ')}`).join('\n')
  const model = models.find((m) => m.slug === settings.model)
  const previousSol = settings.model === 'gpt-6.1-sol' && settings.effort !== 'high' && settings.effort !== 'medium'
    ? shown.find((m) => m.slug === 'gpt-6-sol' && (!settings.effort || efforts(m).includes(settings.effort))) : null
  const otherProvider = settings.model === 'gpt-6-luna' ? 'Claude Haiku 5.5' : settings.model === 'gpt-6.1-sol' && (settings.effort === 'high' || settings.effort === 'medium') ? 'Claude Opus 5.5' : 'Claude Sonnet 5.5'
  const suggestion = previousSol ? `\n같은 등급 대체 모델: ${previousSol.slug} (${settings.effort || efforts(previousSol)[0]}) — agent-selection.md 의 한도 표를 확인한다` : `\n같은 등급 대체 모델: ${otherProvider} — agent-selection.md 의 한도 표를 확인한다`
  if (!model) {
    return { reject: `MODEL-UNAVAILABLE ${settings.model} ${settings.effort || '기본'}${suggestion}\n쓸 수 있는 모델과 effort:\n${available}`, warnings: [] }
  }
  const supported = efforts(model)
  if (settings.effort && !supported.includes(settings.effort)) {
    return { reject: `EFFORT-UNAVAILABLE ${settings.model} ${settings.effort}${suggestion}\n${settings.model} 의 effort: ${supported.join(', ')}\n쓸 수 있는 모델과 effort:\n${available}`, warnings: [] }
  }
  return { reject: null, warnings: [] }
}

export function checkLaunchSettings(settings: LaunchSettings): ModelCheck {
  if (!settings.agent || !settings.model) return { reject: null, warnings: [] }
  if (settings.agent === 'codex') return checkCodex(settings)
  if (settings.agent === 'claude') {
    return { reject: null, warnings: ['claude 는 모델 목록을 조회하는 명령이 없어 --model, --effort 를 검사하지 않는다'] }
  }
  return { reject: null, warnings: [] }
}
