import { test } from 'node:test'
import { runLoopOrder } from './fixtures/loop-order-run.ts'

test('Run 이 둘인 틱에서 로그 줄, 결과 줄, 바깥 호출의 순서가 기록과 같다', () => runLoopOrder())
