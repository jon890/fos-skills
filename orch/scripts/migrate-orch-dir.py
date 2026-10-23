#!/usr/bin/env python3
"""옛 위치(.omc, .claude)에 있던 orch 파일을 orch 작업 폴더(.orch)로 옮긴다.

기본은 미리보기다. 옮길 것, 겹치는 것, 고칠 옛 경로 참조, 막는 조건(stderr)을 보이고 아무것도 바꾸지 않는다.
`--apply` 를 주면 옮긴다. 옮긴 뒤 다시 돌리면 옮길 것이 없다.

사용법:
    migrate-orch-dir.py [--repo DIR] [--run RUN] [--move 옛=새 ...] [--apply]

    --repo   대상 저장소. 기본은 현재 디렉터리. 워크트리에서 불러도 주 checkout 을 옮긴다
    --run    살아 있는 dispatch 를 찾을 Orca Run. 없으면 설정(옛 위치나 새 위치)의 finish.run, 그것도 없으면 코디네이터에 묶인 Run 이다
    --move   기본 쌍 밖의 옛 위치를 더한다. 두 경로 모두 주 checkout 기준이다. 여러 번 줄 수 있다.
             예: --move .omc/handoffs/bin=.orch/bin
    --apply  실제로 옮긴다

옮기는 쌍: orch_paths.py 의 DEFAULT_MOVES 다음에 --move 쌍을 차례로 본다.
    폴더는 대상이 없으면 통째로 옮기고, 대상이 있으면 항목별로 합친다. 같은 이름이 있으면 덮지 않고 겹침으로 알린다.
    앞의 쌍이 옮긴 것은 뒤의 쌍이 다시 옮기지 않는다(.omc/orch/scripts 가 .omc/orch 보다 먼저다).
    board.json 은 work-board 소유라 어느 쌍으로도 옮기지 않는다.
    git 이 추적하는 파일은 옮기지 않고 `git mv` 명령만 보인다. 주 checkout 에 스테이징을 남기지 않기 위해서다.

옮긴 뒤 고치는 것:
    - 옮긴 .md, .json 파일(bin 아래는 빼고) 안의 옛 경로를 새 경로로 바꾼다. 지시서, PR 본문, 설정, 오버레이가 여기 해당한다
    - 설정(config.json)의 cleanup 절: 옛 키 omc, handoffs 를 지운다. .omc/previews 가 있고 previews 키가 없으면
      ".omc/previews" 를 써 넣어 미리보기 정리를 이어 간다
    - git 이 orch 작업 폴더를 무시하게 한다(orch_paths.ensure_ignored)
    - 비게 된 옛 폴더를 지운다

바꾸지 않고 보이기만 하는 것: 옛 경로를 적은 추적 파일(git grep), 추적하지 않는 .claude, .omc/handoffs, .omc/orch
아래 파일, 옮긴 스크립트(bin). 큐 로그(.out, .pid, .log)는 보지 않는다. 그 파일은 저장소가 고친다.

막는 조건 (--apply 를 거부하고 종료 코드 3):
    - 살아 있는 dispatch 가 있다. worker_done 뒤에도 이 저장소 워크트리의 터미널을 쥔(owned, active) worker 가 있다
    - orca 로 그 목록을 읽지 못했다
    - merge-queue.sh, merge-with-finish.py, finish-pr.py 가 돌고 있다
    worker 는 지시서를 절대경로로 읽고, 머지 큐는 옛 폴더에 로그를 쓰므로 그 사이에 옮기면 끊긴다.

종료 코드: 0 옮겼거나 옮길 것이 없다, 1 겹침이 있거나 추적 파일이 남았다(겹침이 있으면 아무것도 옮기지 않는다),
           2 사용법 오류, 3 막는 조건이 있다

GIT, ORCA, PGREP 환경 변수로 실행 파일을 바꾼다.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import orch_paths  # noqa: E402
from live_specs import ACTIVE, _orca, live_spec_paths  # noqa: E402

GIT = os.environ.get("GIT", "git")
ORCA = os.environ.get("ORCA", "orca")
PGREP = os.environ.get("PGREP", "pgrep")
BUSY = r"merge-queue\.sh|merge-with-finish\.py|finish-pr\.py"
REWRITE_SUFFIXES = {".md", ".json"}
LOG_SUFFIXES = {".out", ".pid", ".log", ".tmp"}
# 추적하지 않아 git grep 이 못 보는 곳. 옮기지 않는 포장 스크립트와 로컬 설정이 옛 경로를 적고 있을 수 있다
LOCAL_DIRS = (".claude", ".omc/handoffs", ".omc/orch")
SHOWN_REFS = 60


def run(cmd, cwd=None):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""
    return done.returncode, done.stdout


# ---- 계획 -----------------------------------------------------------------------------------------------

class Plan:
    def __init__(self, root):
        self.root = root
        self.moves = []        # (옛, 새) 실제로 옮길 것
        self.conflicts = []    # (옛, 새) 대상이 이미 있다
        self.tracked = []      # (옛, 새) git 이 추적한다
        self.boards = []       # 건너뛴 board.json
        self.pairs = []        # 무엇이든 옮긴 쌍. 옛 경로 문자열을 바꿀 때 쓴다
        self.claimed = []

    def rel(self, path):
        return path.relative_to(self.root).as_posix()

    def planned_dst(self, path):
        """앞 단계가 path 자리에 옮겨 놓을 원본. 없으면 None."""
        for src, dst in self.moves:
            if path == dst:
                return src
            if dst in path.parents:
                return src / path.relative_to(dst)
        return None

    def exists(self, path):
        source = self.planned_dst(path)
        return path.exists() or (source is not None and source.exists())

    def is_dir(self, path):
        source = self.planned_dst(path)
        return path.is_dir() or (source is not None and source.is_dir())

    def claimed_by_earlier(self, path):
        return any(path == c or c in path.parents for c in self.claimed)

    def holds_claim_or_board(self, path):
        return any(path in c.parents for c in self.claimed) or any(path.rglob("board.json"))


def tracked_files(root):
    code, out = run([GIT, "-C", str(root), "ls-files", "-z"])
    return {root / f for f in out.split("\0") if f} if code == 0 else set()


def expand(plan, src, dst, tracked):
    if plan.claimed_by_earlier(src) or not (src.exists() or src.is_symlink()):
        return
    if src.name == "board.json":
        plan.boards.append(src)
        plan.claimed.append(src)
        return
    if src.is_dir() and not src.is_symlink():
        inner_tracked = [t for t in tracked if src in t.parents]
        if plan.exists(dst) and not plan.is_dir(dst):
            plan.conflicts.append((src, dst))
        elif plan.exists(dst) or inner_tracked or plan.holds_claim_or_board(src):
            for child in sorted(src.iterdir()):
                expand(plan, child, dst / child.name, tracked)
        else:
            plan.moves.append((src, dst))
    elif plan.exists(dst):
        plan.conflicts.append((src, dst))
    elif src in tracked:
        plan.tracked.append((src, dst))
    else:
        plan.moves.append((src, dst))
    plan.claimed.append(src)


def make_plan(root, orch, extra):
    plan = Plan(root)
    tracked = tracked_files(root)
    pairs = [(root / old, orch / new if new else orch) for old, new in orch_paths.DEFAULT_MOVES]
    pairs += [(root / old, root / new) for old, new in extra]
    for src, dst in pairs:
        before = len(plan.moves) + len(plan.tracked)
        expand(plan, src, dst, tracked)
        if len(plan.moves) + len(plan.tracked) > before:
            plan.pairs.append((src, dst))
    return plan


# ---- 옛 경로 문자열 -------------------------------------------------------------------------------------

def replacements(plan):
    """(정규식, 새 문자열). 긴 옛 경로부터 바꾼다. 상대경로와 절대경로를 함께 다룬다."""
    pairs = {}
    for src, dst in plan.pairs + plan.moves + plan.tracked:
        pairs[plan.rel(src)] = os.path.relpath(dst, plan.root)
        pairs[str(src)] = str(dst)
    ordered = sorted(pairs.items(), key=lambda kv: len(kv[0]), reverse=True)
    return [(re.compile(r"(?<![\w.-])" + re.escape(old) + r"(?![\w.-])"), new) for old, new in ordered]


def rewrite(text, rules):
    count = 0
    for pattern, new in rules:
        text, n = pattern.subn(new.replace("\\", "\\\\"), text)
        count += n
    return text, count


def references(plan, rules):
    """옛 경로를 적은 곳: (파일, 줄 번호, 줄). 추적 파일, LOCAL_DIRS 아래, 옮길 파일 안을 본다."""
    files = set()
    if plan.pairs:
        code, out = run([GIT, "-C", str(plan.root), "grep", "-l", "-I", "-F",
                         *sum((["-e", plan.rel(s)] for s, _ in plan.pairs), [])])
        files |= {plan.root / f for f in out.splitlines() if f} if code == 0 else set()
    for local in (plan.root / d for d in LOCAL_DIRS):
        files |= {p for p in local.rglob("*") if p.is_file()} if local.is_dir() else set()
    for src, _ in plan.moves:
        files |= {p for p in src.rglob("*") if p.is_file()} if src.is_dir() else {src}
    found = []
    for path in sorted(files):
        if path.suffix in LOG_SUFFIXES:
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for no, line in enumerate(lines, 1):
            if any(p.search(line) for p, _ in rules):
                found.append((path, no, line.strip()))
    return found


def will_rewrite(path, plan):
    """옮긴 뒤 내용을 고치는 파일인지. orch 작업 폴더 안의 .md, .json 이고 스크립트(bin 아래)는 아니다."""
    orch = orch_paths.orch_dir(plan.root)
    if path.suffix not in REWRITE_SUFFIXES or orch not in path.parents:
        return False
    return "bin" not in path.relative_to(orch).parts[:-1]


# ---- 막는 조건 ------------------------------------------------------------------------------------------

def worktree_paths(root):
    code, out = run([GIT, "-C", str(root), "worktree", "list", "--porcelain"])
    paths = {Path(l[len("worktree "):]).resolve() for l in out.splitlines() if l.startswith("worktree ")} if code == 0 else set()
    return paths | {root}


def blockers(root, run_id):
    found = []
    live = live_spec_paths(ORCA, run_id)
    scope = ["--run", run_id] if run_id else []
    workers = _orca(ORCA, "orchestration", "worker-list", *scope)
    if live is None or workers is None:
        found.append("orca 로 살아 있는 dispatch 와 worker 를 읽지 못했다")
    else:
        if live:
            found.append(f"살아 있는 dispatch 가 지시서 {len(live)}개를 쓰고 있다")
        trees = worktree_paths(root)
        held = []
        for w in workers.get("workers") or []:
            res = w.get("resource") or {}
            tree = Path(str(res.get("worktreeId") or "").split("::", 1)[-1] or "/nonexistent").resolve()
            busy = w.get("dispatchStatus") in ACTIVE or (
                w.get("terminalState") == "active" and res.get("ownershipState") == "owned")
            if busy and tree in trees:
                held.append(w.get("dispatchId") or w.get("taskId") or "?")
        if held:
            found.append(f"이 저장소 워크트리의 터미널을 쥔 worker 가 있다: {', '.join(held)}")
    code, out = run([PGREP, "-fl", BUSY])
    if code == 0 and out.strip():
        found.append("머지 큐나 마무리가 돌고 있다: " + "; ".join(l.strip() for l in out.splitlines()[:5]))
    return found


# ---- 실행 -----------------------------------------------------------------------------------------------

def fix_config(path, root):
    """cleanup 절의 옛 키를 지우고 미리보기 폴더를 이어 준다. 바꾼 설명 목록."""
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(config, dict):
        return []
    cleanup = config.setdefault("cleanup", {})
    if not isinstance(cleanup, dict):
        return []
    notes = []
    for key in ("omc", "handoffs"):
        if key in cleanup:
            notes.append(f"cleanup.{key} 를 지웠다({cleanup.pop(key)})")
    if (root / ".omc/previews").is_dir() and "previews" not in cleanup:
        cleanup["previews"] = ".omc/previews"
        notes.append("cleanup.previews 에 .omc/previews 를 넣었다")
    if not cleanup:
        config.pop("cleanup")
    if notes:
        path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return notes


def apply(plan, rules):
    for src, dst in plan.moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        print(f"옮김 {plan.rel(src)} -> {os.path.relpath(dst, plan.root)}")
    orch = orch_paths.orch_dir(plan.root)
    moved = []
    for _, dst in plan.moves:
        moved += [p for p in dst.rglob("*") if p.is_file()] if dst.is_dir() else [dst]
    for path in moved:
        if will_rewrite(path, plan):
            try:
                text, count = rewrite(path.read_text(encoding="utf-8"), rules)
            except (OSError, UnicodeDecodeError):
                continue
            if count:
                path.write_text(text, encoding="utf-8")
                print(f"옛 경로 {count}곳을 바꿈 {os.path.relpath(path, plan.root)}")
    config = orch / orch_paths.NAMES["config"]
    for note in fix_config(config, plan.root) if config.is_file() else []:
        print(f"설정 {note}")
    if orch.exists():
        line = orch_paths.ensure_ignored(plan.root)
        if line:
            print(f"git 이 무시하게 했다: {line}")
    for src, _ in sorted(plan.pairs, key=lambda p: len(p[0].parts), reverse=True):
        for folder in [src, *src.parents]:
            if folder == plan.root or plan.root not in folder.parents or folder.name in {".omc", ".claude"}:
                break
            if not folder.exists():
                continue
            if not folder.is_dir() or any(folder.iterdir()):
                break
            folder.rmdir()
            print(f"빈 폴더를 지움 {plan.rel(folder)}")


def report(plan, rules, refs):
    for src, dst in plan.moves:
        print(f"옮길 것 {plan.rel(src)} -> {os.path.relpath(dst, plan.root)}")
    for src, dst in plan.conflicts:
        print(f"겹침 {plan.rel(src)} -> {os.path.relpath(dst, plan.root)} 이 이미 있다. 둘을 비교해 하나만 남긴 뒤 다시 돌린다")
    for src, dst in plan.tracked:
        print(f"추적 파일 git -C {plan.root} mv {plan.rel(src)} {os.path.relpath(dst, plan.root)}  (옮겨 커밋한다. "
              f".orch 는 무시되므로 git add -f 가 필요할 수 있다)")
    for board in plan.boards:
        print(f"남김 {plan.rel(board)} (보드는 work-board 소유라 옮기지 않는다)")
    for path, no, line in refs[:SHOWN_REFS]:
        mark = "바꿀 옛 경로" if any(path == s or s in path.parents for s, _ in plan.moves) and will_rewrite_after(path, plan) else "옛 경로 참조"
        print(f"{mark} {os.path.relpath(path, plan.root)}:{no}: {line[:160]}")
    if len(refs) > SHOWN_REFS:
        print(f"옛 경로 참조 {len(refs) - SHOWN_REFS}곳 더 있다")
    if (plan.root / ".omc/previews").is_dir():
        print("알림 미리보기(.omc/previews)는 옮기지 않는다. 설정에 cleanup.previews 가 없으면 넣어 정리를 이어 간다")


def will_rewrite_after(path, plan):
    for src, dst in plan.moves:
        if path == src or src in path.parents:
            return will_rewrite(dst / path.relative_to(src) if path != src else dst, plan)
    return False


def parse_move(value):
    old, sep, new = value.partition("=")
    if not sep or not old.strip() or not new.strip():
        raise argparse.ArgumentTypeError(f"옛=새 꼴이 아니다: {value}")
    for part in (old, new):
        if Path(part).is_absolute() or ".." in Path(part).parts:
            raise argparse.ArgumentTypeError(f"주 checkout 기준 상대경로여야 한다: {part}")
    return old.strip().rstrip("/"), new.strip().rstrip("/")


def configured_run(root):
    """설정 파일의 finish.run. 옮기기 전이면 옛 위치에서 읽는다."""
    for path in (orch_paths.path("config", root), root / ".claude/orch-finish.json"):
        try:
            run_id = json.loads(path.read_text(encoding="utf-8")).get("finish", {}).get("run")
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        if isinstance(run_id, str) and run_id:
            return run_id
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--run")
    parser.add_argument("--move", action="append", default=[], type=parse_move)
    parser.add_argument("--apply", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    root = orch_paths.git_root(args.repo)
    plan = make_plan(root, orch_paths.orch_dir(root), args.move)
    rules = replacements(plan)
    report(plan, rules, references(plan, rules) if rules else [])
    if not (plan.moves or plan.conflicts or plan.tracked):
        print("옮길 것이 없다")
        return 0
    found = blockers(root, args.run or configured_run(root))
    for reason in found:
        print(f"막음 {reason}", file=sys.stderr)
    if not args.apply:
        return 1 if plan.conflicts or plan.tracked else 0
    if plan.conflicts:
        print("겹침이 있어 아무것도 옮기지 않았다", file=sys.stderr)
        return 1
    if found:
        print("worker 와 머지 큐가 끝난 뒤 다시 돌린다", file=sys.stderr)
        return 3
    apply(plan, rules)
    return 1 if plan.tracked else 0


if __name__ == "__main__":
    sys.exit(main())
