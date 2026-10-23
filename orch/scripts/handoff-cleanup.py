#!/usr/bin/env python3
"""orch 작업 폴더에 남은 끝난 산출물을 휴지통 폴더로 옮긴다. 지우지 않으므로 되살릴 수 있다.

기본은 옮길 후보만 보인다. `--apply` 를 주면 옮긴다. 몇 번을 돌려도 같은 상태에서는 같은 결과다.

사용법:
    handoff-cleanup.py [--repo DIR] [--config FILE] [--apply] [옵션...]

옮기는 것 (<orch> 는 orch 작업 폴더다. orch_paths.py 가 정한다):
    - <orch>/queue/*.out: QUEUE-DONE, STOP, FINISH-DONE, FINISH-FAIL 중 하나로 끝났고 --queue-days 일 넘게 지난 로그
    - <orch>/specs/spec-*.md: 아래가 모두 참인 지시서. spec-common.md 는 남긴다
        · 지시서의 `보드 항목 id: \\`x\\`` 항목이 보드에서 done 이다. 보드에 항목이 없거나 done 이 아니면
          아직 쓰는 지시서다(띄우기 전, PR 이 여럿인 일의 중간). 그 줄이 없는 지시서는 이 조건을 건너뛴다
        · 지시서의 `브랜치:` 가 원격과 워크트리에 없고 그 브랜치의 열린 PR 도 없다
        · 열린 PR 목록을 읽지 못하면 아무것도 옮기지 않는다
        · 살아 있는 dispatch 의 `--spec` 줄이 가리키는 지시서가 아니다(`live_specs.py`). 그 목록을 읽지 못해도
          아무것도 옮기지 않는다. 브랜치가 모두 머지됐다는 이유로 아직 일하는 worker 의 지시서를 옮긴 일이 있었다
    - <orch>/<폴더>: --folder-days 일 넘게 바뀌지 않았고, 보드 파일에 이름이 없고 <orch>/.keep 에도 없는 폴더
      (bin, queue, specs, state 는 건드리지 않는다)
    - <previews>/<폴더나 파일>: --previews 를 줄 때만 본다. 조건은 위와 같고 남길 이름은 <previews>/.keep 에 적는다.
      미리보기는 content-preview 의 산출물이라 기본으로는 보지 않는다
    - <orch> 아래 --data-ext 확장자 파일(기본 csv, tsv) 중 --data-days 일 넘게 지난 것. bin 폴더 안은 뺀다
      (DB 에서 뽑은 원본은 쓰고 나서 지운다)

남길 폴더는 .keep 에 한 줄에 하나씩 이름을 적는다.
휴지통 안에서는 <휴지통>/<그 폴더 이름>/<상대 경로> 로 두고, 같은 이름이 있으면 번호를 붙여 덮어쓰지 않는다.

옵션 (저장소마다 다른 값이다. --config 의 JSON 키는 옵션 이름의 하이픈을 밑줄로 바꾼 것이다):
    --repo DIR         대상 저장소. 기본은 현재 디렉터리. git 과 gh 를 여기서 돌린다
    --config FILE      옵션 값을 담은 JSON. 「cleanup」 절을 읽는다. 없으면 <orch>/config.json 이 있을 때 쓴다. 명령줄이 우선한다
    --gh-host HOST     gh 에 줄 GH_HOST
    --run RUN          살아 있는 dispatch 를 찾을 Orca Run. 없으면 코디네이터에 묶인 Run 이다
    --orch-dir DIR     orch 작업 폴더. 기본은 orch_paths.py 가 정한 곳(<주 checkout>/.orch). 상대경로면 주 checkout 기준
    --previews DIR     미리보기 폴더. 주지 않으면 보지 않는다. 상대경로면 주 checkout 기준
    --board FILE       보드 파일. 기본은 work-board 의 board.py 가 정한 위치. 상대경로면 주 checkout 기준
    --trash DIR        휴지통 폴더. 기본 ~/.Trash/orch-cleanup-<날짜>
    --queue-days N     기본 1
    --folder-days N    기본 3
    --data-days N      기본 1
    --data-ext LIST    쉼표로 이은 확장자. 기본 csv,tsv
    --apply            실제로 옮긴다

GH, GIT, ORCA 환경 변수로 실행 파일을 바꾼다.

종료 코드: 0 돌았다(후보가 없어도 0), 2 사용법 오류이거나 orch 작업 폴더를 옮기기 전이다(orch_paths.py 「옛 구조」)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

GH = os.environ.get("GH", "gh")
GIT = os.environ.get("GIT", "git")
ORCA = os.environ.get("ORCA", "orca")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_specs import live_spec_paths  # noqa: E402
import orch_paths  # noqa: E402
QUEUE_DONE = re.compile(r"QUEUE-DONE|^STOP|FINISH-DONE|FINISH-FAIL", re.M)
BRANCH_LINE = re.compile(r"^\s*(?:[-*]\s+)?(?:\*\*)?브랜치:(?:\*\*)?\s*`([^`]+)`", re.M)
BOARD_ID_LINE = re.compile(r"^\s*(?:[-*]\s+)?(?:\*\*)?보드 항목 id:(?:\*\*)?\s*`([^`]+)`", re.M)
RESERVED = {"bin", "queue", "specs", "state"}
DAY = 86400


# ---- 판정 (순수 함수) ----------------------------------------------------------------------------------

def is_old(mtime, now, days):
    return now - mtime > days * DAY


def queue_log_finished(text):
    """로그의 마지막 3줄에 끝 표시가 있는지."""
    return bool(QUEUE_DONE.search("\n".join(text.rstrip("\n").splitlines()[-3:])))


def board_statuses(board_text):
    """보드 JSON 에서 {id: status}. items 는 목록이나 id 로 묶은 객체다. 읽지 못하면 빈 dict 다."""
    try:
        items = json.loads(board_text)["items"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return {}
    items = list(items.values()) if isinstance(items, dict) else items
    return {i["id"]: i.get("status") for i in items if isinstance(i, dict) and "id" in i}


def spec_finished(text, statuses, open_heads, remote_has, worktree_has):
    """지시서가 끝난 작업의 것인지. remote_has, worktree_has 는 브랜치 이름을 받는 함수다."""
    branch = BRANCH_LINE.search(text)
    if not branch:
        return False
    branch = branch.group(1)
    board_id = BOARD_ID_LINE.search(text)
    if board_id and statuses.get(board_id.group(1)) != "done":
        return False
    if branch in open_heads:
        return False
    return not remote_has(branch) and not worktree_has(branch)


def referenced(name, board_text, keep_lines):
    """보드 파일 본문에 이름이 들어 있거나 .keep 에 한 줄로 적혀 있는지."""
    return name in board_text or name in keep_lines


def drop_nested(candidates):
    """다른 후보 안에 든 후보는 뺀다. 폴더를 옮기면 그 안의 파일은 함께 가기 때문이다."""
    ordered = sorted(set(candidates), key=lambda p: len(p.parts))
    kept = []
    for path in ordered:
        if not any(parent in path.parents for parent in kept):
            kept.append(path)
    return kept


def unique_dest(dest):
    if not dest.exists():
        return dest
    n = 2
    while dest.with_name(f"{dest.name}.{n}").exists():
        n += 1
    return dest.with_name(f"{dest.name}.{n}")


# ---- 수집 ----------------------------------------------------------------------------------------------

def run(cmd, cwd):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""
    return done.returncode, done.stdout


def open_pr_heads(repo):
    """열린 PR 의 head 브랜치 집합. 읽지 못하면 None 이다."""
    code, out = run([GH, "pr", "list", "--state", "open", "--limit", "200", "--json", "headRefName"], repo)
    if code != 0:
        return None
    try:
        return {p["headRefName"] for p in json.loads(out)}
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def keep_names(folder):
    keep_file = folder / ".keep"
    return {l.strip() for l in keep_file.read_text(encoding="utf-8").splitlines()} if keep_file.is_file() else set()


def candidates(args, repo, now):
    orch, previews = args.orch_dir, args.previews
    found = []
    queue = orch / "queue"
    for log in sorted(queue.glob("*.out")) if queue.is_dir() else []:
        try:
            if is_old(log.stat().st_mtime, now, args.queue_days) and queue_log_finished(
                    log.read_text(encoding="utf-8", errors="replace")):
                found.append(log)
        except OSError:
            continue

    board_text = args.board.read_text(encoding="utf-8") if args.board.is_file() else ""
    statuses = board_statuses(board_text)
    specs = sorted((orch / "specs").glob("spec-*.md")) if (orch / "specs").is_dir() else []
    specs = [s for s in specs if s.name != "spec-common.md"]
    heads = open_pr_heads(repo) if specs else set()
    live = live_spec_paths(ORCA, args.run) if specs else set()
    if heads is None:
        print("gh 로 열린 PR 을 읽지 못해 지시서는 옮기지 않는다", file=sys.stderr)
    elif live is None:
        print("orca 로 살아 있는 dispatch 의 지시서를 읽지 못해 지시서는 옮기지 않는다", file=sys.stderr)
    elif specs:
        _, worktrees = run([GIT, "worktree", "list"], repo)
        for spec in specs:
            text = spec.read_text(encoding="utf-8", errors="replace")
            remote_has = lambda b: run([GIT, "ls-remote", "--exit-code", "--heads", "origin", b], repo)[0] == 0
            worktree_has = lambda b: f"[{b}]" in worktrees
            if os.path.realpath(spec) in live:
                print(f"살아 있는 dispatch 가 쓰는 지시서라 남긴다: {spec.relative_to(orch)}", file=sys.stderr)
            elif spec_finished(text, statuses, heads, remote_has, worktree_has):
                found.append(spec)

    entries = [(p, orch) for p in sorted(orch.iterdir()) if p.is_dir() and p.name not in RESERVED] if orch.is_dir() else []
    if previews and previews.is_dir():
        entries += [(p, previews) for p in sorted(previews.iterdir()) if p.name != ".keep"]
    keep = {root: keep_names(root) for root in {orch, previews} if root}
    for entry, root in entries:
        if is_old(entry.stat().st_mtime, now, args.folder_days) and not referenced(entry.name, board_text, keep[root]):
            found.append(entry)

    if orch.is_dir():
        for path in sorted(orch.rglob("*")):
            if path.is_file() and path.suffix.lower().lstrip(".") in args.data_ext and "bin" not in path.relative_to(orch).parts[:-1]:
                if is_old(path.stat().st_mtime, now, args.data_days):
                    found.append(path)
    return drop_nested(found)


def move(path, root, trash, apply):
    rel = Path(root.name) / path.relative_to(root)
    if not apply:
        print(f"후보 {rel}")
        return
    dest = unique_dest(trash / rel)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(dest))
    print(f"옮김 {rel}")


# ---- 진입점 --------------------------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", default=".")
    p.add_argument("--config")
    p.add_argument("--gh-host")
    p.add_argument("--run")
    p.add_argument("--orch-dir")
    p.add_argument("--previews")
    p.add_argument("--board")
    p.add_argument("--trash")
    p.add_argument("--queue-days", type=float, default=1)
    p.add_argument("--folder-days", type=float, default=3)
    p.add_argument("--data-days", type=float, default=1)
    p.add_argument("--data-ext", default="csv,tsv")
    p.add_argument("--apply", action="store_true")
    return p


def load_config(parser, argv):
    first, _ = parser.parse_known_args(argv)
    path = Path(first.config) if first.config else orch_paths.path("config", first.repo)
    if path.is_file():
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            parser.error(f"설정 파일을 읽지 못했다: {path}: {exc}")
        config = config.get("cleanup", {}) if isinstance(config, dict) else None
        if not isinstance(config, dict):
            parser.error("설정 파일의 \"cleanup\" 절은 객체여야 한다")
        known = {a.dest for a in parser._actions} - {"pr", "config", "help"}
        unknown = sorted(set(config) - known)
        if unknown:
            parser.error(f"설정 파일에 모르는 키가 있다: {', '.join(unknown)}")
        parser.set_defaults(**config)
    return parser.parse_args(argv)


def main(argv=None, now=None):
    parser = build_parser()
    try:
        args = load_config(parser, sys.argv[1:] if argv is None else argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if not (args.config or args.orch_dir) and not orch_paths.require_migrated(args.repo, "handoff-cleanup", "설정 파일을 --config 로 직접 주거나 --orch-dir 로 폴더를 준다"):
        return 2
    repo = Path(args.repo).resolve()
    main_root = orch_paths.git_root(repo)
    args.orch_dir = (main_root / Path(args.orch_dir).expanduser()).resolve() if args.orch_dir else orch_paths.orch_dir(repo)
    args.previews = (main_root / Path(args.previews).expanduser()).resolve() if args.previews else None
    args.board = orch_paths.board_path(repo, args.board)
    now = time.time() if now is None else now
    trash = Path(args.trash).expanduser() if args.trash else Path.home() / ".Trash" / f"orch-cleanup-{datetime.fromtimestamp(now):%Y%m%d}"
    args.data_ext = {e.strip().lower().lstrip(".") for e in args.data_ext.split(",") if e.strip()}
    if args.gh_host:
        os.environ["GH_HOST"] = args.gh_host
    roots = [r for r in (args.orch_dir, args.previews) if r]
    for path in candidates(args, repo, now):
        root = next((r for r in roots if r in path.parents), None)
        if root is None:
            print(f"정리 대상 폴더({', '.join(map(str, roots))}) 밖이라 건너뛴다: {path}", file=sys.stderr)
            continue
        move(path, root, trash, args.apply)
    if args.apply:
        print(f"휴지통 폴더: {trash}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
