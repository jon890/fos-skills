"""명령 인자 중 옵션을 떼어 내고 검증한다. 백엔드는 정규화된 위치 인자만 받는다."""

from .errors import UsageError

BUTTONS = ("left", "middle", "right")


def _number(text, what):
    try:
        return float(text)
    except ValueError:
        raise UsageError(f"숫자여야 한다 ({what}): {text}")


def split_option(args, flag):
    """`flag 값` 쌍을 args 에서 떼어 내고 (나머지, 값 또는 None) 을 낸다."""
    rest = list(args)
    if flag not in rest:
        return rest, None
    i = rest.index(flag)
    if i + 1 >= len(rest):
        raise UsageError(f"{flag} 에 값이 없다")
    value = rest[i + 1]
    del rest[i:i + 2]
    return rest, value


def parse_js_args(args):
    """`js <handle> <expression> [--timeout <ms>]` → `[handle, expression, timeout_ms 또는 None]`."""
    rest, raw = split_option(args, "--timeout")
    timeout = None
    if raw is not None:
        timeout = int(_number(raw, "--timeout"))
        if timeout <= 0:
            raise UsageError(f"--timeout 은 1 이상의 밀리초여야 한다: {raw}")
    if len(rest) != 2:
        raise UsageError("인자가 모자라거나 남는다. js <handle> <expression> [--timeout <ms>]")
    return [rest[0], rest[1], timeout]


def parse_pointer_args(cmd, args, points, allow_button):
    """`<handle> <x> <y> ...` 를 `[handle, 좌표..., button]` 로 정규화한다. 좌표는 CSS 픽셀이다."""
    rest, button = split_option(args, "--button") if allow_button else (list(args), None)
    need = 1 + 2 * points
    if len(rest) != need:
        raise UsageError(f"인자가 모자라거나 남는다. 핸들 뒤에 좌표 {2 * points}개가 필요하다 ({cmd})")
    coords = [_number(v, "좌표") for v in rest[1:]]
    if button is None:
        button = "left"
    if button not in BUTTONS:
        raise UsageError(f"--button 은 {', '.join(BUTTONS)} 중 하나여야 한다: {button}")
    return [rest[0], *coords, button]
