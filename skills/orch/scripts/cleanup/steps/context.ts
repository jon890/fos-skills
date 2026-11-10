// 정리 단계의 입력과 누적 결과. 성공 단계는 앞 단계의 오류 코드를 덮지 않는다.
import type { Args, Log, Owners, Report, Terminal } from '../shared.ts'
import type { WorkerRow } from '../../lib/ownership.ts'

export type StepContext = { repo: string; args: Args; workers: WorkerRow[]; terminals: Terminal[]; log: Log }
export type StepState = { report: Report; listed: [string, string][]; remaining: Set<string>; specsDir: string | null; owners: Owners; code: number }
export type StepResult = Partial<StepState>
