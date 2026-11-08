"""드라이버가 던지는 예외와 종료 코드."""

EXIT_FAIL = 1
EXIT_USAGE = 2


class DriverError(Exception):
    """조작 실패. 종료 코드 1 로 끝난다."""


class UsageError(Exception):
    """잘못된 호출이나 환경 문제. 종료 코드 2 로 끝난다."""
