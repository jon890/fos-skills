#!/usr/bin/env python3
"""저장소의 작업 현황 파일(board.json)을 고친다. work-board mod 가 이 파일을 읽어 /board 창에 보여 준다.

파일 위치: git 루트의 .omc/board.json. 이미 .omc/handoffs/board.json 이 있으면 그것을 쓴다. --file 로 바꿀 수 있다.

사용:
  board.py set <id> [<status>] [--title T] [--owner O] [--pr P] [--next N] [--worktree W] [--progress N/M] [--detail D ...]
  (--worktree 는 그 항목을 맡은 worker 의 워크트리 이름이다. 창이 그 worker 상태를 항목 아래에 붙인다)
  (값을 '' 로 주면 그 칸을 지운다. --detail 은 여러 번 줄 수 있고 주면 하위 항목 전체를 바꾼다. --detail '' 은 지운다)
  (--next 를 여러 번 주면 줄바꿈으로 잇는다. 「--next '1. 구현' --next '2. 머지'」 가 단계 두 줄이 된다)
  doing 항목은 진행률이 있어야 한다. 단계 줄이나 --progress N/M 이 없으면 set 을 거절하고 보드를 고치지 않는다
  board.py step <id> <n> [--undo]   (n 번 단계 줄을 끝낸 것으로 표시한다. --undo 는 되돌린다)
  board.py steps <id>   (진행률을 세는 단계 줄을 JSON 목록 [{"number", "done", "text"}] 으로 낸다. 보드를 고치지 않는다)
  board.py del <id>
  board.py list   (항목마다 진행률 「n/m (p%)」 를 붙인다)
status: goal(목표) | decide(결정 필요) | doing(진행 중) | wait(대기) | done(완료)
진행률은 단계 줄에서 센다. --progress 는 단계로 나타낼 수 없을 때만 쓴다
  단계 줄은 번호로 시작하는 줄이다. 「1 …」, 「1. …」, 「1) …」 를 모두 단계로 본다. 참고 줄은 세지 않는다
  줄 앞의 「✓」 나 「[x]」 는 끝낸 단계, 「[ ]」, 「▶」, 「◇」 는 끝나지 않은 단계다
  하위 항목(--detail)에 단계 줄이 있으면 그것을 세고, 없으면 --next 의 줄을 센다
  step 은 「[ ]」 로 적은 줄은 「[x]」 로, 그 밖의 줄은 앞에 「✓ 」 를 붙여 끝낸다
  --progress N/M 은 「끝낸 단계/전체 단계」 (예: 7/10) 를 직접 적고 단계 수보다 앞선다. 주지 않으면 기존 값을 지우지 않는다
  --progress auto 는 값을 지워 단계 수로 세게 한다
"""
import argparse, datetime, json, os, re, subprocess, sys

STATUSES = ('goal', 'decide', 'doing', 'wait', 'done')
# 단계 줄: 앞 표시(끝냄 ✓ [x], 안 끝냄 [ ] ▶ ◇)와 번호. hooks/register.js 의 STEP 과 같은 규칙이다
STEP = re.compile(r'^\s*(?:(✓|\[[xX ]\]|▶|◇)\s*)?(\d+)[.)]?\s')
DONE_MARKS = ('✓', '[x]', '[X]')

def parse_step(line):
    """단계 줄이면 (번호, 끝냈는지, 앞 표시)를, 아니면 None 을 돌려준다"""
    m = STEP.match(line)
    return (int(m.group(2)), m.group(1) in DONE_MARKS, m.group(1)) if m else None

def step_source(item):
    """단계를 세는 곳과 그 줄들. 하위 항목에 단계가 있으면 그것을, 없으면 next 의 줄을 쓴다"""
    details = item.get('details') or []
    if any(parse_step(line) for line in details):
        return 'details', list(details)
    lines = str(item.get('next') or '').split('\n')
    if any(parse_step(line) for line in lines):
        return 'next', lines
    return None, []

PROGRESS = re.compile(r'^\s*(\d+)\s*/\s*(\d+)\s*$')

def progress_of(item):
    """(끝낸 단계, 전체 단계). progress 가 N/M 이면 그 값을, 아니면 단계 줄을 센다. 없으면 None"""
    m = PROGRESS.match(str(item.get('progress') or ''))
    if m and int(m.group(2)) > 0:
        return min(int(m.group(1)), int(m.group(2))), int(m.group(2))
    steps = [parse_step(line) for line in step_source(item)[1]]
    steps = [step for step in steps if step]
    return (sum(1 for step in steps if step[1]), len(steps)) if steps else None

def progress_text(item):
    progress = progress_of(item)
    if progress is None:
        return '진행률 없음'
    done, total = progress
    return '%d/%d (%d%%)' % (done, total, round(done * 100 / total))

MISSING_PROGRESS = '''doing 항목에는 진행률이 필요하다: %s
  단계 줄을 적는다: --next '1. 구현' --next '2. 리뷰 반영' --next '3. 머지' (끝낸 단계는 앞에 ✓ 나 [x])
  단계로 나타낼 수 없으면 --progress 끝낸단계/전체단계 (예: --progress 2/5) 를 준다'''

def mark_step(line, done):
    number, finished, mark = parse_step(line)
    if finished == done:
        return line
    if mark in ('[ ]', '[x]', '[X]'):
        return line.replace(mark, '[x]' if done else '[ ]', 1)
    body = re.sub(r'^\s*(✓|▶|◇)\s*', '', line)
    return '✓ ' + body if done else body

def board_path(explicit, cwd=None):
    """보드 파일 경로. orch 의 orch_paths.py 도 이 함수로 기본 위치를 받는다."""
    if explicit:
        return explicit
    try:
        root = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True, stderr=subprocess.DEVNULL, cwd=cwd).strip()
    except Exception:
        root = cwd or os.getcwd()
    legacy = os.path.join(root, '.omc/handoffs/board.json')
    return legacy if os.path.exists(legacy) else os.path.join(root, '.omc/board.json')

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=('set', 'step', 'steps', 'del', 'list'))
    ap.add_argument('id', nargs='?')
    ap.add_argument('status', nargs='?')
    ap.add_argument('--undo', action='store_true')
    for key in ('title', 'owner', 'pr', 'worktree', 'progress'):
        ap.add_argument('--' + key)
    ap.add_argument('--detail', action='append')
    ap.add_argument('--next', action='append')
    ap.add_argument('--file')
    a = ap.parse_args()
    if a.next is not None:
        a.next = '\n'.join(line for line in a.next if line)
    if a.progress not in (None, '', 'auto') and not PROGRESS.match(a.progress):
        sys.exit('--progress 는 끝낸단계/전체단계 (예: 2/5) 나 auto 다: ' + a.progress)
    path = board_path(a.file)
    board = json.load(open(path)) if os.path.exists(path) else {'items': []}
    if a.cmd == 'list':
        for item in board['items']:
            print(item.get('status', '?').ljust(7), item['id'].ljust(16), item.get('title', ''), ' ', progress_text(item))
        return
    if not a.id:
        sys.exit('id 가 필요하다')
    if a.cmd == 'steps':
        item = next((i for i in board['items'] if i['id'] == a.id), None)
        if item is None:
            sys.exit('항목이 없다: ' + a.id)
        steps = [(parse_step(line), line) for line in step_source(item)[1]]
        print(json.dumps([{'number': step[0], 'done': step[1], 'text': line} for step, line in steps if step],
                         ensure_ascii=False))
        return
    if a.cmd == 'step':
        item = next((i for i in board['items'] if i['id'] == a.id), None)
        if item is None:
            sys.exit('항목이 없다: ' + a.id)
        if not (a.status or '').isdigit():
            sys.exit('step 에는 단계 번호가 필요하다')
        number = int(a.status)
        source, lines = step_source(item)
        for index, line in enumerate(lines):
            step = parse_step(line)
            if step and step[0] == number:
                lines[index] = mark_step(line, not a.undo)
                break
        else:
            sys.exit('%d 번 단계 줄이 없다. 단계 줄은 --detail 이나 --next 의 「%d …」, 「%d. …」 로 시작하는 줄이다' % (number, number, number))
        item[source] = lines if source == 'details' else '\n'.join(lines)
    elif a.cmd == 'del':
        board['items'] = [i for i in board['items'] if i['id'] != a.id]
    else:
        item = next((i for i in board['items'] if i['id'] == a.id), None)
        if item is None:
            if not a.status:
                sys.exit('새 항목에는 status 가 필요하다')
            item = {'id': a.id, 'title': a.title or a.id}
            board['items'].append(item)
        if a.status:
            if a.status not in STATUSES:
                sys.exit('status 는 %s 중 하나다' % '|'.join(STATUSES))
            item['status'] = a.status
        for key in ('title', 'owner', 'pr', 'next', 'worktree', 'progress'):
            value = getattr(a, key)
            if value == '' or (key == 'progress' and value == 'auto'):
                item.pop(key, None)
            elif value is not None:
                item[key] = value
        if a.detail is not None:
            lines = [d for d in a.detail if d]
            if lines:
                item['details'] = lines
            else:
                item.pop('details', None)
        if item.get('status') == 'doing' and progress_of(item) is None:
            sys.exit(MISSING_PROGRESS % a.id)
    board['updatedAt'] = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(board, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)

if __name__ == '__main__':
    main()
