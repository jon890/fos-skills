// 드라이버가 던지는 예외와 종료 코드.

export const EXIT_FAIL = 1
export const EXIT_USAGE = 2

// 조작 실패. 종료 코드 1 로 끝난다
export class DriverError extends Error {}

// 잘못된 호출이나 환경 문제. 종료 코드 2 로 끝난다
export class UsageError extends Error {}
