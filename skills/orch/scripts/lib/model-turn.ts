// 저장소와 무관하게 같은 등급의 다음 제공자를 기억한다.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machineDir } from './machine.ts'
import { withOwnerLock } from './owner-lock.ts'
import type { Provider } from './worker-account.ts'

export type ModelTurn = { grade: string; agent: Provider }

export function takeModelTurn(grade: string): ModelTurn {
  const file = join(machineDir(), 'model-turns.json')
  return withOwnerLock(`${file}.lock`, () => {
    let turns: Record<string, Provider> = {}
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
          Object.values(saved).some(agent => agent !== 'codex' && agent !== 'claude')) {
        throw new Error('모델 차례 파일의 형식이 틀렸다')
      }
      turns = saved
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const agent = Object.hasOwn(turns, grade) ? turns[grade] : 'codex'
    turns[grade] = agent === 'codex' ? 'claude' : 'codex'
    const temp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(turns) + '\n')
      renameSync(temp, file)
    } finally {
      rmSync(temp, { force: true })
    }
    return { grade, agent }
  })
}

// relaunch 가 사전 검사와 시작 사이에 넘기는 차례. 형식이 맞는 값만 읽는다.
export function parseModelTurn(value: string): ModelTurn | null {
  const match = /^([a-z][a-z0-9-]*) (codex|claude)$/.exec(value)
  return match ? { grade: match[1], agent: match[2] as Provider } : null
}
