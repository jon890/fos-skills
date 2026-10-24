#!/usr/bin/env python3
"""워크트리를 만들거나 확인한 뒤 허락 줄이 있는 지시서로 Orca worker를 띄운다.

사용: launch-worker.py --spec FILE (--repo DIR --name NAME | --worktree DIR)
      [--base BRANCH] [--resume-remote] [--run ID] [--watch SEC] -- WORKER_ARGS...
--resume-remote는 origin의 기존 지시서 브랜치에서 워크트리를 만들어 작업을 이어 받는다.
종료: 0 LAUNCHED, 1 거부·실행 실패, 2 사용법·orch 폴더 미이전, 3 터미널이 에이전트를 인식하지 못함.
ORCA, SPEC_LINE, MAKE_WORKTREE로 실행 도구를 바꾼다. 확인 간격은
LAUNCH_POLL=5, LAUNCH_WT_WAIT=30, LAUNCH_WT_POLL=2초가 기본값이다.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import sys
from orch_process import pause, run, script_command
import orch_paths
import orca_repo

HERE = Path(__file__).resolve().parent


def jget(text, keys):
    try:
        result = json.loads(text).get('result')
    except (ValueError, AttributeError):
        return ''
    for key in keys.split('|'):
        value = result
        for part in key.split('.'):
            value = value.get(part) if isinstance(value, dict) else None
        if value not in (None, ''):
            return value
    return ''


def unrecognized_help(worktree, waited):
    """Orca 가 워크트리를 알아보지 못했을 때 원인을 짐작할 근거와 사용자 조치를 만든다. 설정은 바꾸지 않는다."""
    common = run('git', '-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    repo = Path(common.stdout.strip()).parent if common.returncode == 0 and common.stdout.strip() else None
    value = orca_repo.visibility(os.environ.get('ORCA', 'orca'), repo) if repo else ''
    lines = [f'Orca 가 워크트리를 알아보지 못했다. `orca worktree list` 로 확인한다: {worktree} ({waited:g}초 기다림)',
             f'  만든 경로: {worktree}',
             f'  저장소의 externalWorktreeVisibility: {value or "(읽지 못함)"}']
    if value == 'hide':
        lines.append('  hide 면 git worktree add 로 만든 워크트리를 Orca 가 외부 워크트리로 보고 숨긴다. 사용자가 아래 중 하나를 한다(스크립트는 설정을 바꾸지 않는다)')
        lines.append(orca_repo.user_actions(repo))
    elif repo:
        lines.append('  hide 가 아니면 Orca 가 아직 알아보지 못한 것일 수 있다. 잠시 뒤 `orca worktree list` 를 다시 보고, 계속 안 보이면 Orca 화면에서 등록한다')
    return '\n'.join(lines)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    split = argv.index('--') if '--' in argv else len(argv)
    passthru = argv[split + 1:]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--spec', required=True)
    for key in ('repo', 'name', 'base', 'worktree', 'run'):
        p.add_argument('--' + key, default='')
    p.add_argument('--watch', default='90')
    p.add_argument('--resume-remote', action='store_true')
    a = p.parse_args(argv[:split])
    if not a.watch.isdigit():
        p.error('--watch 는 초 단위 정수다')
    if a.worktree and (a.repo or a.name or a.resume_remote):
        p.error('--worktree 와 --repo/--name/--resume-remote 은 함께 쓰지 않는다')
    if not a.worktree and not (a.repo and a.name):
        p.error('새 워크트리는 --repo 와 --name, 기존 워크트리는 --worktree 를 준다')
    reuse_opts = [x for x in passthru if x in ('--agent', '--model', '--effort')]
    if '--terminal' in passthru and reuse_opts:
        print(f'거부: --terminal 은 {" ".join(reuse_opts)} 와 함께 쓰지 못한다(invalid_argument)', file=sys.stderr)
        return 1
    if not orch_paths.require_migrated(a.repo or a.worktree.removeprefix('path:'), 'launch-worker', bypass=None):
        return 2
    orca = os.environ.get('ORCA', 'orca')
    poll = float(os.environ.get('LAUNCH_POLL', '5'))
    wt_wait = float(os.environ.get('LAUNCH_WT_WAIT', '30'))
    wt_poll = float(os.environ.get('LAUNCH_WT_POLL', '2'))
    def call(*args):
        return run(orca, *args)
    def left_terminals(worktree, reuse=''):
        result = call('terminal', 'list', '--json')
        if result.returncode:
            raise ValueError('거부: orca terminal list 를 읽지 못해 남은 터미널을 확인할 수 없다')
        try:
            rows = json.loads(result.stdout)['result'].get('terminals') or []
        except (ValueError, KeyError, AttributeError):
            raise ValueError('거부: 터미널 목록을 해석하지 못했다')
        return '\n'.join(f'{t.get("handle")} {(t.get("title") or "")[:60]}' for t in rows
                         if t.get('worktreePath') == worktree and t.get('handle') != reuse)
    spec_line = run(*script_command(os.environ.get('SPEC_LINE', HERE / 'spec-line.py'), a.spec, '--require-permission'))
    if spec_line.returncode:
        print('거부: 첫 지시 줄을 만들지 못했다(지시서에 `허락:` 줄을 적는다)', file=sys.stderr)
        return 1
    created = not a.worktree
    if created:
        args = ['--repo', a.repo, '--spec', a.spec, '--name', a.name]
        if a.base:
            args += ['--base', a.base]
        if a.resume_remote:
            args += ['--resume-remote']
        result = run(*script_command(os.environ.get('MAKE_WORKTREE', HERE / 'make-worktree.py'), *args))
        if result.returncode:
            print(result.stderr, file=sys.stderr)
            return 1
        worktree = result.stdout.strip()
        print(f'워크트리를 만들었다: {worktree}')
    else:
        target = Path(a.worktree.removeprefix('path:')).resolve()
        if not target.is_dir():
            print(f'워크트리가 없다: {target}', file=sys.stderr)
            return 1
        worktree = str(target)
        reuse = passthru[passthru.index('--terminal') + 1] if '--terminal' in passthru else ''
        left = left_terminals(worktree, reuse)
        if left:
            print('거부: 이 워크트리에 터미널이 남아 있다. 끝났는지 보고 orca terminal close --terminal <handle> 로 닫은 뒤 다시 띄운다\n' + left)
            return 1
    started = False
    try:
        waited = 0
        while True:
            result = call('worktree', 'list', '--limit', '1000', '--json')
            try:
                rows = json.loads(result.stdout)['result'].get('worktrees') or []
            except (ValueError, KeyError, AttributeError):
                rows = []
            if result.returncode == 0 and any(Path(r.get('path') or '/nonexistent').resolve() == Path(worktree).resolve() for r in rows):
                break
            if waited >= wt_wait:
                print(unrecognized_help(worktree, waited), file=sys.stderr)
                return 1
            pause(wt_poll)
            waited += wt_poll or 1
        print(f'Orca 가 워크트리를 알아보기까지 {waited:g}초 기다렸다', file=sys.stderr)
        def start(*args):
            result = call('orchestration', 'worker-start', *args, '--json')
            if result.returncode and 'selector_not_found' in result.stdout + result.stderr:
                print(f'worker-start 가 selector_not_found 로 끝나 {wt_poll:g}초 뒤 한 번 다시 부른다', file=sys.stderr)
                pause(wt_poll)
                result = call('orchestration', 'worker-start', *args, '--json')
            print(result.stdout + result.stderr)
            return result
        def watch(dispatch):
            waited = 0
            while True:
                stage = jget(call('orchestration', 'worker-show', '--dispatch', dispatch, '--json').stdout, 'worker.stage')
                if stage and stage != 'worktree_creating':
                    print(f'{dispatch} 단계: {stage}')
                    return True
                if waited >= int(a.watch):
                    print(f'{dispatch} 가 {a.watch}초 동안 {stage or "단계 없음"} 에서 넘어가지 않았다')
                    return False
                pause(poll)
                waited += poll or 1
        run_args = ['--run', a.run] if a.run else []
        result = start(*run_args, '--spec', spec_line.stdout.strip(), '--worktree', 'path:' + worktree, *passthru)
        output = result.stdout + result.stderr
        if result.returncode:
            if '--terminal' in passthru and 'agent_unconfigured' in output:
                print('--terminal 의 터미널이 에이전트를 인식하지 못했다(agent_unconfigured). replying.md 「이어 쓸 수 없는 터미널」 을 따른다. 이 세션이 띄운 worker 의 작업이 push 됐는지 확인하고 orca terminal close 로 닫은 뒤 --terminal 을 빼고 --agent, --model, --effort 를 준다', file=sys.stderr)
                return 3
            if 'agent-hooks-review-prompt' in output:
                print('Codex 설치본에 .codex-plugin 이 없는 옛 버전이다: codex plugin marketplace upgrade fos-skills (docs/adr/007)', file=sys.stderr)
            print(f'worker-start 가 종료 코드 {result.returncode} 로 끝났다. launch.md 의 「첫 화면에서 멈춤」 과 「시작 직후 실패」 를 본다', file=sys.stderr)
            return 1
        started = True
        dispatch = jget(result.stdout, 'dispatch.id|dispatchId|worker.dispatchId')
        task = jget(result.stdout, 'dispatch.taskId|taskId|task.id')
        if not dispatch:
            print('worker-start 출력에서 dispatch id 를 읽지 못했다', file=sys.stderr)
            return 1
        if int(a.watch) and not watch(dispatch):
            if not task:
                print(f'task id 를 몰라 다시 띄우지 못한다: {dispatch}', file=sys.stderr)
                return 1
            if call('orchestration', 'worker-abandon', '--dispatch', dispatch, '--json').returncode:
                return 1
            print(f'{dispatch} 를 abandon 하고 같은 Task 를 path:{worktree} 로 다시 띄운다')
            result = start(*run_args, '--task', task, '--retry-of', dispatch, '--worktree', 'path:' + worktree, *passthru)
            if result.returncode:
                return 1
            dispatch = jget(result.stdout, 'dispatch.id|dispatchId|worker.dispatchId')
            if not dispatch or not watch(dispatch):
                return 1
        print(f'LAUNCHED {dispatch} {worktree}')
        return 0
    finally:
        if created and not started:
            hint = ['launch-worker.py', '--spec', a.spec, '--worktree', worktree, *(['--run', a.run] if a.run else []), '--', *passthru]
            print(f'워크트리는 남아 있다: {worktree}\n같은 --name 으로 다시 부르면 make-worktree 가 거부한다. 이어 띄우려면 --repo/--name/--base 대신 --worktree 를 준다:\n  {shlex.join(hint)}', file=sys.stderr)
            try:
                left = left_terminals(worktree)
                if left:
                    print('실패한 띄우기가 남긴 터미널을 확인한다:\n' + left, file=sys.stderr)
            except ValueError:
                pass


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
