#!/usr/bin/env python3
"""옛 위치(.omc, .claude)에 있던 orch 파일을 orch 작업 폴더(.orch)로 옮긴다.

기본은 미리보기다. 옮길 것, 겹치는 것, 옮긴 뒤 고칠 것, 옛 경로 참조, 막는 조건(stderr)을 보이고 아무것도 바꾸지 않는다.
`--apply` 를 주면 옮기고 고친다. 다 끝난 뒤 다시 돌리면 「옮길 것이 없다」 로 끝난다.

사용법:
    migrate-orch-dir.py [--repo DIR] [--run RUN] [--move 옛=새 ...] [--apply]

    --repo   대상 저장소. 기본은 현재 디렉터리. 워크트리를 주어도 주 checkout 을 옮긴다
    --run    살아 있는 dispatch 를 찾을 Orca Run. 없으면 설정(옛 위치나 새 위치)의 finish.run, 그것도 없으면 코디네이터에 묶인 Run 이다
    --move   기본 쌍 밖의 옛 위치를 더한다. 두 경로 모두 주 checkout 기준 상대경로다. 여러 번 줄 수 있다.
             예: --move .omc/handoffs/bin=.orch/bin
    --apply  실제로 옮긴다

옮기는 쌍: orch_paths.py 의 DEFAULT_MOVES 다음에 --move 쌍을 차례로 본다.
    폴더는 대상이 없으면 통째로 옮기고, 대상이 있으면 항목별로 합친다. 같은 이름이 있으면 덮지 않고 겹침으로 알린다.
    파일이 하나도 없는 폴더는 옮기지 않고 지운다. 빈 새 폴더를 만들지 않기 위해서다.
    앞의 쌍이 옮긴 것은 뒤의 쌍이 다시 옮기지 않는다(.omc/orch/scripts 가 .omc/orch 보다 먼저다).
    board.json 은 work-board 소유라 어느 쌍으로도 옮기지 않는다.
    git 이 추적하는 파일은 옮기지 않고 대상 폴더만 만든 뒤 `git mv` 명령을 보인다. 주 checkout 에 스테이징을 남기지 않기 위해서다.
    상대경로 심볼릭 링크가 옮긴 폴더 밖을 가리키면 새 자리에서 같은 대상을 가리키게 다시 만든다.

옮긴 뒤 고치는 것 (옮길 것이 없어도 --apply 마다 한다. 중간에 멈춘 뒤 다시 돌려도 남지 않는다):
    - orch 작업 폴더의 .md, .json 파일(bin 아래는 빼고) 안의 옛 경로를 새 경로로 바꾼다. 지시서, PR 본문, 설정, 오버레이가 여기 해당한다
    - 설정(config.json)의 cleanup 절: 옛 키 omc, handoffs 를 지운다. .omc/previews 가 있고 previews 키가 없으면
      ".omc/previews" 를 써 넣어 미리보기 정리를 이어 간다. 설정 파일이 없으면 그 값만 담아 새로 만든다
    - git 이 orch 작업 폴더를 무시하게 한다(orch_paths.ensure_ignored)
    - 옛 위치(쌍의 옛 경로와 orch_paths.LEGACY_MARKERS)에 남은 빈 폴더를 지운다. .omc 와 .claude 자체는 남긴다

바꾸지 않고 보이기만 하는 것: 옛 경로를 적은 추적 파일(git grep), 추적하지 않는 .claude(worktrees 는 빼고),
.omc/handoffs, .omc/orch 아래 파일, 옮긴 스크립트(bin). 큐 로그(.out, .pid, .log)는 보지 않는다. 그 파일은 저장소가 고친다.
스크립트의 참조에는 「다시 만들 수 있다」 를 붙인다. 옮긴 포장 스크립트가 옛 폴더를 다시 만들면 진입점이 다시 멈춘다.

막는 조건 (옮길 것이 있을 때 --apply 를 거부하고 종료 코드 3):
    - 살아 있는 dispatch 가 있다. worker_done 뒤에도 이 저장소 워크트리의 터미널을 쥔(owned, active) worker 가 있다
    - orca 로 그 목록을 읽지 못했다
    - merge-queue.sh, merge-with-finish.py, finish-pr.py 가 돌고 있다. pgrep 을 돌리지 못해도 막는다
    worker 는 지시서를 절대경로로 읽고, 머지 큐는 옛 폴더에 로그를 쓰므로 그 사이에 옮기면 끊긴다.

종료 코드: 0 옮겼거나 옮길 것이 없다, 1 겹침이 있거나 추적 파일이 남았거나 옮기다 실패했다(겹침이 있으면 아무것도 옮기지 않는다),
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
BUSY = r"merge-queue\.sh|merge_queue\.py|merge-with-finish\.py|finish-pr\.py"
REWRITE_SUFFIXES = {".md", ".json"}
LOG_SUFFIXES = {".out", ".pid", ".log", ".tmp"}
SCRIPT_SUFFIXES = {".sh", ".py", ".ts", ".js", ".cjs", ".mjs"}
# 추적하지 않아 git grep 이 못 보는 곳. 옮기지 않는 포장 스크립트와 로컬 설정이 옛 경로를 적고 있을 수 있다
LOCAL_DIRS = (".claude", ".omc/handoffs", ".omc/orch")
# LOCAL_DIRS 아래에서도 보지 않는 폴더. 다른 체크아웃이 들어 있다
LOCAL_SKIP = {"worktrees"}
KEEP_DIRS = {".omc", ".claude"}
PREVIEWS = ".omc/previews"
SHOWN_REFS = 60


def run(cmd, cwd=None):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""
    return done.returncode, done.stdout


def rel(path, root):
    return os.path.relpath(path, root)


# ---- 계획 -----------------------------------------------------------------------------------------------

class Plan:
    def __init__(self, root, orch, pairs):
        self.root = root
        self.orch = orch
        self.pairs = pairs     # (옛, 새) 설정된 쌍 전부. 옛 경로 문자열을 바꿀 때도 쓴다
        self.moves = []        # (옛, 새) 실제로 옮길 것
        self.conflicts = []    # (옛, 새) 대상이 이미 있다
        self.tracked = []      # (옛, 새) git 이 추적한다
        self.boards = []       # 건너뛴 board.json
        self.claimed = []

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
        if not orch_paths.has_files(src):
            pass  # 빈 폴더는 옮기지 않고 마무리에서 지운다
        elif plan.exists(dst) and not plan.is_dir(dst):
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
    pairs = [(root / old, orch / new if new else orch) for old, new in orch_paths.DEFAULT_MOVES]
    pairs += [(root / old, root / new) for old, new in extra]
    plan = Plan(root, orch, pairs)
    tracked = tracked_files(root)
    for src, dst in pairs:
        expand(plan, src, dst, tracked)
    return plan


# ---- 옛 경로 문자열 -------------------------------------------------------------------------------------

def replacements(plan):
    """(정규식, 새 문자열). 긴 옛 경로부터 바꾼다. 상대경로와 절대경로를 함께 다룬다."""
    pairs = {}
    for src, dst in plan.pairs + plan.moves + plan.tracked:
        pairs[rel(src, plan.root)] = rel(dst, plan.root)
        pairs[str(src)] = str(dst)
    ordered = sorted(pairs.items(), key=lambda kv: len(kv[0]), reverse=True)
    return [(re.compile(r"(?<![\w.-])" + re.escape(old) + r"(?![\w.-])"), new) for old, new in ordered]


def rewrite(text, rules):
    count = 0
    for pattern, new in rules:
        text, n = pattern.subn(new.replace("\\", "\\\\"), text)
        count += n
    return text, count


def will_rewrite(path, orch):
    """옮긴 뒤 내용을 고치는 파일인지. orch 작업 폴더 안의 .md, .json 이고 스크립트(bin 아래)는 아니다."""
    if path.suffix not in REWRITE_SUFFIXES or orch not in path.parents:
        return False
    return "bin" not in path.relative_to(orch).parts[:-1]


def after_move(path, plan):
    """path 가 이번에 옮겨질 파일이면 옮긴 뒤의 자리, 아니면 None."""
    for src, dst in plan.moves:
        if path == src:
            return dst
        if src in path.parents:
            return dst / path.relative_to(src)
    return None


def is_script(path):
    return path.suffix in SCRIPT_SUFFIXES or "bin" in path.parts[:-1] or (path.is_file() and os.access(path, os.X_OK))


def local_files(folder):
    if not folder.is_dir():
        return set()
    return {p for p in folder.rglob("*")
            if p.is_file() and not LOCAL_SKIP.intersection(p.relative_to(folder).parts[:-1])}


def references(plan, rules):
    """옛 경로를 적은 곳: (파일, 줄 번호, 줄). 추적 파일, LOCAL_DIRS 아래, 옮길 파일 안을 본다.

    orch 작업 폴더 안의 파일은 마무리 단계가 따로 보인다."""
    files = set()
    olds = [rel(src, plan.root) for src, _ in plan.pairs]
    code, out = run([GIT, "-C", str(plan.root), "grep", "-l", "-I", "-F", *sum((["-e", o] for o in olds), [])])
    files |= {plan.root / f for f in out.splitlines() if f} if code == 0 else set()
    for local in LOCAL_DIRS:
        files |= local_files(plan.root / local)
    for src, _ in plan.moves:
        files |= local_files(src) if src.is_dir() else {src}
    found = []
    for path in sorted(files):
        if path.suffix in LOG_SUFFIXES or plan.orch in path.parents:
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for no, line in enumerate(lines, 1):
            if any(p.search(line) for p, _ in rules):
                found.append((path, no, line.strip()))
    return found


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
    elif code not in (0, 1):
        found.append(f"pgrep 으로 머지 큐와 마무리 프로세스를 확인하지 못했다(종료 코드 {code})")
    return found


# ---- 옮기기 ---------------------------------------------------------------------------------------------

def outward_links(src):
    """src(파일이나 폴더) 안의 상대경로 심볼릭 링크 중 src 밖을 가리키는 것: [(링크, 절대 대상)]."""
    links = [src] if src.is_symlink() else [p for p in src.rglob("*") if p.is_symlink()] if src.is_dir() else []
    found = []
    for link in links:
        target = os.readlink(link)
        if os.path.isabs(target):
            continue
        absolute = Path(os.path.normpath(link.parent / target))
        if src.is_dir() and not src.is_symlink() and (absolute == src or src in absolute.parents):
            continue
        found.append((link, absolute))
    return found


def move(src, dst, root):
    links = outward_links(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(src), str(dst))
    except OSError:
        # 이름 바꾸기에 실패하면 shutil 은 복사한 뒤 원본을 지운다. 원본을 못 지웠으면 사본을 거둬 다시 돌릴 때 겹치지 않게 한다
        if (src.exists() or src.is_symlink()) and (dst.exists() or dst.is_symlink()):
            shutil.rmtree(dst) if dst.is_dir() and not dst.is_symlink() else dst.unlink()
        raise
    for link, absolute in links:
        new_link = dst if link == src else dst / link.relative_to(src)
        new_link.unlink()
        new_link.symlink_to(os.path.relpath(absolute, new_link.parent))
    print(f"옮김 {rel(src, root)} -> {rel(dst, root)}")


def config_changes(config_path, root):
    """(새 설정 dict, 설명 목록). 바꿀 것이 없으면 (None, [])."""
    exists = config_path.is_file()
    try:
        config = json.loads(config_path.read_text(encoding="utf-8")) if exists else {}
    except (OSError, json.JSONDecodeError):
        return None, []
    if not isinstance(config, dict) or not isinstance(config.get("cleanup", {}), dict):
        return None, []
    cleanup = dict(config.get("cleanup", {}))
    notes = []
    for key in ("omc", "handoffs"):
        if key in cleanup:
            notes.append(f"cleanup.{key} 를 지운다({cleanup.pop(key)})")
    if (root / PREVIEWS).is_dir() and "previews" not in cleanup:
        cleanup["previews"] = PREVIEWS
        notes.append(f"cleanup.previews 에 {PREVIEWS} 를 넣는다" + ("" if exists else ". 설정 파일을 새로 만든다"))
    if not notes:
        return None, []
    config = {**config, "cleanup": cleanup} if cleanup else {k: v for k, v in config.items() if k != "cleanup"}
    return config, notes


def empty_dirs(plan):
    """지울 빈 옛 폴더. 깊은 것부터."""
    starts = {src for src, _ in plan.pairs} | {plan.root / m for m in orch_paths.LEGACY_MARKERS}
    found = []
    for start in starts:
        if start.is_dir() and not start.is_symlink() and not orch_paths.has_files(start):
            found += [p for p in start.rglob("*") if p.is_dir()] + [start]
    return sorted(set(found), key=lambda p: len(p.parts), reverse=True)


def finish(plan, rules, apply):
    """옮긴 뒤 고치는 것. 미리보기면 할 일을 보이기만 한다. 한 일(할 일)이 있으면 True."""
    did = False
    orch = plan.orch
    for path in sorted(p for p in orch.rglob("*") if p.is_file()) if orch.is_dir() else []:
        if not will_rewrite(path, orch):
            continue
        try:
            text, count = rewrite(path.read_text(encoding="utf-8"), rules)
        except (OSError, UnicodeDecodeError):
            continue
        if count:
            did = True
            if apply:
                path.write_text(text, encoding="utf-8")
            print(f"{'옛 경로를 바꿈' if apply else '바꿀 옛 경로'} {rel(path, plan.root)} {count}곳")
    config_path = orch / orch_paths.NAMES["config"]
    config, notes = config_changes(config_path, plan.root)
    if notes:
        did = True
        if apply:
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for note in notes:
            print(f"설정 {note}")
    if apply and orch.exists():
        line = orch_paths.ensure_ignored(plan.root)
        if line:
            did = True
            print(f"git 이 무시하게 했다: {line}")
    for folder in empty_dirs(plan):
        did = True
        if apply:
            folder.rmdir()
        print(f"{'빈 폴더를 지움' if apply else '지울 빈 폴더'} {rel(folder, plan.root)}")
    if apply:
        prune_parents(plan)
    return did


def prune_parents(plan):
    """옮긴 옛 경로의 부모 중 비게 된 폴더를 지운다. .omc, .claude 와 저장소 루트에서 멈춘다."""
    for src, _ in sorted(plan.moves + plan.tracked, key=lambda p: len(p[0].parts), reverse=True):
        for folder in src.parents:
            if folder == plan.root or plan.root not in folder.parents or folder.name in KEEP_DIRS:
                break
            if not folder.is_dir() or any(folder.iterdir()):
                break
            folder.rmdir()
            print(f"빈 폴더를 지움 {rel(folder, plan.root)}")


def apply_moves(plan):
    """옮긴다. 실패하면 그때까지 옮긴 것을 보이고 False."""
    for src, dst in plan.moves:
        try:
            move(src, dst, plan.root)
        except OSError as exc:
            print(f"옮기다 실패했다 {rel(src, plan.root)} -> {rel(dst, plan.root)}: {exc}", file=sys.stderr)
            print("위의 「옮김」 줄까지 옮겼다. 원인을 고친 뒤 다시 돌리면 남은 것을 옮긴다", file=sys.stderr)
            return False
    for _, dst in plan.tracked:
        dst.parent.mkdir(parents=True, exist_ok=True)
    return True


def git_mv_command(src, dst, root):
    return (f"mkdir -p {dst.parent} && git -C {root} mv {rel(src, root)} {rel(dst, root)}")


def report(plan, refs):
    for src, dst in plan.moves:
        print(f"옮길 것 {rel(src, plan.root)} -> {rel(dst, plan.root)}")
    for src, dst in plan.conflicts:
        print(f"겹침 {rel(src, plan.root)} -> {rel(dst, plan.root)} 이 이미 있다. 둘을 비교해 하나만 남긴 뒤 다시 돌린다")
    for src, dst in plan.tracked:
        print(f"추적 파일 {git_mv_command(src, dst, plan.root)}  (옮겨 커밋한다. .orch 는 무시되므로 새 파일은 git add -f 로 더한다)")
    for board in plan.boards:
        print(f"남김 {rel(board, plan.root)} (보드는 work-board 소유라 옮기지 않는다)")
    for path, no, line in refs[:SHOWN_REFS]:
        moved_to = after_move(path, plan)
        if moved_to is not None and will_rewrite(moved_to, plan.orch):
            mark = "바꿀 옛 경로"
        elif is_script(moved_to or path):
            mark = "옛 경로 참조(스크립트. 옛 폴더를 다시 만들 수 있어 옮긴 뒤 고친다)"
        else:
            mark = "옛 경로 참조"
        print(f"{mark} {rel(path, plan.root)}:{no}: {line[:160]}")
    if len(refs) > SHOWN_REFS:
        print(f"옛 경로 참조 {len(refs) - SHOWN_REFS}곳 더 있다")


# ---- 진입점 --------------------------------------------------------------------------------------------

def parse_move(value):
    old, sep, new = value.partition("=")
    old, new = old.strip().rstrip("/"), new.strip().rstrip("/")
    if not sep or not old or not new:
        raise argparse.ArgumentTypeError(f"옛=새 꼴이 아니다: {value}")
    for part in (old, new):
        parts = Path(part).parts
        if Path(part).is_absolute() or ".." in parts or ".git" in parts or part in (".", "./"):
            raise argparse.ArgumentTypeError(f"주 checkout 안의 상대경로여야 하고 ., .., .git 을 쓰지 않는다: {part}")
    if old == new or Path(new).is_relative_to(old) or Path(old).is_relative_to(new):
        raise argparse.ArgumentTypeError(f"한쪽이 다른 쪽 안에 있다: {value}")
    return old, new


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
    orch = orch_paths.orch_dir(root)
    for old, _ in orch_paths.DEFAULT_MOVES + args.move:
        if orch == root / old or (root / old) in orch.parents:
            print(f"orch 작업 폴더({orch})가 옛 위치 {old} 안이다. ORCH_DIR 을 바꾼다", file=sys.stderr)
            return 2
    plan = make_plan(root, orch, args.move)
    rules = replacements(plan)
    report(plan, references(plan, rules))
    pending = bool(plan.moves or plan.conflicts or plan.tracked)
    found = blockers(root, args.run or configured_run(root)) if plan.moves else []
    for reason in found:
        print(f"막음 {reason}", file=sys.stderr)
    if not args.apply:
        did = finish(plan, rules, apply=False)
        if not pending and not did:
            print("옮길 것이 없다")
        return 1 if plan.conflicts or plan.tracked else 0
    if plan.conflicts:
        print("겹침이 있어 아무것도 옮기지 않았다", file=sys.stderr)
        return 1
    if found:
        print("worker 와 머지 큐가 끝난 뒤 다시 돌린다", file=sys.stderr)
        return 3
    if not apply_moves(plan):
        return 1
    did = finish(plan, rules, apply=True)
    if not pending and not did:
        print("옮길 것이 없다")
    return 1 if plan.tracked else 0


if __name__ == "__main__":
    sys.exit(main())
