#!/usr/bin/env python3
"""브라우저 자동화 드라이버 중립 계층.

왜 필요한가:
  1. 스킬 본문이 특정 브라우저 도구에 묶이지 않게 한다. 팀원마다 쓰는 도구가 다르다.
  2. orca 와 agent-browser 는 둘 다 실패해도 종료 코드가 0 이다 (실측).
     그대로 쓰면 오류가 조용히 묻힌다. 이 계층이 실패를 종료 코드 1 로 바꾼다.
  3. agent-browser 에는 JS 조건 대기 명령이 없다. eval 안의 async 폴링으로 메운다 (실측).

명령 목록과 백엔드 상태는 `browser-driver help`, 환경 진단은 `browser-driver doctor` 가 낸다.
백엔드별 함정은 README.md 가 소유한다.

종료 코드:
  0 성공
  1 브라우저 조작 실패
  2 잘못된 호출이나 환경 문제 (백엔드 없음, 설정 오류, 미지원 명령)
"""

import json
import sys
from pathlib import Path

# 심링크로 불릴 때 sys.path[0] 은 링크가 놓인 디렉터리다. driver 패키지가 거기에 없다.
# resolve() 로 실체 경로를 잡아 그 옆의 패키지를 찾게 한다.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from driver.admin import cmd_doctor, cmd_install  # noqa: E402
from driver.backends import BACKENDS, load_backend, resolve_backend_name  # noqa: E402
from driver.commands import COMMAND_MAP, COMMANDS, META_COMMANDS, render_help  # noqa: E402
from driver.errors import EXIT_FAIL, EXIT_USAGE, DriverError, UsageError  # noqa: E402


def main(argv):
    cmd = argv[0] if argv else ""
    args = argv[1:]

    if cmd in ("", "help", "-h", "--help"):
        # 도움말은 백엔드가 없어도 나와야 한다. 무엇을 설치해야 하는지 여기서 읽기 때문이다.
        backend_name, unsupported = None, frozenset()
        try:
            name, _ = resolve_backend_name()
            if name in BACKENDS:
                backend_name = name
                unsupported = {c.name for c in COMMANDS} - BACKENDS[name].supported
        except UsageError:
            pass
        print(render_help(backend_name, unsupported))
        return 0 if cmd else EXIT_USAGE

    if cmd == "doctor":
        return cmd_doctor()

    if cmd == "install":
        return cmd_install(args)

    if cmd == "driver":
        # 설치 여부는 보지 않는다. 어느 백엔드가 잡히는지 묻는 명령이라 설치 전에도 답해야 한다.
        # 다만 모르는 이름은 여기서 막는다. 그대로 흘리면 첫 조작에서야 드러난다.
        name, source = resolve_backend_name()
        if name not in BACKENDS:
            raise UsageError(f"모르는 백엔드: {name} ({source}). 쓸 수 있는 값: "
                             + ", ".join(BACKENDS))
        print(name)
        return 0

    spec = COMMAND_MAP.get(cmd)
    if spec is None:
        known = ", ".join([c.name for c in COMMANDS] + [c.name for c in META_COMMANDS])
        raise UsageError(f"모르는 명령: {cmd}\n쓸 수 있는 명령: {known}\n자세한 사용법은 help 로 본다.")

    if len(args) < spec.required:
        raise UsageError(f"인자가 모자란다.\n사용법: {spec.usage}\n  {spec.summary}")

    backend = load_backend()
    if cmd not in backend.supported:
        raise UsageError(
            f"{backend.name} 백엔드에서 '{cmd}' 의 대응 명령을 확인하지 못했다. "
            "다른 백엔드를 쓰거나 doctor 로 상태를 본다.")

    result = backend.dispatch(cmd, args)
    if result is None:
        return 0
    if isinstance(result, (dict, list)):
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except UsageError as e:
        print(e, file=sys.stderr)
        sys.exit(EXIT_USAGE)
    except DriverError as e:
        print(e, file=sys.stderr)
        sys.exit(EXIT_FAIL)
    except KeyboardInterrupt:
        sys.exit(130)
