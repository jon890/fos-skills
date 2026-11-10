import { test } from 'node:test'
import { runGolden } from './fixtures/golden-run.ts'

test('고정 입력에서 출력과 종료 뒤 상태가 같다', () => runGolden())
