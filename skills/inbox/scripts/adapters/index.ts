// adapter 이름과 만드는 함수의 표. 설정 inbox.json 의 adapters[].type 이 여기 이름 하나를 고른다.
// adapter 를 더하면 파일 하나와 이 표의 줄 하나가 는다. 보드와 inbox.ts 는 바뀌지 않는다.

import type { AdapterFactory } from '../lib/model.ts'
import { createDooray } from './dooray.ts'

export const ADAPTERS: Readonly<Record<string, AdapterFactory>> = Object.freeze({
  dooray: createDooray,
})
