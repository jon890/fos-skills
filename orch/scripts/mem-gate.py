#!/usr/bin/env python3
"""Wait for macOS memory headroom, then run an optional command.

Usage: mem-gate.py [-- COMMAND...]
EASY_FREE_PCT=37, MIN_FREE_PCT=35, MAX_SWAP_MB=10240, MAX_WAIT=3600,
POLL=30 (seconds). High free memory passes regardless of retained swap.
Exit: command status, or 1 on timeout/probe failure. No command runs on failure.
"""
import os
import re
import sys
from orch_process import pause, run


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv in (['--help'], ['-h']):
        print(__doc__)
        return 0
    command = argv[1:] if argv[:1] == ['--'] else []
    easy, minimum, maximum, limit, poll = [int(os.environ.get(k, d)) for k, d in
        [('EASY_FREE_PCT', '37'), ('MIN_FREE_PCT', '35'), ('MAX_SWAP_MB', '10240'), ('MAX_WAIT', '3600'), ('POLL', '30')]]
    waited = 0
    while True:
        free = run('memory_pressure')
        swap = run('sysctl', '-n', 'vm.swapusage')
        f = re.search(r'free percentage:\s*(\d+)%', free.stdout)
        s = re.search(r'used\s*=\s*([\d.]+)M', swap.stdout)
        if free.returncode or swap.returncode or not f or not s:
            print('mem-gate: memory probe failed', file=sys.stderr)
            return 1
        f, s = int(f[1]), int(float(s[1]))
        if f >= easy or (f >= minimum and s <= maximum):
            print(f'mem-gate: ok free={f}% swap={s}MB', file=sys.stderr)
            if command:
                os.execvp(command[0], command)
            return 0
        if waited >= limit:
            print(f'mem-gate: timeout free={f}% swap={s}MB', file=sys.stderr)
            return 1
        print(f'mem-gate: waiting free={f}% swap={s}MB (need >={minimum}% and <={maximum}MB)', file=sys.stderr)
        pause(poll)
        waited += poll


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as exc:
        print(f'mem-gate: {exc}', file=sys.stderr)
        sys.exit(1)
