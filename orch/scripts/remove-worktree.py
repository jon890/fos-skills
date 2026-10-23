#!/usr/bin/env python3
"""터미널 소유 상태와 작업 디렉터리 사용자를 확인하고 발행한 깨끗한 워크트리를 지운다.

사용: remove-worktree.py DIR [--delete-branch] [--merged-head SHA] [--wait SEC]
OMC session-end hook과 자손은 ORCH_HOOK_WAIT초(기본 180초)까지 기다린다.
원격 브랜치는 지우지 않는다. 종료: 0 삭제, 1 거부, 2 인자 오류.
거부하는 경우: 그 경로를 쓰는 프로세스가 --wait 초 뒤에도 남았다, 커밋 안 된 변경이 있다,
원격 어디에도 없는 커밋이 있다, HEAD 가 --merged-head 의 조상이 아니다. 이유를 출력한다.
원격에 같은 제목의 커밋이 있으면 rebase 된 것으로 보지만 squash 머지는 제목이 달라 원격에 없는 커밋으로 센다.
그때 --merged-head 를 주면 그 커밋의 조상은 원격에 있는 것으로 센다.
Python 3.10 이상, lsof, git 2.31 이상이 필요하다.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
from orch_process import pause, run


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('worktree', type=Path)
    p.add_argument('--delete-branch', action='store_true')
    p.add_argument('--merged-head', default='')
    p.add_argument('--wait', default='0')
    a = p.parse_args(argv)
    hook_wait = os.environ.get('ORCH_HOOK_WAIT', '180')
    if not a.wait.isdigit() or not hook_wait.isdigit():
        p.error('--wait 와 ORCH_HOOK_WAIT 는 0 이상의 정수다')
    target = a.worktree.resolve()
    if not target.is_dir():
        print(f'없음: {target}')
        return 1
    def git(*args):
        return run('git', '-C', target, *args)
    common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
    if common.returncode:
        print(f'git worktree 가 아니다: {target}')
        return 1
    repo = Path(common.stdout.strip()).parent
    branch = git('branch', '--show-current').stdout.strip()
    def ownership():
        return subprocess.run([sys.executable, str(Path(__file__).with_name('terminal_ownership.py')), str(target)]).returncode == 0
    if not ownership():
        return 1
    waited = 0
    while True:
        listing = run('lsof', '-d', 'cwd', '-Fpn')
        # lsof returns 1 when no process matches; other failures cannot prove safety.
        if listing.returncode not in (0, 1):
            print('거부: cwd 프로세스 조회 실패')
            return 1
        holders, pid = set(), ''
        for line in listing.stdout.splitlines():
            if line.startswith('p'):
                pid = line[1:]
            elif line.startswith('n') and (line[1:] == str(target) or line[1:].startswith(str(target) + '/')):
                holders.add(pid)
        holders = sorted(holders)
        if not holders:
            break
        processes = run('ps', '-axo', 'pid=,ppid=,command=')
        if processes.returncode:
            print('거부: hook 프로세스 조회 실패')
            return 1
        parents, hooks = {}, set()
        for line in processes.stdout.splitlines():
            row = line.split(None, 2)
            if len(row) == 3:
                parents[row[0]] = row[1]
                if re.search(r'--omc-session-end-worker|hooks/session-end/worker\.js', row[2]):
                    hooks.add(row[0])
        hook_holders = []
        for holder in holders:
            ancestor = holder
            for _ in range(50):
                if ancestor in hooks:
                    hook_holders.append(holder)
                    break
                ancestor = parents.get(ancestor)
                if ancestor in (None, '0'):
                    break
        limit = max(int(a.wait), int(hook_wait)) if len(hook_holders) == len(holders) else int(a.wait)
        joined = ', '.join(holders)
        if waited >= limit:
            note = f' 그중 OMC session-end hook {", ".join(hook_holders)} 는 스스로 끝난다.' if hook_holders else ''
            print(f'거부: {target} 를 쓰는 프로세스 {len(holders)} 개 (pid {joined}), {waited}초 기다림.{note} 끝난 dispatch 의 프로세스면 cleanup-sweep.py --kill-holders 가 끈다')
            return 1
        if not waited and len(hook_holders) == len(holders):
            print(f'대기: {target} 에 OMC session-end hook {joined} 만 남았다. 끝날 때까지 최대 {limit}초 기다린다')
        pause(1)
        waited += 1
    status = git('status', '--porcelain')
    if status.returncode or status.stdout.strip():
        print(f'거부: {target} 에 커밋 안 된 변경 또는 상태 조회 실패')
        return 1
    if a.merged_head and git('merge-base', '--is-ancestor', 'HEAD', a.merged_head).returncode:
        print(f'거부: {target} 의 HEAD 가 머지된 커밋 {a.merged_head} 와 같지도 그 조상도 아니다')
        return 1
    commits = git('rev-list', 'HEAD', '--not', '--remotes')
    if commits.returncode:
        print('거부: 원격에 없는 커밋 조회 실패')
        return 1
    lost = 0
    for commit in commits.stdout.splitlines():
        if a.merged_head and not git('merge-base', '--is-ancestor', commit, a.merged_head).returncode:
            continue
        subject = git('log', '-1', '--format=%s', commit).stdout.strip()
        if not git('log', '--remotes', '--format=%H', '-F', '--grep=' + subject, '-1').stdout.strip():
            lost += 1
    if lost:
        print(f'거부: {target} 에 원격에 없는 커밋 {lost} 개')
        return 1
    if not ownership():
        return 1
    result = run('git', '-C', repo, 'worktree', 'remove', target)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        return 1
    run('git', '-C', repo, 'worktree', 'prune')
    print(f'removed {target}')
    if a.delete_branch and branch and not run('git', '-C', repo, 'branch', '-D', branch).returncode:
        print(f'deleted branch {branch}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
