#!/usr/bin/env python3
"""macOS 메모리에 여유가 생길 때까지 기다린 뒤 명령을 실행한다.

사용: mem-gate.py [-- 명령...]
기본값: EASY_FREE_PCT=37, MIN_FREE_PCT=35, MAX_SWAP_MB=10240,
MAX_WAIT=3600초, POLL=30초. free가 충분하면 남은 swap 사용량과 무관하게 통과한다.
종료: 명령의 종료 코드, 1 시간 초과·조회 실패. 실패하면 명령을 실행하지 않는다.
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
                try:
                    os.execvp(command[0], command)
                except FileNotFoundError:
                    print(f'mem-gate: command not found: {command[0]}', file=sys.stderr)
                    return 127
                except PermissionError:
                    print(f'mem-gate: command is not executable: {command[0]}', file=sys.stderr)
                    return 126
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
