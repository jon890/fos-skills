"""Orca 에 등록된 저장소의 외부 워크트리 표시 설정을 읽고 사용자 안내문을 만든다.

`git worktree add` 로 만든 워크트리는 Orca 에게 외부 워크트리다.
저장소의 `externalWorktreeVisibility` 가 `hide` 면 Orca 가 숨겨 `worker-start` 가 그 경로를 찾지 못한다.
"""
import json
import subprocess


def visibility(orca, repo):
    """`orca repo show` 의 externalWorktreeVisibility. 못 읽으면 빈 문자열."""
    try:
        done = subprocess.run([str(orca), 'repo', 'show', '--repo', f'path:{repo}', '--json'], text=True, capture_output=True)
        return json.loads(done.stdout)['result']['repo'].get('externalWorktreeVisibility') or ''
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return ''


def user_actions(repo):
    """설정을 스스로 바꾸지 않고 사용자가 고를 조치를 적는다."""
    return (f'  1) Orca 화면에서 그 워크트리를 등록한다\n'
            f'  2) orca repo set --repo path:{repo} --external-worktree-visibility show')
