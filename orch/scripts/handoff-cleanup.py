#!/usr/bin/env python3
"""끝난 작업의 handoff 산출물을 휴지통 폴더로 옮긴다. 지우지 않으므로 되살릴 수 있다.

기본은 옮길 후보만 보인다. `--apply` 를 주면 옮긴다. 몇 번을 돌려도 같은 상태에서는 같은 결과다.

사용법:
    handoff-cleanup.py [--repo DIR] [--config FILE] [--apply] [옵션...]

옮기는 것 (경로는 모두 .omc 폴더 기준이다):
    - <handoffs>/queue/*.out: QUEUE-DONE, STOP, FINISH-DONE, FINISH-FAIL 중 하나로 끝났고 --queue-days 일 넘게 지난 로그
    - <handoffs>/specs/spec-*.md: 아래가 모두 참인 지시서. spec-common.md 는 남긴다
        · 지시서의 `보드 항목 id: \\`x\\`` 항목이 보드에서 done 이다. 보드에 항목이 없거나 done 이 아니면
          아직 쓰는 지시서다(띄우기 전, PR 이 여럿인 일의 중간). 그 줄이 없는 지시서는 이 조건을 건너뛴다
        · 지시서의 `브랜치:` 가 원격과 워크트리에 없고 그 브랜치의 열린 PR 도 없다
        · 열린 PR 목록을 읽지 못하면 아무것도 옮기지 않는다
    - <handoffs>/<폴더>: --folder-days 일 넘게 바뀌지 않았고, 보드 파일에 이름이 없고 <previews>/.keep 에도 없는 폴더
      (bin, queue, specs 와 보드 파일은 건드리지 않는다)
    - <previews>/<폴더나 파일>: 위와 같은 조건
    - .omc 아래 --data-ext 확장자 파일(기본 csv, tsv) 중 --data-days 일 넘게 지난 것. bin 폴더 안은 뺀다
      (DB 에서 뽑은 원본은 쓰고 나서 지운다)

남길 미리보기는 <previews>/.keep 에 한 줄에 하나씩 이름을 적는다.
휴지통 안에서는 .omc 기준 상대 경로를 그대로 두고, 같은 이름이 있으면 번호를 붙여 덮어쓰지 않는다.

옵션 (저장소마다 다른 값이다. --config 의 JSON 키는 옵션 이름의 하이픈을 밑줄로 바꾼 것이다):
    --repo DIR         대상 저장소. 기본은 현재 디렉터리. git 과 gh 를 여기서 돌린다
    --config FILE      옵션 값을 담은 JSON. 「cleanup」 절을 읽는다. 없으면 <repo>/.claude/orch-finish.json 이 있을 때 쓴다. 명령줄이 우선한다
    --gh-host HOST     gh 에 줄 GH_HOST
    --omc DIR          산출물 루트. 기본 <repo>/.omc
    --handoffs DIR     기본 <omc>/handoffs
    --previews DIR     기본 <omc>/previews
    --board FILE       보드 파일. 기본 <handoffs>/board.json
    --trash DIR        휴지통 폴더. 기본 ~/.Trash/omc-cleanup-<날짜>
    --queue-days N     기본 1
    --folder-days N    기본 3
    --data-days N      기본 1
    --data-ext LIST    쉼표로 이은 확장자. 기본 csv,tsv
    --apply            실제로 옮긴다

GH, GIT 환경 변수로 실행 파일을 바꾼다.

종료 코드: 0 돌았다(후보가 없어도 0), 2 사용법 오류
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
DEFAULT_CONFIG = ".claude/orch-finish.json"
QUEUE_DONE = re.compile(r"QUEUE-DONE|^STOP|FINISH-DONE|FINISH-FAIL", re.M)
BRANCH_LINE = re.compile(r"^\s*(?:[-*]\s+)?(?:\*\*)?브랜치:(?:\*\*)?\s*`([^`]+)`", re.M)
BOARD_ID_LINE = re.compile(r"^\s*(?:[-*]\s+)?(?:\*\*)?보드 항목 id:(?:\*\*)?\s*`([^`]+)`", re.M)
HANDOFF_SKIP = {"bin", "queue", "specs", "board.json", ".keep"}
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


def candidates(args, repo, now):
    omc, handoffs, previews = args.omc, args.handoffs, args.previews
    found = []
    queue = handoffs / "queue"
    for log in sorted(queue.glob("*.out")) if queue.is_dir() else []:
        try:
            if is_old(log.stat().st_mtime, now, args.queue_days) and queue_log_finished(
                    log.read_text(encoding="utf-8", errors="replace")):
                found.append(log)
        except OSError:
            continue

    board_text = args.board.read_text(encoding="utf-8") if args.board.is_file() else ""
    statuses = board_statuses(board_text)
    specs = sorted((handoffs / "specs").glob("spec-*.md")) if (handoffs / "specs").is_dir() else []
    specs = [s for s in specs if s.name != "spec-common.md"]
    heads = open_pr_heads(repo) if specs else set()
    if heads is None:
        print("gh 로 열린 PR 을 읽지 못해 지시서는 옮기지 않는다", file=sys.stderr)
    elif specs:
        _, worktrees = run([GIT, "worktree", "list"], repo)
        for spec in specs:
            text = spec.read_text(encoding="utf-8", errors="replace")
            remote_has = lambda b: run([GIT, "ls-remote", "--exit-code", "--heads", "origin", b], repo)[0] == 0
            worktree_has = lambda b: f"[{b}]" in worktrees
            if spec_finished(text, statuses, heads, remote_has, worktree_has):
                found.append(spec)

    keep_file = previews / ".keep"
    keep = {l.strip() for l in keep_file.read_text(encoding="utf-8").splitlines()} if keep_file.is_file() else set()
    entries = [p for p in sorted(handoffs.iterdir()) if p.is_dir()] if handoffs.is_dir() else []
    entries += sorted(previews.iterdir()) if previews.is_dir() else []
    for entry in entries:
        if entry.name in HANDOFF_SKIP:
            continue
        if is_old(entry.stat().st_mtime, now, args.folder_days) and not referenced(entry.name, board_text, keep):
            found.append(entry)

    if omc.is_dir():
        for path in sorted(omc.rglob("*")):
            if path.is_file() and path.suffix.lower().lstrip(".") in args.data_ext and "bin" not in path.relative_to(omc).parts[:-1]:
                if is_old(path.stat().st_mtime, now, args.data_days):
                    found.append(path)
    return drop_nested(found)


def move(path, omc, trash, apply):
    rel = path.relative_to(omc)
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
    p.add_argument("--omc")
    p.add_argument("--handoffs")
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
    path = Path(first.config) if first.config else Path(first.repo) / DEFAULT_CONFIG
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
    repo = Path(args.repo).resolve()
    args.omc = Path(args.omc).resolve() if args.omc else repo / ".omc"
    args.handoffs = Path(args.handoffs).resolve() if args.handoffs else args.omc / "handoffs"
    args.previews = Path(args.previews).resolve() if args.previews else args.omc / "previews"
    args.board = Path(args.board).resolve() if args.board else args.handoffs / "board.json"
    now = time.time() if now is None else now
    trash = Path(args.trash).expanduser() if args.trash else Path.home() / ".Trash" / f"omc-cleanup-{datetime.fromtimestamp(now):%Y%m%d}"
    args.data_ext = {e.strip().lower().lstrip(".") for e in args.data_ext.split(",") if e.strip()}
    if args.gh_host:
        os.environ["GH_HOST"] = args.gh_host
    for path in candidates(args, repo, now):
        try:
            path.relative_to(args.omc)
        except ValueError:
            print(f"산출물 루트({args.omc}) 밖이라 건너뛴다: {path}", file=sys.stderr)
            continue
        move(path, args.omc, trash, args.apply)
    if args.apply:
        print(f"휴지통 폴더: {trash}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
