// 값을 정하는 코드는 core 가 소유한다. 기존 import 경로도 유지한다.
export * from '../core/completion.ts'
import { isDeepStrictEqual } from 'node:util'
import { classify as classifyValues, type ClassifyOptions } from '../core/completion.ts'
export function classify(messages: Record<string, unknown>[], history: Record<string, unknown>[] = [], options: ClassifyOptions = {}): Record<string, unknown>[] {
  return classifyValues(messages, history, options, isDeepStrictEqual)
}
