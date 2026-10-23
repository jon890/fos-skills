"""Small process helpers shared by orch command-line scripts."""
from pathlib import Path
import subprocess
import sys


def script_command(script, *args):
    """Keep explicit shell overrides usable while bundled tools use Python."""
    suffix = Path(script).suffix
    interpreter = 'zsh' if suffix == '.zsh' else 'bash' if suffix == '.sh' else sys.executable
    return [interpreter, str(script), *map(str, args)]


def run(*args, cwd=None, env=None):
    return subprocess.run(list(map(str, args)), cwd=cwd, env=env, text=True, capture_output=True)


def pause(seconds):
    # A separate sleep is interruptible and also supports the existing fake CLI tests.
    subprocess.run(['sleep', str(seconds)], check=True)
