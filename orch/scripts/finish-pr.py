#!/usr/bin/env python3
"""PR 하나의 머지 뒤 마무리를 끝까지 한다: worker 정리, 배포 확인, 업무 완료, 보드 done.

머지 큐(`merge_queue.py`)를 건 자리에서 PR 마다 함께 건다. 보통은 `merge-with-finish.py` 가 대신 건다.
코디네이터가 머지 뒤 단계를 잊거나, 정리가 GitHub 상태 반영보다 먼저 돌아 워크트리가 남는 일을 막는다.

사용법:
    finish-pr.py PR [--complete] [--repo DIR] [--config FILE] [옵션...]

    1. PR 이 MERGED 가 될 때까지 기다린다(--merge-timeout). 머지 없이 닫히면 FINISH-FAIL 이다
       머지된 것을 gh 로 직접 확인한 뒤에야 정리한다. 머지 직후 `cleanup-sweep.py` 는 GitHub 상태가 아직
       반영되지 않아 「살아 있는 터미널」 로 건너뛰고 워크트리를 남긴 적이 있다
    2. 그 PR 브랜치의 worker 를 정리한다. `cleanup-sweep.py --apply` 가 dispatch 해제, 터미널 닫기,
       워크트리와 브랜치 삭제를 맡고, 이 스크립트는 그 브랜치의 워크트리가 사라졌는지 확인하며 다시 시도한다.
       --specs-dir 와 --complete 를 함께 주면 `브랜치:` 줄이 그 브랜치인 지시서를 지운다.
       --complete 가 없으면 지시서는 남긴다. 업무 하나가 PR 여럿이면 다음 PR 에도 지시서를 쓴다
    3. --deploy-workflow 와 --deploy-branch 를 주면, 머지 커밋을 조상으로 가진 커밋의 배포 실행이
       성공할 때까지 기다린다(--deploy-timeout). 뒤 커밋의 배포에 합쳐져 머지 커밋의 실행이 skipped 나
       cancelled 로 끝나도 뒤 커밋의 실행이 성공하면 성공이다. 판정은 deploy_verdict 가 소유한다
    4. --complete 면 PR 제목에서 --task-pattern 으로 업무 번호를 뽑아 --complete-cmd 를 돌린다.
       업무의 마지막 PR 일 때만 준다. 배포가 실패하면 돌리지 않는다.
       --complete-cmd 가 없으면(업무 시스템이 없는 저장소) 이 단계만 건너뛰고 로그에 남긴다. 지시서는 지운다.
       --complete-cmd 를 주면 --task-pattern 도 있어야 한다
    5. --board-id 를 주면 그 보드 항목을 done 으로 바꾼다

옵션 (저장소마다 다른 값이다. --config 의 JSON 키는 옵션 이름의 하이픈을 밑줄로 바꾼 것이다):
    --repo DIR            대상 저장소. 기본은 현재 디렉터리
    --config FILE         옵션 값을 담은 JSON. 「finish」 절을 읽는다. 없으면 <repo>/.claude/orch-finish.json 이 있을 때 쓴다. 명령줄이 우선한다
    --gh-host HOST        gh 와 git 에 줄 GH_HOST (예: github.example.com). 없으면 gh 가 정한다
    --run RUN_ID          worker 를 찾을 Orca Run. 없으면 dispatch 해제는 건너뛰고 터미널만 경로로 찾는다
    --base-branch NAME    cleanup-sweep.py 의 --base
    --sweep-arg ARG       cleanup-sweep.py 에 더 넘길 인자. 하나씩 준다
    --specs-dir DIR       지시서 폴더. --complete 일 때만 `브랜치:` 줄이 이 PR 의 브랜치인 spec-*.md 를 지운다.
                          중간 PR 에서는 지시서를 남기고 그 사실을 로그에 한 줄 남긴다
    --deploy-workflow F   배포 워크플로 파일 이름 (예: deploy.yml)
    --deploy-branch B     배포가 도는 브랜치 (예: develop)
    --task-pattern RE     PR 제목에서 업무 번호를 뽑는 정규식. 첫 번째 그룹이 번호다 (예: '^\\[?(PROJ-[0-9]+)')
    --complete            이 PR 이 업무의 마지막 PR 이다. --complete-cmd 없이도 쓴다(지시서 삭제만 한다)
    --complete-cmd CMD    업무 완료 명령 틀. 공백으로 나뉘고 {number} 가 업무 번호로 바뀐다. 셸을 거치지 않는다
                          (예: 'task-cli complete {number}')
    --board FILE          보드 파일. 기본은 <repo>/.omc/board.json, 있으면 <repo>/.omc/handoffs/board.json
    --board-id ID         done 으로 바꿀 보드 항목
    --board-bin PATH      보드 명령. 기본은 BOARD_BIN 환경 변수, 없으면 이 저장소의 work-board/bin/board.py
    --merge-timeout MIN   머지 대기 한도(분). 기본 180
    --deploy-timeout MIN  배포 대기 한도(분). 기본 120
    --poll-interval SEC   확인 간격(초). 기본 30
    --pid-file FILE       시작할 때 pid 를 쓰고 끝나면 지운다. 같은 PR 의 마무리가 둘 도는 것을 막을 때 쓴다

CLEANUP_SWEEP 환경 변수로 정리 스크립트 경로를, GH 와 GIT 로 실행 파일을 바꾼다.

출력의 마지막 줄은 FINISH-DONE 이나 FINISH-FAIL 이다. 그 줄이 없으면 아직 돌고 있거나 죽은 것이다.

종료 코드: 0 FINISH-DONE, 1 FINISH-FAIL, 2 사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
GH = os.environ.get("GH", "gh")
GIT = os.environ.get("GIT", "git")
SWEEP = os.environ.get("CLEANUP_SWEEP", str(HERE / "cleanup-sweep.py"))
BOARD_BIN = HERE.parents[1] / "work-board/bin/board.py"
NUMBER_OK = re.compile(r"[A-Za-z0-9._/-]+$")
BRANCH_LINE = re.compile(r"^\s*(?:[-*]\s+)?(?:\*\*)?브랜치:(?:\*\*)?\s*`([^`]+)`")
CLEANUP_TRIES = 5
DEFAULT_CONFIG = ".claude/orch-finish.json"


def log(line):
    print(f"{datetime.now():%H:%M} {line}", flush=True)


# ---- 판정 (순수 함수) ----------------------------------------------------------------------------------

def extract_task_number(title, pattern):
    """PR 제목에서 업무 번호를 뽑는다. 패턴이 없거나 맞지 않거나 번호가 안전하지 않으면 None 이다."""
    if not pattern:
        return None
    found = re.search(pattern, title or "")
    if not found or not found.groups() or not found.group(1):
        return None
    number = found.group(1)
    return number if NUMBER_OK.match(number) else None


def deploy_verdict(runs, merge, is_ancestor):
    """머지 커밋이 배포됐는지 판정한다. ("success", sha), ("failure", sha), ("wait", None) 중 하나다.

    runs 는 `gh run list --json headSha,status,conclusion` 의 목록이다.
    머지 커밋과 같거나 그 뒤 커밋의 실행만 센다(is_ancestor(merge, sha)).
    - 센 실행 중 성공이 하나라도 있으면 성공이다. 머지 커밋의 실행이 뒤 커밋의 실행에 합쳐져
      skipped 나 cancelled 로 끝나도 뒤 커밋이 성공하면 이 커밋은 배포된 것이다
    - 성공이 없고 아직 끝나지 않은 실행이 있으면 기다린다. 그 실행이 뒤 커밋의 것일 수 있다
    - 성공도 진행 중도 없고 실패나 취소가 있으면 실패다. skipped 만 있으면 기다린다
    """
    failed = None
    waiting = False
    for run in runs:
        sha = run.get("headSha") or ""
        if not sha or not is_ancestor(merge, sha):
            continue
        if run.get("status") != "completed":
            waiting = True
        elif run.get("conclusion") == "success":
            return "success", sha
        elif run.get("conclusion") in ("failure", "cancelled", "timed_out", "startup_failure"):
            failed = failed or sha
    if waiting:
        return "wait", None
    if failed:
        return "failure", failed
    return "wait", None


def spec_branches(text):
    """지시서에서 줄 머리의 `브랜치: \\`x\\`` 줄들이 가리키는 브랜치 이름."""
    return {m.group(1) for line in text.splitlines() if (m := BRANCH_LINE.match(line))}


def worktree_for_branch(porcelain, branch):
    """`git worktree list --porcelain` 출력에서 그 브랜치를 체크아웃한 워크트리 경로. 없으면 None."""
    path = None
    for line in porcelain.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line == f"branch refs/heads/{branch}":
            return path
    return None


def complete_argv(template, number):
    return [part.replace("{number}", number) for part in shlex.split(template)]


# ---- 실행 ----------------------------------------------------------------------------------------------

def run(cmd, cwd=None, timeout=300):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)
    return done.returncode, done.stdout, done.stderr


def pr_info(pr, repo):
    """(state, merge 커밋, head 브랜치, 제목). 조회에 실패하면 state 가 빈 문자열이다."""
    code, out, _ = run([GH, "pr", "view", pr, "--json", "state,mergeCommit,headRefName,title"], cwd=repo)
    if code != 0:
        return "", "", "", ""
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return "", "", "", ""
    return (data.get("state") or "", (data.get("mergeCommit") or {}).get("oid") or "",
            data.get("headRefName") or "", data.get("title") or "")


def wait_merged(pr, repo, timeout_s, interval):
    """MERGED 면 (merge, branch, title). 닫혔거나 시간이 지나면 None 이다."""
    deadline = time.monotonic() + timeout_s
    while True:
        state, merge, branch, title = pr_info(pr, repo)
        if state == "MERGED":
            return merge, branch, title
        if state == "CLOSED":
            log(f"PR {pr} 가 머지 없이 닫혔다")
            return None
        if time.monotonic() >= deadline:
            log(f"PR {pr} 머지를 기다리다 시간이 지났다")
            return None
        time.sleep(interval)


def worktree_path(repo, branch):
    _, out, _ = run([GIT, "worktree", "list", "--porcelain"], cwd=repo)
    return worktree_for_branch(out, branch)


def local_branch_exists(repo, branch):
    return run([GIT, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=repo)[0] == 0


def cleanup_worker(args, repo, branch):
    """sweep 를 돌려 그 브랜치의 워크트리와 로컬 브랜치가 사라질 때까지 다시 시도한다. 사라졌으면 True.

    로컬 브랜치 이름이 PR 의 head 브랜치 이름과 다르면 head 이름으로는 워크트리가 보이지 않는다.
    그래서 보이지 않아도 sweep 를 한 번은 돌린다. sweep 가 PR 을 upstream 이름 등으로 찾아 정리한다.
    """
    cmd = [sys.executable, SWEEP, "--repo", str(repo), "--apply", "--kill-holders"]
    cmd += ["--run", args.run] if args.run else []
    cmd += ["--base", args.base_branch] if args.base_branch else []
    for extra in args.sweep_arg:
        cmd.append(extra)
    for attempt in range(1, CLEANUP_TRIES + 1):
        run([GIT, "fetch", "--prune", "-q", "origin"], cwd=repo)
        _, out, err = run(cmd, cwd=repo, timeout=600)
        for line in (out + err).splitlines():
            log(f"sweep: {line}")
        if not worktree_path(repo, branch) and not local_branch_exists(repo, branch):
            return True
        if attempt < CLEANUP_TRIES:
            time.sleep(args.poll_interval)
    return False


def delete_specs(specs_dir, repo, branch):
    root = Path(specs_dir)
    root = root if root.is_absolute() else repo / root
    for spec in sorted(root.glob("spec-*.md")):
        try:
            text = spec.read_text(encoding="utf-8")
        except OSError:
            continue
        if branch in spec_branches(text):
            spec.unlink()
            log(f"지시서 삭제 {spec}")


def wait_deployed(args, repo, merge):
    """("success", sha) 나 ("failure", sha) 나 ("timeout", None)."""
    deadline = time.monotonic() + args.deploy_timeout * 60

    def is_ancestor(ancestor, sha):
        return run([GIT, "merge-base", "--is-ancestor", ancestor, sha], cwd=repo)[0] == 0

    while True:
        run([GIT, "fetch", "-q", "origin", args.deploy_branch], cwd=repo)
        code, out, _ = run([GH, "run", "list", "--branch", args.deploy_branch, "--workflow", args.deploy_workflow,
                            "--limit", "15", "--json", "headSha,status,conclusion"], cwd=repo)
        runs = []
        if code == 0:
            try:
                runs = json.loads(out)
            except json.JSONDecodeError:
                pass
        verdict, sha = deploy_verdict(runs, merge, is_ancestor)
        if verdict != "wait":
            return verdict, sha
        if time.monotonic() >= deadline:
            return "timeout", None
        time.sleep(args.poll_interval)


def default_board(repo):
    nested = repo / ".omc/handoffs/board.json"
    return nested if nested.exists() else repo / ".omc/board.json"


def set_board_done(args, repo, item):
    board = Path(args.board) if args.board else default_board(repo)
    cmd = ["python3", args.board_bin, "set", item, "done", "--worktree", "", "--pr", "", "--next", "",
           "--file", str(board)]
    code, _, err = run(cmd, cwd=repo)
    if code != 0:
        log(f"보드 명령이 실패했다: {err.strip()}")
    return code == 0


# ---- 진입점 --------------------------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("pr")
    p.add_argument("--repo", default=".")
    p.add_argument("--config")
    p.add_argument("--gh-host")
    p.add_argument("--run")
    p.add_argument("--base-branch")
    p.add_argument("--sweep-arg", action="append", default=[])
    p.add_argument("--specs-dir")
    p.add_argument("--deploy-workflow")
    p.add_argument("--deploy-branch")
    p.add_argument("--task-pattern")
    p.add_argument("--complete", action="store_true")
    p.add_argument("--complete-cmd")
    p.add_argument("--board")
    p.add_argument("--board-id")
    p.add_argument("--board-bin", default=os.environ.get("BOARD_BIN", str(BOARD_BIN)))
    p.add_argument("--merge-timeout", type=float, default=180)
    p.add_argument("--deploy-timeout", type=float, default=120)
    p.add_argument("--poll-interval", type=float, default=30)
    p.add_argument("--pid-file")
    return p


def load_config(parser, argv):
    """--config 파일(없으면 <repo>/.claude/orch-finish.json)의 값을 기본값으로 깔고 다시 읽는다. 명령줄이 우선한다."""
    first, _ = parser.parse_known_args(argv)
    path = Path(first.config) if first.config else Path(first.repo) / DEFAULT_CONFIG
    if path.is_file():
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            parser.error(f"설정 파일을 읽지 못했다: {path}: {exc}")
        config = config.get("finish", {}) if isinstance(config, dict) else None
        if not isinstance(config, dict):
            parser.error("설정 파일의 \"finish\" 절은 객체여야 한다")
        known = {a.dest for a in parser._actions} - {"pr", "config", "help"}
        unknown = sorted(set(config) - known)
        if unknown:
            parser.error(f"설정 파일에 모르는 키가 있다: {', '.join(unknown)}")
        if isinstance(config.get("sweep_arg"), str):
            parser.error("sweep_arg 는 문자열 목록이다")
        parser.set_defaults(**config)
    return parser.parse_args(argv)


def validate(parser, args):
    if bool(args.deploy_workflow) != bool(args.deploy_branch):
        parser.error("--deploy-workflow 와 --deploy-branch 는 함께 준다")
    if args.complete and args.complete_cmd and not args.task_pattern:
        parser.error("--complete-cmd 를 주면 --task-pattern 도 있어야 한다")
    if args.complete_cmd and "{number}" not in args.complete_cmd:
        parser.error("--complete-cmd 에 {number} 가 없다")
    if args.task_pattern:
        try:
            if re.compile(args.task_pattern).groups < 1:
                parser.error("--task-pattern 에 업무 번호를 담을 그룹이 없다")
        except re.error as exc:
            parser.error(f"--task-pattern 이 정규식이 아니다: {exc}")
    if not re.fullmatch(r"\d+", args.pr):
        parser.error(f"PR 번호가 아니다: {args.pr}")


def main(argv=None):
    parser = build_parser()
    try:
        args = load_config(parser, sys.argv[1:] if argv is None else argv)
        validate(parser, args)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if args.gh_host:
        os.environ["GH_HOST"] = args.gh_host
    repo = Path(args.repo).resolve()
    pid_file = Path(args.pid_file) if args.pid_file else None
    if pid_file:
        pid_file.parent.mkdir(parents=True, exist_ok=True)
        pid_file.write_text(str(os.getpid()))
    try:
        return finish(args, repo)
    finally:
        if pid_file:
            pid_file.unlink(missing_ok=True)


def fail(reason=None):
    if reason:
        log(reason)
    print("FINISH-FAIL", flush=True)
    return 1


def finish(args, repo):
    merged = wait_merged(args.pr, repo, args.merge_timeout * 60, args.poll_interval)
    if merged is None:
        return fail()
    merge, branch, title = merged
    log(f"PR {args.pr} 머지됨 {merge[:9]} ({branch})")

    if not cleanup_worker(args, repo, branch):
        log(f"정리 남음: {branch} 의 워크트리나 로컬 브랜치가 남았다. cleanup-sweep.py 출력을 본다")
    if args.specs_dir:
        if args.complete:
            delete_specs(args.specs_dir, repo, branch)
        else:
            log("지시서 유지: 업무의 마지막 PR(--complete)이 아니다")

    if args.deploy_workflow:
        verdict, sha = wait_deployed(args, repo, merge)
        if verdict == "failure":
            return fail(f"배포 실패 {sha[:9]}")
        if verdict == "timeout":
            return fail("배포를 기다리다 시간이 지났다")
        log(f"배포 성공 {sha[:9]}")

    problems = []
    if args.complete and not args.complete_cmd:
        log("업무 완료 단계 건너뜀: --complete-cmd 가 없다")
    elif args.complete:
        number = extract_task_number(title, args.task_pattern)
        if number is None:
            problems.append(f"PR 제목에서 업무 번호를 찾지 못했다: {title}")
        else:
            code, out, err = run(complete_argv(args.complete_cmd, number), cwd=repo)
            last = (out.strip() or err.strip()).splitlines()[-1:] or [""]
            if code == 0:
                log(f"업무 {number} 완료 처리: {last[0]}")
            else:
                problems.append(f"업무 {number} 완료 명령이 실패했다(종료 코드 {code}): {last[0]}")
    if args.board_id:
        if set_board_done(args, repo, args.board_id):
            log(f"보드 {args.board_id} done")
        else:
            problems.append(f"보드 {args.board_id} 를 done 으로 바꾸지 못했다")
    if problems:
        return fail("; ".join(problems))
    print("FINISH-DONE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
