// 값을 정하는 코드는 core 가 소유한다. 기존 import 경로도 유지한다.

import { loadConfig } from './config.ts'
import { boardSettingsFromConfig, type BoardSettings } from '../core/milestones.ts'

export * from '../core/milestones.ts'

export function boardSettings(repo: string): BoardSettings {
  return boardSettingsFromConfig(loadConfig(repo))
}
