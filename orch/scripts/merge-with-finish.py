#!/usr/bin/env python3
"""머지 큐를 걸면서 PR 마다 머지 뒤 마무리(`finish-pr.py`)도 함께 건다.

머지 큐만 걸면 머지 뒤의 worker 정리, 배포 확인, 업무 완료, 보드 갱신이 코디네이터의 기억에 달린다.
이 스크립트가 그 일을 기본 절차로 만든다. 사용자가 말하지 않아도 머지 큐는 이 스크립트로 건다.

사용법:
    merge-with-finish.py [래퍼 옵션] [merge-queue.sh 옵션] PR[!][:머지 전 명령] ...

    1. PR 마다 `finish-pr.py` 를 백그라운드로 시작한다. 출력은 <로그 폴더>/finish-<PR>.out 이다.
       그 PR 의 마무리가 이미 돌고 있으면(<로그 폴더>/finish-<PR>.pid 의 프로세스가 살아 있으면) 새로 시작하지 않는다.
       머지 큐가 STOP 으로 멈춘 뒤 남은 PR 만 다시 걸어도 마무리가 겹치지 않는다
    2. `merge-queue.sh` 를 같은 인자로 이 프로세스 안에서 돌리고 그 종료 코드로 끝난다.
       오래 걸리므로 Bash 도구의 run_in_background 로 건다. 셸의 `&` 나 nohup 은 쓰지 않는다

    PR 번호 뒤의 `!` 는 그 PR 이 업무의 마지막 PR 이라는 뜻이다. 그 PR 의 마무리는 배포가 성공한 뒤
    업무를 완료 처리한다(`finish-pr.py --complete`). 예: 449! , 446!:'./bin/backup-db.sh orders "pre-446"'
    `!` 와 `:명령` 은 PR 번호 바로 뒤에 `번호[!][:명령]` 순서로 쓴다. 머지 큐에는 `!` 를 뗀 인자가 넘어간다.

래퍼 옵션 (merge-queue.sh 에는 넘기지 않는다):
    --finish-config FILE    finish-pr.py 의 --config. 없으면 finish-pr.py 가 <repo>/.claude/orch-finish.json 을 찾는다
    --finish-arg ARG        finish-pr.py 에 더 넘길 인자. 하나씩 준다. 값이 `--` 로 시작하면 `--finish-arg=--run` 처럼 쓴다
    --board-item PR=ID      그 PR 의 마무리가 done 으로 바꿀 보드 항목(`finish-pr.py --board-id`). PR 마다 준다
    --finish-log-dir DIR    마무리 출력과 pid 폴더. 기본 <repo>/.omc/handoffs/queue. handoff-cleanup.py 가 이 폴더의 끝난 로그를 옮긴다
    --no-finish             마무리를 걸지 않고 머지 큐만 돌린다

merge-queue.sh 옵션은 그대로 쓴다(--repo, --required, --require-up-to-date 같은 것). --repo 는 마무리에도 넘어간다.

머지 큐 기본값: --finish-config 파일(없으면 <repo>/.claude/orch-finish.json)의 `queue` 절을 읽어
명령줄에 없는 머지 큐 옵션을 채운다. 키는 before, required, verify_merged, verify_merged_when, docs_glob, method,
after_merged 이고 각각 --before, --required, --verify-merged, --verify-merged-when, --docs-glob, --method,
--after-merged 가 된다. required 와 docs_glob 은 문자열 목록도 받아 쉼표로 잇는다.
skipped_is_missing 과 update_docs_on_overlap 은 true 면 같은 이름의 옵션을 붙이는 참거짓 값이다.
명령줄에 준 옵션이 우선한다. 모르는 키가 있으면 사용법 오류다.
저장소마다 같은 옵션을 매번 옮겨 적다 빠뜨리는 일을 막는다.
MERGE_QUEUE, FINISH_PR 환경 변수로 두 스크립트 경로를 바꾼다.

종료 코드: merge-queue.sh 의 종료 코드. 2 는 사용법 오류이기도 하다
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MERGE_QUEUE = os.environ.get("MERGE_QUEUE", str(HERE / "merge-queue.sh"))
FINISH_PR = os.environ.get("FINISH_PR", str(HERE / "finish-pr.py"))
# merge-queue.sh 가 값을 받는 옵션. 값이 숫자여도 PR 번호로 읽지 않으려고 안다. tests 가 merge-queue.sh 와 맞는지 본다
VALUE_OPTIONS = {"--repo", "--before", "--method", "--threads-cmd", "--check-timeout", "--required", "--allow-fail",
                 "--verify-merged", "--verify-merged-when", "--docs-glob", "--copy-dir", "--sweep-arg", "--after-merged"}
DEFAULT_CONFIG = ".claude/orch-finish.json"
# orch-finish.json 의 queue 절 키와 머지 큐 옵션
QUEUE_KEYS = {"before": "--before", "required": "--required", "verify_merged": "--verify-merged",
              "verify_merged_when": "--verify-merged-when", "docs_glob": "--docs-glob", "method": "--method",
              "after_merged": "--after-merged"}
# queue 절의 참거짓 키와 값 없는 머지 큐 옵션
QUEUE_FLAGS = {"skipped_is_missing": "--skipped-is-missing", "update_docs_on_overlap": "--update-docs-on-overlap"}
SPEC = re.compile(r"(\d+)(!?)(:.*)?$", re.S)


def parse_queue_spec(arg):
    """`번호[!][:머지 전 명령]` 을 (번호, 마지막 PR 인지, 머지 큐에 넘길 인자) 로 나눈다. PR 인자가 아니면 None 이다."""
    found = SPEC.match(arg)
    if not found:
        return None
    number, bang, rest = found.groups()
    return number, bool(bang), number + (rest or "")


def split_args(argv):
    """(래퍼 옵션 dict, merge-queue.sh 인자 목록, [(PR, 마지막 PR 인지)]). 모르는 래퍼 옵션이면 ValueError."""
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


def queue_defaults(wrapper, queue):
    """설정 파일의 queue 절에서 명령줄에 없는 머지 큐 옵션을 만든다. 파일이나 절이 잘못됐으면 ValueError."""
    path = Path(wrapper["finish_config"]) if wrapper["finish_config"] else Path(wrapper["repo"]) / DEFAULT_CONFIG
    if not path.is_file():
        return []
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"설정 파일을 읽지 못했다: {path}: {exc}") from exc
    section = config.get("queue", {}) if isinstance(config, dict) else None
    if not isinstance(section, dict):
        raise ValueError(f"{path} 의 \"queue\" 절은 객체여야 한다")
    unknown = sorted(set(section) - set(QUEUE_KEYS) - set(QUEUE_FLAGS))
    if unknown:
        raise ValueError(f"{path} 의 queue 절에 모르는 키가 있다: {', '.join(unknown)}")
    given, extra = given_options(queue), []
    for key, option in QUEUE_KEYS.items():
        if key not in section or option in given:
            continue
        value = section[key]
        if isinstance(value, list) and key in ("required", "docs_glob") and all(isinstance(v, str) for v in value):
            value = ",".join(value)
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
    return extra


def finish_running(pid_file):
    try:
        pid = int(pid_file.read_text().strip())
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


def start_finish(wrapper, number, complete):
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
    cmd += ["--board-id", wrapper["board_items"][number]] if number in wrapper["board_items"] else []
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
        queue = queue_defaults(wrapper, queue) + queue
    except ValueError as exc:
        print(f"merge-with-finish: {exc}", file=sys.stderr)
        return 2
    if not wrapper["no_finish"]:
        for number, complete in prs:
            start_finish(wrapper, number, complete)
    return subprocess.run(["bash", MERGE_QUEUE, *queue]).returncode


if __name__ == "__main__":
    sys.exit(main())
