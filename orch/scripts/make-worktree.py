#!/usr/bin/env python3
"""지시서의 브랜치로 워크트리를 만들거나 완료한 워크트리를 검사한다.

사용: make-worktree.py --repo DIR --spec FILE --name NAME [--base BRANCH]
      make-worktree.py --check DIR --spec FILE
--resume-remote는 기존 origin 브랜치의 최신 커밋에서 만들고 upstream을 연결한다.
기본 동작은 기존 브랜치를 거부하고 origin/HEAD 위에 upstream 없는 브랜치를 만든다.
종료: 0 성공, 1 거부·불일치, 2 사용법·지시서 오류.
"""
import argparse
from pathlib import Path
import re
import shutil
import sys
from orch_process import run


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('repo', 'name', 'base', 'check'):
        p.add_argument('--' + key, default='')
    p.add_argument('--spec', required=True)
    p.add_argument('--resume-remote', action='store_true')
    a = p.parse_args(argv)
    try:
        spec = Path(a.spec).read_text()
    except OSError:
        p.error(f'지시서가 없다: {a.spec}')
    branches = re.findall(r'^\s*(?:-\s+)?(?:\*\*)?브랜치(?:\*\*)?:(?:\*\*)?\s*`([^`]+)`', spec, re.M)
    if len(branches) != 1:
        p.error(('지시서에 줄 머리 `브랜치:` 줄이 둘 이상이다: ' + ', '.join(branches)) if branches else '지시서에 줄 머리 `브랜치:` 줄이 없다')
    branch = branches[0]
    if run('git', 'check-ref-format', '--branch', branch).returncode:
        p.error(f'브랜치 이름이 올바르지 않다: {branch}')
    if a.check:
        def git(*args):
            return run('git', '-C', a.check, *args).stdout.strip()
        head = git('rev-parse', 'HEAD')
        checks = [('브랜치', git('branch', '--show-current'), branch),
                  ('upstream', git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'), f'origin/{branch}'),
                  ('원격 끝', git('ls-remote', 'origin', f'refs/heads/{branch}').split('\t')[0], head)]
        for label, actual, expected in checks:
            if actual != expected:
                print(f'불일치: {label} {actual or "(없음)"}, 지시서 {expected}')
        if all(actual == expected for _, actual, expected in checks):
            print(f'일치: {branch} (HEAD {head})')
            return 0
        return 1
    if not a.repo or not a.name:
        p.error('--repo 와 --name 이 필요하다')
    root = run('git', '-C', a.repo, 'rev-parse', '--show-toplevel')
    if root.returncode:
        p.error(f'git 저장소가 아니다: {a.repo}')
    repo = Path(root.stdout.strip()).resolve()
    def git(*args):
        return run('git', '-C', repo, *args)
    if git('fetch', '-q', 'origin').returncode:
        print('git fetch origin 실패', file=sys.stderr)
        return 1
    base = (a.base or git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.strip() or 'origin/main').removeprefix('origin/')
    if git('rev-parse', '--verify', '-q', f'refs/remotes/origin/{base}').returncode and not a.resume_remote:
        print(f'origin/{base} 가 없다', file=sys.stderr)
        return 1
    wt = repo / 'worktrees' / repo.name / a.name
    reason = ''
    if wt.exists():
        reason = f'경로가 이미 있다: {wt}. 이어서 하는 일이면 --worktree path: 로 띄운다'
    elif not git('rev-parse', '--verify', '-q', f'refs/heads/{branch}').returncode:
        reason = f'로컬 브랜치 {branch} 가 이미 있다. 이어서 하는 일이면 그 워크트리에 띄운다'
    remote_exists = not git('rev-parse', '--verify', '-q', f'refs/remotes/origin/{branch}').returncode
    if not reason and remote_exists != a.resume_remote:
        reason = f'원격 브랜치 origin/{branch} 가 이미 있다' if remote_exists else f'이어 받을 원격 브랜치 origin/{branch} 가 없다'
    if reason:
        print('거부: ' + reason, file=sys.stderr)
        return 1
    if a.resume_remote:
        # 일반 fetch는 삭제된 원격 브랜치의 tracking ref를 남길 수 있다.
        # 브랜치를 명시해 다시 받아 서버의 존재 여부와 현재 tip을 확인한다.
        result = git('fetch', '-q', 'origin', f'+refs/heads/{branch}:refs/remotes/origin/{branch}')
        if result.returncode:
            print(f'거부: 이어 받을 원격 브랜치 origin/{branch} 를 받지 못했다\n{result.stderr}', file=sys.stderr)
            return 1
    result = git('worktree', 'add', '-q', '--track' if a.resume_remote else '--no-track', '-b', branch, wt,
                 f'origin/{branch if a.resume_remote else base}')
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        return 1
    if git('check-ignore', '-q', str(wt.relative_to(repo))).returncode:
        exclude = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip()) / 'info/exclude'
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open('a') as out:
            out.write('/worktrees/\n')
    settings = repo / '.claude/settings.local.json'
    if settings.is_file():
        (wt / '.claude').mkdir(exist_ok=True)
        shutil.copy2(settings, wt / '.claude/settings.local.json')
    result = run(sys.executable, Path(__file__).with_name('worktree-deny.py'), wt)
    if result.returncode:
        print(f'경고: deny 규칙을 더하지 못했다: {wt}/.claude/settings.local.json', file=sys.stderr)
    print(wt)
    return 0


if __name__ == '__main__':
    sys.exit(main())
