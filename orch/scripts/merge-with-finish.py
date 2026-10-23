#!/usr/bin/env python3
"""머지 큐를 걸면서 PR 마다 머지 뒤 마무리(`finish-pr.py`)도 함께 건다.

머지 큐만 걸면 머지 뒤의 worker 정리, 배포 확인, 업무 완료, 보드 갱신이 코디네이터의 기억에 달린다.
이 스크립트가 그 일을 기본 절차로 만든다. 사용자가 말하지 않아도 머지 큐는 이 스크립트로 건다.

사용법:
    merge-with-finish.py [래퍼 옵션] [merge_queue.py 옵션] PR[!][:머지 전 명령] ...

    1. PR 마다 `finish-pr.py` 를 백그라운드로 시작한다. 출력은 <로그 폴더>/finish-<PR>.out 이다.
       그 PR 의 마무리가 이미 돌고 있으면(<로그 폴더>/finish-<PR>.pid 의 프로세스가 살아 있으면) 새로 시작하지 않는다.
       머지 큐가 STOP 으로 멈춘 뒤 남은 PR 만 다시 걸어도 마무리가 겹치지 않는다
    2. `merge_queue.py` 를 같은 인자로 이 프로세스 안에서 돌리고 그 종료 코드로 끝난다.
       오래 걸리므로 Bash 도구의 run_in_background 로 건다. 셸의 `&` 나 nohup 은 쓰지 않는다

    PR 번호 뒤의 `!` 는 그 PR 이 업무의 마지막 PR 이라는 뜻이다. 그 PR 의 마무리는 배포가 성공한 뒤
    업무를 완료 처리한다(`finish-pr.py --complete`). 예: 449! , 446!:'./bin/backup-db.sh orders "pre-446"'
    업무 완료 명령(`complete_cmd`)이 설정에 없는 저장소에서는 업무 완료만 건너뛰고 그 PR 의 지시서를 지운다.
    `!` 와 `:명령` 은 PR 번호 바로 뒤에 `번호[!][:명령]` 순서로 쓴다. 머지 큐에는 `!` 를 뗀 인자가 넘어간다.

래퍼 옵션 (merge_queue.py 에는 넘기지 않는다):
    --finish-config FILE    finish-pr.py 의 --config. 없으면 finish-pr.py 가 <repo>/.claude/orch-finish.json 을 찾는다
    --finish-arg ARG        finish-pr.py 에 더 넘길 인자. 하나씩 준다. 값이 `--` 로 시작하면 `--finish-arg=--run` 처럼 쓴다
    --board-item PR=ID      그 PR 의 마무리가 done 으로 바꿀 보드 항목(`finish-pr.py --board-id`). PR 마다 준다.
                            주지 않으면 보드 파일에서 `pr` 필드에 그 PR 이 든 항목을 찾아 쓴다(아래 「보드 항목」)
    --finish-log-dir DIR    마무리 출력과 pid 폴더. 기본 <repo>/.omc/handoffs/queue. handoff-cleanup.py 가 이 폴더의 끝난 로그를 옮긴다
    --no-finish             마무리를 걸지 않고 머지 큐만 돌린다

merge_queue.py 옵션은 그대로 쓴다(--repo, --required, --require-up-to-date 같은 것). --repo 는 마무리에도 넘어간다.

머지 큐 기본값: --finish-config 파일(없으면 <repo>/.claude/orch-finish.json)의 `queue` 절을 읽어
명령줄에 없는 머지 큐 옵션을 채운다. 키는 before, required, verify_merged, verify_merged_when, docs_glob, method,
after_merged, up_to_date_when, shared_paths, unit_prefix 이고 각각 --before, --required, --verify-merged,
--verify-merged-when, --docs-glob, --method, --after-merged, --up-to-date-when, --shared-paths, --unit-prefix 가 된다.
required 와 docs_glob 은 문자열 목록도 받아 쉼표로 잇고, shared_paths 는 정규식 목록도 받아 `|` 로 잇는다.
skipped_is_missing, update_docs_on_overlap, require_up_to_date 는 true 면 같은 이름의 옵션을 붙이는 참거짓 값이다.
unit_groups 는 단위 이름 목록의 목록이고 안쪽 목록마다 `--unit-group a,b` 가 된다.
sweep_args 는 문자열 목록이고 항목마다 `--sweep-arg` 로 넘어간다. 명령줄에 `--sweep-arg` 가 하나라도 있으면 목록은 쓰지 않는다.
명령줄에 준 옵션이 우선한다. 모르는 키가 있으면 사용법 오류다.
저장소마다 같은 옵션을 매번 옮겨 적다 빠뜨리는 일을 막는다.
MERGE_QUEUE, FINISH_PR 환경 변수로 두 스크립트 경로를 바꾼다.

보드 항목: 보드 파일은 --finish-arg 의 `--board`, 없으면 설정 파일 `finish` 절의 `board`, 없으면 finish-pr.py 와 같은 기본
(<repo>/.omc/handoffs/board.json, 없으면 <repo>/.omc/board.json) 이다. 항목의 `pr` 필드을 쉼표로 나눠 숫자만 보고 그 PR 과 같은 항목을 찾는다.
**업무의 마지막 PR(`!`)일 때만 그 항목을 done 으로 바꾼다.** 중간 PR 이 항목을 끝내지 않도록 `!` 가 없으면 찾은 항목을 알리기만 한다.
같은 PR 이 든 항목이 둘 이상이면 어느 것인지 알 수 없어 건너뛴다. `--board-item` 으로 준 항목은 `!` 와 상관없이 쓴다.

종료 코드: merge_queue.py 의 종료 코드. 2 는 사용법 오류이기도 하다
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MERGE_QUEUE = os.environ.get("MERGE_QUEUE", str(HERE / "merge_queue.py"))
FINISH_PR = os.environ.get("FINISH_PR", str(HERE / "finish-pr.py"))
# merge_queue.py 가 값을 받는 옵션. 값이 숫자여도 PR 번호로 읽지 않으려고 안다. tests 가 merge_queue.py 와 맞는지 본다
VALUE_OPTIONS = {"--repo", "--before", "--method", "--threads-cmd", "--check-timeout", "--required", "--allow-fail",
                 "--verify-merged", "--verify-merged-when", "--docs-glob", "--copy-dir", "--sweep-arg", "--after-merged",
                 "--up-to-date-when", "--shared-paths", "--unit-prefix", "--unit-group"}
DEFAULT_CONFIG = ".claude/orch-finish.json"
# orch-finish.json 의 queue 절 키와 머지 큐 옵션
QUEUE_KEYS = {"before": "--before", "required": "--required", "verify_merged": "--verify-merged",
              "verify_merged_when": "--verify-merged-when", "docs_glob": "--docs-glob", "method": "--method",
              "after_merged": "--after-merged", "up_to_date_when": "--up-to-date-when", "shared_paths": "--shared-paths",
              "unit_prefix": "--unit-prefix"}
# 문자열 목록도 받는 키와 목록을 잇는 구분자
QUEUE_LISTS = {"required": ",", "docs_glob": ",", "shared_paths": "|"}
# queue 절의 참거짓 키와 값 없는 머지 큐 옵션
QUEUE_FLAGS = {"skipped_is_missing": "--skipped-is-missing", "update_docs_on_overlap": "--update-docs-on-overlap",
               "require_up_to_date": "--require-up-to-date"}
# queue 절의 문자열 목록 키. 항목마다 같은 옵션을 한 번씩 붙인다
QUEUE_REPEATED = {"sweep_args": "--sweep-arg"}
# queue 절의 묶음 목록 키. 안쪽 목록 하나가 `--unit-group a,b` 하나가 된다
QUEUE_GROUPS = {"unit_groups": "--unit-group"}
SPEC = re.compile(r"(\d+)(!?)(:.*)?$", re.S)


def parse_queue_spec(arg):
    """`번호[!][:머지 전 명령]` 을 (번호, 마지막 PR 인지, 머지 큐에 넘길 인자) 로 나눈다. PR 인자가 아니면 None 이다."""
    found = SPEC.match(arg)
    if not found:
        return None
    number, bang, rest = found.groups()
    return number, bool(bang), number + (rest or "")


def split_args(argv):
    """(래퍼 옵션 dict, merge_queue.py 인자 목록, [(PR, 마지막 PR 인지)]). 모르는 래퍼 옵션이면 ValueError."""
    wrapper = {"finish_config": None, "finish_arg": [], "log_dir": None, "no_finish": False, "board_items": {}}
    queue, prs, repo = [], [], "."
    i = 0
    while i < len(argv):
        arg = argv[i]
        name, eq, inline = arg.partition("=")
        if name in ("--finish-config", "--finish-arg", "--finish-log-dir"):
            if eq:
                value = inline
            elif i + 1 < len(argv):
                i += 1
                value = argv[i]
            else:
                raise ValueError(f"{name} 에 값이 없다")
            key = {"--finish-config": "finish_config", "--finish-arg": "finish_arg", "--finish-log-dir": "log_dir"}[name]
            if key == "finish_arg":
                wrapper[key].append(value)
            else:
                wrapper[key] = value
        elif name == "--board-item":
            value = inline if eq else (argv[i + 1] if i + 1 < len(argv) else "")
            i += 0 if eq else 1
            number, sep, item = value.partition("=")
            if not (number.isdigit() and sep and item):
                raise ValueError("--board-item 은 PR번호=항목id 형식이다")
            wrapper["board_items"][number] = item
        elif arg == "--no-finish":
            wrapper["no_finish"] = True
        elif arg in VALUE_OPTIONS:
            if i + 1 >= len(argv):
                raise ValueError(f"{arg} 에 값이 없다")
            queue += [arg, argv[i + 1]]
            if arg == "--repo":
                repo = argv[i + 1]
            i += 1
        elif arg.startswith("-"):
            queue.append(arg)
        else:
            spec = parse_queue_spec(arg)
            if spec is None:
                raise ValueError(f"PR 번호가 아니다: {arg}")
            prs.append((spec[0], spec[1]))
            queue.append(spec[2])
        i += 1
    wrapper["repo"] = repo
    return wrapper, queue, prs


def given_options(queue):
    """머지 큐 인자 가운데 명령줄에 준 옵션 이름. 값 자리는 세지 않는다."""
    given, skip = set(), False
    for arg in queue:
        if skip:
            skip = False
        elif arg.startswith("-"):
            given.add(arg)
            skip = arg in VALUE_OPTIONS
    return given


def load_config(wrapper):
    """설정 파일 전체. 파일이 없으면 빈 객체이고, 읽지 못했거나 객체가 아니면 ValueError."""
    path = Path(wrapper["finish_config"]) if wrapper["finish_config"] else Path(wrapper["repo"]) / DEFAULT_CONFIG
    if not path.is_file():
        return {}
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"설정 파일을 읽지 못했다: {path}: {exc}") from exc
    if not isinstance(config, dict):
        raise ValueError(f"{path} 의 최상위는 객체여야 한다")
    wrapper["config_path"] = path
    return config


def queue_defaults(wrapper, queue, config):
    """설정의 queue 절에서 명령줄에 없는 머지 큐 옵션을 만든다. 절이 잘못됐으면 ValueError."""
    path = wrapper.get("config_path")
    section = config.get("queue", {})
    if not isinstance(section, dict):
        raise ValueError(f"{path} 의 \"queue\" 절은 객체여야 한다")
    unknown = sorted(set(section) - set(QUEUE_KEYS) - set(QUEUE_FLAGS) - set(QUEUE_REPEATED) - set(QUEUE_GROUPS))
    if unknown:
        raise ValueError(f"{path} 의 queue 절에 모르는 키가 있다: {', '.join(unknown)}")
    given, extra = given_options(queue), []
    for key, option in QUEUE_KEYS.items():
        if key not in section or option in given:
            continue
        value = section[key]
        if isinstance(value, list) and key in QUEUE_LISTS and all(isinstance(v, str) for v in value):
            value = QUEUE_LISTS[key].join(value)
        if not isinstance(value, str) or not value:
            raise ValueError(f"{path} 의 queue.{key} 는 비지 않은 문자열이어야 한다")
        extra += [option, value]
    for key, option in QUEUE_FLAGS.items():
        if key not in section or option in given:
            continue
        if not isinstance(section[key], bool):
            raise ValueError(f"{path} 의 queue.{key} 는 true 나 false 여야 한다")
        if section[key]:
            extra.append(option)
    for key, option in QUEUE_REPEATED.items():
        if key not in section:
            continue
        values = section[key]
        if not isinstance(values, list) or not all(isinstance(v, str) and v for v in values):
            raise ValueError(f"{path} 의 queue.{key} 는 비지 않은 문자열 목록이어야 한다")
        if option not in given:
            for value in values:
                extra += [option, value]
    for key, option in QUEUE_GROUPS.items():
        if key not in section:
            continue
        groups = section[key]
        if not (isinstance(groups, list) and groups and all(
                isinstance(g, list) and len(g) >= 2 and all(isinstance(m, str) and m and "," not in m for m in g)
                for g in groups)):
            raise ValueError(f"{path} 의 queue.{key} 는 단위 이름이 둘 이상인 문자열 목록의 목록이어야 한다")
        if option not in given:
            for members in groups:
                extra += [option, ",".join(members)]
    return extra


def board_file(wrapper, config):
    """마무리가 보드를 고칠 때 쓰는 파일. finish-pr.py 와 같은 순서로 정한다."""
    repo = Path(wrapper["repo"])
    given = None
    for i, arg in enumerate(wrapper["finish_arg"]):
        if arg == "--board" and i + 1 < len(wrapper["finish_arg"]):
            given = wrapper["finish_arg"][i + 1]
        elif arg.startswith("--board="):
            given = arg.partition("=")[2]
    finish = config.get("finish")
    configured = finish.get("board") if isinstance(finish, dict) else None
    given = given or (configured if isinstance(configured, str) else None)
    if given:
        return repo / given
    nested = repo / ".omc/handoffs/board.json"
    return nested if nested.exists() else repo / ".omc/board.json"


def pr_numbers(field):
    """보드 항목의 pr 필드(`#492`, `492, 495`)에 든 PR 번호들."""
    return set(re.findall(r"(?<!\w)#?(\d+)(?!\w)", str(field or "")))


def board_items_for(board, number):
    """보드 파일에서 pr 필드에 그 PR 이 든 항목 id 목록. 보드가 없거나 읽지 못하면 빈 목록이다."""
    try:
        items = json.loads(board.read_text(encoding="utf-8")).get("items", [])
    except (OSError, ValueError, AttributeError):
        return []
    return [i["id"] for i in items if isinstance(i, dict) and i.get("id") and number in pr_numbers(i.get("pr"))]


def pick_board_item(wrapper, config, number, complete):
    """이 PR 의 마무리가 done 으로 바꿀 보드 항목 id. 없으면 None. 알릴 말이 있으면 출력한다."""
    if number in wrapper["board_items"]:
        return wrapper["board_items"][number]
    found = board_items_for(board_file(wrapper, config), number)
    if len(found) > 1:
        print(f"보드 항목이 둘 이상이라 건너뛴다: PR {number} -> {', '.join(found)}", flush=True)
    elif found and not complete:
        print(f"보드 항목 {found[0]} 는 PR {number} 가 업무의 마지막 PR(!)이 아니라 done 으로 바꾸지 않는다", flush=True)
    elif found:
        return found[0]
    return None


def finish_running(pid_file):
    try:
        pid = int(pid_file.read_text().strip())
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


def start_finish(wrapper, number, complete, config):
    repo = Path(wrapper["repo"]).resolve()
    log_dir = Path(wrapper["log_dir"]) if wrapper["log_dir"] else repo / ".omc/handoffs/queue"
    log_dir.mkdir(parents=True, exist_ok=True)
    pid_file = log_dir / f"finish-{number}.pid"
    if finish_running(pid_file):
        print(f"마무리는 이미 돌고 있다: PR {number} ({pid_file})", flush=True)
        return
    cmd = [sys.executable, FINISH_PR, number, "--repo", str(repo), "--pid-file", str(pid_file)]
    cmd += ["--config", wrapper["finish_config"]] if wrapper["finish_config"] else []
    cmd += ["--complete"] if complete else []
    board_id = pick_board_item(wrapper, config, number, complete)
    cmd += ["--board-id", board_id] if board_id else []
    cmd += wrapper["finish_arg"]
    out = log_dir / f"finish-{number}.out"
    with open(out, "w") as sink:
        subprocess.Popen(cmd, stdout=sink, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    print(f"마무리 시작: PR {number}{' (업무의 마지막 PR)' if complete else ''} -> {out}", flush=True)


def main(argv=None):
    try:
        wrapper, queue, prs = split_args(sys.argv[1:] if argv is None else argv)
    except ValueError as exc:
        print(f"merge-with-finish: {exc}", file=sys.stderr)
        return 2
    if not prs:
        print(__doc__)
        return 2
    try:
        config = load_config(wrapper)
        queue = queue_defaults(wrapper, queue, config) + queue
    except ValueError as exc:
        print(f"merge-with-finish: {exc}", file=sys.stderr)
        return 2
    if not wrapper["no_finish"]:
        for number, complete in prs:
            start_finish(wrapper, number, complete, config)
    runner = [sys.executable] if MERGE_QUEUE.endswith(".py") else ["bash"]
    return subprocess.run([*runner, MERGE_QUEUE, *queue]).returncode


if __name__ == "__main__":
    sys.exit(main())
