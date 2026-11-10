// 고정 입력 실행 전용 시계. 제품 코드는 실제 Date 를 그대로 쓴다.
const OriginalDate = Date
const instant = OriginalDate.parse('2026-11-10T00:00:00.000Z')
class FixedDate extends OriginalDate {
  constructor(value?: string | number) { super(value === undefined ? instant : value) }
  static now(): number { return instant }
}
globalThis.Date = FixedDate as DateConstructor

// 캐시 무효화 식별자도 고정 입력이다. 결과를 지우거나 정규화하지 않는다.
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
let sequence = 0
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
syncBuiltinESMExports()
