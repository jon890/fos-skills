// 테스트용 가짜 실행 파일. 본체는 modules/testkit/fake-bin.ts 에 있다(규칙의 뜻, 하드 링크 재사용).

// 상태를 즉시 바꾸는 기존 가짜 호출은 캐시를 끈다. 캐시 전용 테스트가 명시적으로 켠다.
process.env.ORCH_GH_CACHE = '0'

export { fakeBin, type FakeRule, type FakeCall, type FakeBin } from '../../../../modules/testkit/fake-bin.ts'
