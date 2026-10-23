#!/usr/bin/env python3
"""읽지 않은 메시지를 먼저 확인하고 코디네이터에게 질문한다.

사용: worker-ask.py --from HANDLE (--question TEXT | --resume ID)
                   [--options CSV] [--run ID] [--timeout-ms N] [--force] [--decision]
--decision: 사용자가 정할 결정 질문이다. 본문이 docs/data-schema.md 「사용자 결정 질문 형식」
(첫 줄 `결정:` 과 비지 않은 제목, `- ` 선택지 둘 이상, `권장:` 줄 하나)을 따르는지 보고, 어긋나면 묻지 않고 줄마다 stderr 에 낸다.
`--resume` 으로 재개할 때는 검사하지 않는다.
종료: 0 답 수신, 2 사용법·실행 오류(--decision 형식 위반 포함), 3 status 답 또는 Run 메일함으로 대신 보냄,
4 시간 초과(출력의 ID로 재개), 5 읽지 않은 코디네이터 메시지가 있어 묻지 않음.
ORCA로 CLI, ORCH_ASK_SEEN으로 읽은 메시지 기록 경로를 바꾼다.
"""
import argparse
import os
from pathlib import Path
import re
import sys
from orch_process import run

HERE = Path(__file__).resolve().parent


def extract(mode, text, *args):
    import subprocess
    return subprocess.run([sys.executable, str(HERE / 'ask-json.py'), mode, *args],
                          input=text, text=True, capture_output=True).stdout.strip()


def decision_problems(question):
    lines = [line.strip() for line in question.splitlines()]
    problems = []
    if not lines or not lines[0].startswith('결정:'):
        problems.append('첫 줄이 `결정:` 으로 시작해야 한다')
    elif not lines[0][len('결정:'):].strip():
        problems.append('`결정:` 뒤에 무엇을 정하는지 제목이 있어야 한다')
    choices = sum(line.startswith('- ') for line in lines)
    if choices < 2:
        problems.append(f'`- ` 로 시작하는 선택지 줄이 둘 이상이어야 한다(지금 {choices}개)')
    advice = sum(line.startswith('권장:') for line in lines)
    if advice != 1:
        problems.append(f'`권장:` 줄이 정확히 하나여야 한다(지금 {advice}개)')
    return problems


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--from', dest='sender', required=True)
    for key in ('question', 'resume', 'options', 'run'):
        p.add_argument('--' + key, default='')
    p.add_argument('--timeout-ms', default='600000')
    p.add_argument('--force', action='store_true')
    p.add_argument('--decision', action='store_true')
    a = p.parse_args(argv)
    if not a.question and not a.resume:
        p.error('--question 이나 --resume 중 하나가 필요하다')
    if a.decision and not a.resume:
        problems = decision_problems(a.question)
        if problems:
            for problem in problems:
                print(f'worker-ask: --decision 형식 위반: {problem}', file=sys.stderr)
            return 2
    orca = os.environ.get('ORCA', 'orca')
    def peek():
        return run(orca, 'orchestration', 'check', '--terminal', a.sender, '--peek', '--json').stdout
    if not a.resume and not a.force:
        seen = os.environ.get('ORCH_ASK_SEEN', str(Path(os.environ.get('TMPDIR', '/tmp')) / f'orch-worker-ask-{a.sender}.seen'))
        unread = extract('unread', peek(), '--from', a.sender, '--seen', seen)
        if unread:
            print(unread)
            print('worker-ask: 읽지 않은 코디네이터 메시지가 있어 묻지 않았다. 위 메시지를 읽고도 물어야 하면 같은 명령을 다시 부른다', file=sys.stderr)
            return 5
    args = [orca, 'orchestration', 'ask', '--from', a.sender, '--timeout-ms', a.timeout_ms, '--json']
    args += ['--resume', a.resume] if a.resume else ['--question', a.question]
    if a.options and not a.resume:
        args += ['--options', a.options]
    result = run(*args)
    out = result.stdout + result.stderr
    if re.search(r'"timedOut"\s*:\s*true|timed out', out):
        asked = extract('message-id', out)
        reply = extract('reply', peek(), '--from', a.sender, '--question', asked or a.resume)
        if reply:
            print(f'answer: {reply}\n{out}')
            print('worker-ask: ask 에는 답이 없지만 코디네이터가 status 로 답했다. 첫 줄이 그 본문이다', file=sys.stderr)
            return 3
        print(out)
        print('worker-ask: 시간 제한으로 답을 받지 못했다. 위 출력의 메시지 ID 로 --resume 한다', file=sys.stderr)
        return 4
    if result.returncode == 0:
        print(f'answer: {extract("answer", out)}\n{out}')
        return 0
    print(out, file=sys.stderr)
    if a.resume:
        print('worker-ask: --resume 이 실패했다. 대신 보낼 질문 본문이 없어 멈춘다', file=sys.stderr)
        return 2
    print('worker-ask: ask 가 실패했다. Dispatch 가 끝났을 수 있어 Run 메일함으로 대신 보낸다', file=sys.stderr)
    run_id = a.run or extract('run-id', peek())
    if not run_id:
        print('worker-ask: Run 을 찾지 못했다. --run 으로 준다', file=sys.stderr)
        return 2
    body = a.question + (f'\n선택지: {a.options}' if a.options else '')
    result = run(orca, 'orchestration', 'send', '--from', a.sender, '--to', f'run:{run_id}',
                 '--type', 'question', '--subject', '질문 (ask 대신 보냄)', '--body', body, '--json')
    print(result.stdout, end='')
    print(result.stderr, end='', file=sys.stderr)
    if result.returncode:
        print('worker-ask: 대신 보내기도 실패했다', file=sys.stderr)
        return 2
    print(f'worker-ask: run:{run_id} 으로 보냈다. 답은 orca orchestration check --terminal {a.sender} 로 읽는다', file=sys.stderr)
    return 3


if __name__ == '__main__':
    sys.exit(main())
