// 백엔드 공통 계약. 새 백엔드는 이것을 상속한다.

import { which } from '../pylike.ts'

export abstract class Backend {
  abstract readonly name: string
  abstract readonly binary: string
  // 이 백엔드가 대응 명령을 확인한 것만 적는다. 나머지는 종료 코드 2 로 거절한다
  abstract readonly supported: ReadonlySet<string>
  // 실제로 돌려 확인했는지. 거짓이면 doctor 가 경고 표시를 붙인다
  readonly verified: boolean = true
  // js 의 --timeout 을 실제로 지키는지. 거짓이면 옵션을 받아 놓고 무시하지 않고 거절한다
  readonly jsTimeout: boolean = false
  // shot 의 --size 로 뷰포트를 정해 찍을 수 있는지. 거짓이면 옵션을 받아 놓고 무시하지 않고 거절한다
  readonly shotSize: boolean = false

  available(): boolean {
    return which(this.binary) !== null
  }

  // 쓰기 전에 사람이 해둬야 하는 것. 없으면 빈 문자열
  prepareNote(): string {
    return ''
  }

  // args 는 정규화된 위치 인자다. 반환값은 없으면 null, 있으면 문자열이나 JSON 값이다
  abstract dispatch(cmd: string, args: any[]): unknown
}
