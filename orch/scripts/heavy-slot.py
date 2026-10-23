#!/usr/bin/env python3
"""같은 PC의 무거운 검사를 FIFO 대기열에서 실행한다.

사용: heavy-slot.py [--exclusive] [--slot-dir DIR] [--slots N] -- 명령...
HEAVY_SLOT_DIR의 기본값은 TMPDIR/orch-heavy-UID, HEAVY_SLOTS는 3이다.
HEAVY_EXCLUSIVE=1이면 혼자 실행하며 HEAVY_POLL은 재확인 간격(기본 5초)이다.
가벼운 검사는 대기열을 거치지 않고 중첩 호출은 HEAVY_SLOT_HELD를 물려받는다.
자리를 잡은 뒤 형제 mem-gate.py를 실행한다. MEM_GATE로 경로를 바꾼다.
종료: 명령의 종료 코드, 2 인자 오류, 1 대기열·메모리 검사 실패, 128+신호 번호.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from orch_process import script_command

LIGHT = [
    r'^(pnpm( -s)?( exec)? )?(tsc|oxlint|oxfmt)\b',
    r'^pnpm( -s)? (type-check|lint|format(:changed)?)\b',
    r'^pnpm( -s)? (test|vitest)( run)? (?!-)\S+',
    r'^(pnpm( -s)? exec |npx )?vitest( run)? (?!-)\S+',
    r'^node (--check|-c) ', r'^(echo|cd|git|ls|cat|true|test|\[)(\s|$)',
]


def classify(argv):
    text = ' '.join(argv)
    if re.search(r'local-ci|ci-gate|pnpm( -s)? (verify|lab)\b|local-host\.cjs|browser|playwright|chrom|lab-enter-field', text):
        return 'exclusive'
    if re.search(r'play-scenario|play_scenario|baseline-compare|parity-play', text):
        return 'normal'
    body = ' '.join(argv[2:]) if argv[:2] in (['bash', '-c'], ['sh', '-c']) else text
    parts = [re.sub(r'^\(+|\)+$', '', re.sub(r'^(\(?time|/usr/bin/time( -l)?)\s+', '', p.strip())).strip()
             for p in re.split(r'&&|\|\||;|\|', body) if p.strip()]
    return 'light' if parts and all(any(re.search(pat, p) for pat in LIGHT) for p in parts) else 'normal'


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Queue:
    """하나의 파일 잠금 아래 등록과 선점을 처리해 PID 기록이 중간에 노출되지 않는다."""
    def __init__(self, root, slots):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.slots = slots
        self.entry = self.root / f'{os.getpid()}.json'

    @contextmanager
    def locked(self):
        with (self.root / 'queue.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def rows(self):
        rows = []
        for entry in self.root.glob('*.json'):
            row = json.loads(entry.read_text())
            if not alive(row['pid']):
                entry.unlink()
            else:
                rows.append(row)
        return sorted(rows, key=lambda r: (r['ticket'], r['pid']))

    def register(self, exclusive):
        with self.locked():
            rows = self.rows()
            if any(r['slots'] != self.slots for r in rows):
                raise ValueError('active queue uses a different HEAVY_SLOTS value')
            self.entry.write_text(json.dumps(dict(pid=os.getpid(), ticket=time.time_ns(),
                                                 exclusive=exclusive, held=False, slots=self.slots)))

    def claim(self):
        with self.locked():
            rows = self.rows()
            own = next(r for r in rows if r['pid'] == os.getpid())
            held = [r for r in rows if r['held']]
            waiting = [r for r in rows if not r['held']]
            ahead = waiting[:waiting.index(own)]
            if any(r['exclusive'] for r in held):
                return False
            if own['exclusive']:
                ready = not held and not ahead
            else:
                ready = not any(r['exclusive'] for r in ahead) and len(ahead) < self.slots - len(held)
            if ready:
                own['held'] = True
                self.entry.write_text(json.dumps(own))
            return ready

    def cleanup(self):
        with self.locked():
            self.entry.unlink(missing_ok=True)


def run_command(cmd, env=None):
    try:
        child = subprocess.Popen(cmd, env=env, start_new_session=True)
    except FileNotFoundError:
        print(f'heavy-slot: command not found: {cmd[0]}', file=sys.stderr)
        return 127
    except PermissionError:
        print(f'heavy-slot: command is not executable: {cmd[0]}', file=sys.stderr)
        return 126
    try:
        code = child.wait()
    except BaseException:
        # Keep the slot until the command has really stopped.
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        raise
    return code if code >= 0 else 128 - code


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exclusive', action='store_true')
    parser.add_argument('--slot-dir', default=os.environ.get('HEAVY_SLOT_DIR', str(Path(tempfile.gettempdir()) / f'orch-heavy-{os.getuid()}')))
    parser.add_argument('--slots', type=int, default=os.environ.get('HEAVY_SLOTS', '3'))
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    cmd = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not cmd or args.slots < 1:
        parser.error('a command and positive slot count are required')
    if sys.platform == 'darwin':
        os.environ['TMPDIR'] = str(Path(os.environ.get('TMPDIR', '/tmp')).resolve()) + '/'
    if os.environ.get('HEAVY_SLOT_HELD'):
        return run_command(cmd)
    exclusive = args.exclusive or os.environ.get('HEAVY_EXCLUSIVE') == '1' or classify(cmd) == 'exclusive'
    if not exclusive and classify(cmd) == 'light':
        return run_command(cmd)
    queue = Queue(args.slot_dir, args.slots)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        queue.register(exclusive)
        while not queue.claim():
            print('heavy-slot: waiting', file=sys.stderr)
            time.sleep(float(os.environ.get('HEAVY_POLL', '5')))
        gate = Path(os.environ.get('MEM_GATE', str(Path(__file__).with_name('mem-gate.py'))))
        gate_code = run_command(script_command(gate))
        if gate_code:
            return gate_code
        return run_command(cmd, dict(os.environ, HEAVY_SLOT_HELD=str(os.getpid())))
    finally:
        queue.cleanup()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as exc:
        print(f'heavy-slot: {exc}', file=sys.stderr)
        sys.exit(1)
