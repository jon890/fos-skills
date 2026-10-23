#!/usr/bin/env python3
"""orch 작업 폴더의 경로를 한 곳에서 정한다. orch 스크립트는 경로 문자열을 따로 갖지 않고 이 모듈에서 받는다.

루트는 `ORCH_DIR` 환경 변수다. 상대경로면 주 checkout 기준이다. 없으면 `<주 checkout>/.orch` 다.
주 checkout 은 `git rev-parse --git-common-dir` 의 부모다. 워크트리에서 불러도 같은 폴더를 가리켜, 워크트리를 지울 때
지시서와 큐가 함께 사라지지 않는다. git 밖이거나 bare 저장소면 주어진 폴더를 그대로 쓴다.
`ORCH_DIR` 을 쓰면 orch 스크립트를 부르는 모든 환경(코디네이터 셸, 훅)에 같은 값을 둔다.

이름과 경로 (루트 기준):
    overlay     overlay.md         사람이 읽는 저장소 규칙
    config      config.json        스크립트가 읽는 저장소 값. finish, cleanup, queue 절
    specs       specs/             지시서와 spec-common.md. PR 본문 pr-<이름>.md 는 그 부모(루트)에 둔다
    queue       queue/             머지 큐와 마무리 출력, pid
    state       state/             대기와 알림이 기억하는 것
    heavy-slot  state/heavy-slot/  무거운 검사 대기열의 상태
    bin         bin/               저장소 포장 스크립트

보드는 work-board 소유라 여기 없다. `board_path` 는 work-board 의 `bin/board.py` 규칙을 그대로 쓴다.

옛 구조: `.claude/orch-overlay.md`, `.claude/orch-finish.json`, `.omc/orch/`, `.omc/handoffs/specs/` 가 남아 있으면
`require_migrated` 가 옮기는 명령(`migrate-orch-dir.py`)을 알린다. 옛 위치를 읽는 분기는 두지 않는다.
옮길 쌍의 기본 표 `DEFAULT_MOVES` 도 여기 둔다.

사용법 (셸과 문서에서 같은 값을 받는다):
    orch_paths.py [--repo DIR] [--ensure] NAME
    NAME 은 위 이름이나 root, board 다. 절대경로 한 줄을 낸다.
    --ensure  폴더를 만들고 git 이 루트를 무시하게 한다. 파일 이름이면 그 부모 폴더를 만든다

git 무시: 루트가 저장소 안에 있고 git 이 아직 무시하지 않으면 `git rev-parse --git-path info/exclude` 파일에
`/<루트>/` 한 줄을 더한다. 저장소의 .gitignore 는 바꾸지 않는다. 그 파일은 워크트리끼리 함께 쓴다.

종료 코드: 0 냈다, 2 사용법 오류
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

GIT = os.environ.get("GIT", "git")
DEFAULT_ROOT = ".orch"
NAMES = {
    "overlay": "overlay.md",
    "config": "config.json",
    "specs": "specs",
    "queue": "queue",
    "state": "state",
    "heavy-slot": "state/heavy-slot",
    "bin": "bin",
}
FILES = {"overlay", "config"}
# (옛 경로, 새 경로). 옛 경로는 주 checkout 기준, 새 경로는 루트 기준이다. 앞의 쌍이 먼저 옮긴다
DEFAULT_MOVES = [
    (".claude/orch-overlay.md", "overlay.md"),
    (".claude/orch-finish.json", "config.json"),
    (".omc/orch/scripts", "bin"),
    (".omc/orch", ""),
    (".omc/handoffs/specs", "specs"),
    (".omc/handoffs/queue", "queue"),
    (".omc/state/wait-important-lost.json", "state/wait-important-lost.json"),
    (".omc/state/notify-conflicts.json", "state/notify-conflicts.json"),
]
# 남아 있으면 옮기기 전이라고 보는 옛 위치. 설정과 지시서가 여기 있으면 스크립트가 그 값 없이 돌게 된다
LEGACY_MARKERS = (".claude/orch-overlay.md", ".claude/orch-finish.json", ".omc/orch", ".omc/handoffs/specs")
MIGRATE = Path(__file__).resolve().parent / "migrate-orch-dir.py"
BOARD_PY = Path(__file__).resolve().parents[2] / "work-board" / "bin" / "board.py"


def _git(repo, *args):
    try:
        done = subprocess.run([GIT, "-C", str(repo), *args], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""
    return done.returncode, done.stdout.strip()


def git_root(repo=None):
    """repo 의 주 checkout. git 밖이거나 bare 면 repo 자신이다."""
    repo = Path(repo or ".").resolve()
    code, out = _git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if code != 0 or not out:
        return repo
    common = Path(out).resolve()
    if common.name == ".git":
        return common.parent
    code, top = _git(repo, "rev-parse", "--show-toplevel")
    return Path(top).resolve() if code == 0 and top else repo


def orch_dir(repo=None):
    root = git_root(repo)
    env = os.environ.get("ORCH_DIR")
    if not env:
        return root / DEFAULT_ROOT
    path = Path(env).expanduser()
    return path if path.is_absolute() else root / path


def path(name, repo=None):
    if name not in NAMES:
        raise KeyError(f"모르는 이름: {name}. {', '.join(NAMES)} 중 하나다")
    return orch_dir(repo) / NAMES[name]


def board_path(repo=None, explicit=None):
    """보드 파일. explicit(명령줄이나 설정의 board)이 있으면 그것을 repo 기준으로, 없으면 work-board 의 기본 위치다."""
    if explicit:
        board = Path(explicit).expanduser()
        return board if board.is_absolute() else git_root(repo) / board
    spec = importlib.util.spec_from_file_location("work_board", BOARD_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return Path(module.board_path(None, str(Path(repo or ".").resolve())))


def ensure_ignored(repo=None):
    """루트를 git 이 무시하게 한다. 더한 줄이 있으면 그 줄, 없으면 None."""
    root, top = orch_dir(repo), git_root(repo)
    try:
        rel = root.relative_to(top)
    except ValueError:
        return None
    if _git(top, "rev-parse", "--git-dir")[0] != 0:
        return None
    if _git(top, "check-ignore", "-q", "--no-index", f"{rel.as_posix()}/")[0] == 0:
        return None
    code, exclude = _git(top, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
    if code != 0 or not exclude:
        return None
    line = f"/{rel.as_posix()}/"
    exclude = Path(exclude)
    exclude.parent.mkdir(parents=True, exist_ok=True)
    text = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
    if line in text.splitlines():
        return None
    with exclude.open("a", encoding="utf-8") as sink:
        sink.write(("" if not text or text.endswith("\n") else "\n") + line + "\n")
    return line


def ensure(name, repo=None):
    """이름의 폴더(파일이면 부모 폴더)를 만들고 git 이 루트를 무시하게 한다. 경로를 돌려준다."""
    target = path(name, repo)
    (target.parent if name in FILES else target).mkdir(parents=True, exist_ok=True)
    ensure_ignored(repo)
    return target


def make_parent(target, repo=None):
    """target 의 부모 폴더를 만든다. target 이 루트 안이면 git 이 루트를 무시하게 한다."""
    target = Path(target).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    root = orch_dir(repo)
    if root == target or root in target.parents:
        ensure_ignored(repo)


def legacy_paths(repo=None):
    """남아 있는 옛 위치 목록(주 checkout 기준 상대경로)."""
    root = git_root(repo)
    return [rel for rel in LEGACY_MARKERS if (root / rel).exists()]


def require_migrated(repo=None, script="orch"):
    """옛 구조가 남아 있으면 옮기는 명령을 stderr 로 알리고 False 를 돌려준다. 부르는 쪽은 종료 코드 2 로 끝난다."""
    left = legacy_paths(repo)
    if not left:
        return True
    print(f"{script}: orch 작업 폴더를 옮기기 전이다. 옛 위치가 남아 있다: {', '.join(left)}\n"
          f"  새 위치({orch_dir(repo)})의 설정과 지시서만 읽으므로 이대로 돌면 저장소 값이 빠진다.\n"
          f"  머지 큐와 worker 가 돌지 않을 때 옮긴다: python3 {MIGRATE} --repo {git_root(repo)} --apply\n"
          f"  옮기기 전에 꼭 돌려야 하면 설정 파일을 --config 로 직접 준다.", file=sys.stderr)
    return False


def warn_legacy(repo=None, script="orch"):
    """옛 구조가 남아 있으면 알리기만 한다. 대기처럼 멈추면 옮길 수도 없게 되는 스크립트가 쓴다."""
    left = legacy_paths(repo)
    if left:
        print(f"{script}: 옛 위치가 남아 있다({', '.join(left)}). 대기가 끝나면 "
              f"python3 {MIGRATE} --repo {git_root(repo)} 로 옮긴다", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name", choices=["root", "board", *NAMES])
    parser.add_argument("--repo", default=".")
    parser.add_argument("--ensure", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if args.name == "board":
        print(board_path(args.repo))
    elif args.name == "root":
        root = orch_dir(args.repo)
        if args.ensure:
            root.mkdir(parents=True, exist_ok=True)
            ensure_ignored(args.repo)
        print(root)
    else:
        print(ensure(args.name, args.repo) if args.ensure else path(args.name, args.repo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
