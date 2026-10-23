"""orch 명령줄 도구가 함께 쓰는 프로세스 실행 함수.
"""
from pathlib import Path
import subprocess
import sys


def script_command(script, *args):
    """번들 도구는 Python으로 실행하고 명시적으로 지정한 셸 스크립트도 받는다."""
    suffix = Path(script).suffix
    interpreter = 'zsh' if suffix == '.zsh' else 'bash' if suffix == '.sh' else sys.executable
    return [interpreter, str(script), *map(str, args)]


def run(*args, cwd=None, env=None):
    return subprocess.run(list(map(str, args)), cwd=cwd, env=env, text=True, capture_output=True)


def pause(seconds):
    # A separate sleep is interruptible and also supports the existing fake CLI tests.
    subprocess.run(['sleep', str(seconds)], check=True)
