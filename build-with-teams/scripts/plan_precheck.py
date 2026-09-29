#!/usr/bin/env python3
"""build-with-teams 사전 검증. 재실행 사고를 막는 사실을 모아 판정한다.

종료 코드
  0  진행 가능
  1  사용자 결정 필요 (발견 사항을 출력한다)
  2  검사기가 돌지 못함
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

# 계획서를 지우지 않던 때의 완료 표시다. 지운 계획서는 find_deleted 가 찾는다.
DONE_STATUS = {"completed"}
STOPPED_STATUS = {"cancelled", "failed"}
# 구현 커밋과 기획 커밋을 구분하는 경로의 기본값. 이 밖을 건드리면 구현으로 본다.
# 모노레포는 --tasks-dir 와 --docs-dir 로 하위 프로젝트 경로를 넘긴다.
PLANNING_PREFIXES = ("tasks/", "docs/")


class PrecheckError(RuntimeError):
    """검사를 이어 갈 수 없을 때 낸다."""


def run(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise PrecheckError(f"{' '.join(args)} 실패: {proc.stderr.strip()}")
    return proc.stdout.strip()


def try_run(args: list[str], cwd: Path) -> str | None:
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else None


def find_local(repo: Path, plan: str, tasks_dir: str = "tasks") -> Path | None:
    """plan 이름이나 그 앞부분으로 task 디렉터리를 찾는다."""
    tasks = repo / tasks_dir
    if not tasks.is_dir():
        return None
    exact = tasks / plan
    if (exact / "index.json").is_file():
        return exact
    hits = sorted(
        d for d in tasks.iterdir()
        if d.is_dir() and (d / "index.json").is_file()
        and (d.name == plan or d.name.startswith(f"{plan}-"))
    )
    if len(hits) > 1:
        raise PrecheckError(
            f"'{plan}' 이 여러 디렉터리에 맞는다: {', '.join(d.name for d in hits)}"
        )
    return hits[0] if hits else None


def find_deleted(repo: Path, plan: str, tasks_dir: str = "tasks") -> tuple[str, str] | None:
    """지운 계획서를 git 이력에서 찾는다. (디렉터리 이름, 지운 커밋) 을 낸다.

    구현이 끝난 계획서는 PR 에서 지운다. 지운 뒤에는 로컬에도 브랜치 트리에도 없어서
    이력을 보지 않으면 「planning 을 먼저 돌린다」 로 잘못 안내한다.
    --all 이라 아직 머지되지 않은 PR 브랜치에서 지운 것도 찾는다.
    """
    out = try_run(
        ["git", "log", "--all", "--diff-filter=D", "--format=commit %h", "--name-only",
         "--", f"{tasks_dir}/*/index.json"],
        repo,
    )
    commit = None
    for line in (out or "").splitlines():
        if line.startswith("commit "):
            commit = line.removeprefix("commit ")
            continue
        parts = line.removeprefix(f"{tasks_dir}/").split("/")
        if len(parts) == 2 and parts[1] == "index.json" and (parts[0] == plan or parts[0].startswith(f"{plan}-")):
            return parts[0], commit
    return None


def load_remote_index(repo: Path, branch: str, name: str, tasks_dir: str = "tasks") -> dict | None:
    """브랜치에만 있는 task 를 읽는다. planning 이 push 한 직후가 이 상태다."""
    # branch_facts 가 방금 fetch 했다. origin/<branch> 는 오래됐을 수 있다.
    blob = try_run(["git", "show", f"FETCH_HEAD:{tasks_dir}/{name}/index.json"], repo)
    if blob is None:
        return None
    try:
        return json.loads(blob)
    except json.JSONDecodeError as exc:
        raise PrecheckError(f"{branch} 의 index.json 을 읽지 못했다: {exc}") from exc


def parse_index(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise PrecheckError(f"{path} 를 읽지 못했다: {exc}") from exc


def resolve_base(repo: Path, explicit: str | None = None) -> str:
    """명시 인자, 저장소 Git 설정, 원격 기본 브랜치 순으로 정한다."""
    base = explicit or try_run(["git", "config", "--local", "--get", "build-with-teams.baseBranch"], repo)
    if not base:
        remote = run(["git", "ls-remote", "--symref", "origin", "HEAD"], repo)
        for line in remote.splitlines():
            if line.startswith("ref: refs/heads/") and line.endswith("\tHEAD"):
                base = line.split()[1].removeprefix("refs/heads/")
                break
    if not base:
        raise PrecheckError("원격 기본 브랜치를 찾지 못했다. --base 로 기준 브랜치를 지정한다.")
    run(["git", "check-ref-format", "--branch", base], repo)
    return base


def branch_facts(repo: Path, branch: str, base: str, planning_prefixes: tuple[str, ...] = PLANNING_PREFIXES) -> dict:
    remote_ref = f"refs/heads/{branch}"
    ls = run(["git", "ls-remote", "--heads", "origin", branch], repo)
    exists = any(line.endswith(remote_ref) for line in ls.splitlines())
    facts = {"branch": branch, "remote_exists": exists, "base": base}
    if not exists:
        return facts

    # 기준을 먼저 갱신하고 작업 브랜치를 마지막에 fetch 한다. FETCH_HEAD 는 작업 브랜치다.
    run(["git", "fetch", "--quiet", "origin", f"+refs/heads/{base}:refs/remotes/origin/{base}"], repo)
    run(["git", "fetch", "--quiet", "origin", f"refs/heads/{branch}"], repo)
    changed = run(["git", "diff", "--name-only", f"origin/{base}...FETCH_HEAD"], repo)
    impl = [
        f for f in changed.splitlines()
        if f and not f.startswith(planning_prefixes)
    ]
    facts["impl_files"] = impl
    facts["has_impl_commits"] = bool(impl)

    merged = run(["git", "branch", "--remotes", "--contains", "FETCH_HEAD"], repo)
    facts["merged_into_base"] = any(
        line.strip() in (f"origin/{base}", f"origin/HEAD -> origin/{base}")
        for line in merged.splitlines()
    )
    return facts


def open_pr(repo: Path, branch: str) -> list[dict]:
    out = try_run(
        ["gh", "pr", "list", "--head", branch, "--state", "open",
         "--json", "number,title,url"],
        repo,
    )
    if out is None:
        raise PrecheckError("gh pr list 가 실패했다. 인증과 GH_HOST 를 확인한다.")
    return json.loads(out or "[]")


def judge(index: dict, branch: dict, prs: list[dict]) -> list[str]:
    """진행을 막을 사실만 모은다."""
    found = []
    status = index.get("status")

    if status in DONE_STATUS:
        found.append(
            "index.json 상태가 completed 다. 이미 끝난 plan 을 다시 도는 중일 수 있다."
        )
    elif status in STOPPED_STATUS:
        reason = index.get("blocked_reason") or index.get("error_message") or "사유 없음"
        found.append(f"index.json 상태가 `{status}` 다: {reason}")

    if not branch["remote_exists"]:
        if status in DONE_STATUS:
            found.append(
                f"원격에 `{branch['branch']}` 브랜치가 없다. 머지 후 정리된 것으로 보인다."
            )
        else:
            found.append(
                f"원격에 `{branch['branch']}` 브랜치가 없다. "
                "planning 이 push 하지 않았거나 브랜치 이름 형식이 다르다."
            )
        return found

    if branch.get("has_impl_commits"):
        files = ", ".join(branch["impl_files"][:5])
        more = f" 외 {len(branch['impl_files']) - 5}개" if len(branch["impl_files"]) > 5 else ""
        found.append(f"브랜치에 이미 구현 변경이 있다: {files}{more}")

    if prs:
        listed = ", ".join(f"#{p['number']} {p['title']}" for p in prs)
        found.append(f"이 브랜치로 열린 PR 이 있다: {listed}")

    if status in DONE_STATUS and not branch.get("merged_into_base", branch.get("merged_into_main")):
        found.append(
            f"completed 인데 브랜치가 {branch.get('base', 'main')} 에 머지되지 않았다. 완료 표기가 실제와 어긋난다."
        )

    return found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("plan", help="task 디렉터리 이름이나 그 앞부분 (예: plan260)")
    ap.add_argument("--repo", default=".", help="저장소 루트 (기본: 현재 디렉터리)")
    ap.add_argument("--branch", help="원격 브랜치 이름 (기본: task 디렉터리 이름)")
    ap.add_argument("--base", help="기준 브랜치. 저장소 설정에서 정한 값을 넘긴다")
    ap.add_argument("--tasks-dir", default="tasks", help="계획서 디렉터리. 저장소 루트 기준 (기본: tasks)")
    ap.add_argument("--docs-dir", action="append", help="기획 커밋으로 볼 docs 경로. 여러 번 줄 수 있다 (기본: docs)")
    ap.add_argument("--json", action="store_true", help="사실을 JSON 으로 출력한다")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    tasks_dir = args.tasks_dir.rstrip("/")
    prefixes = tuple(f"{d.rstrip('/')}/" for d in [tasks_dir, *(args.docs_dir or ["docs"])])
    try:
        task_dir = find_local(repo, args.plan, tasks_dir)
        name = task_dir.name if task_dir else args.plan
        base = resolve_base(repo, args.base)
        branch = branch_facts(repo, args.branch or name, base, prefixes)
        prs = open_pr(repo, branch["branch"]) if branch["remote_exists"] else []

        if task_dir:
            index = parse_index(task_dir / "index.json")
            where = "로컬"
        elif branch["remote_exists"]:
            index = load_remote_index(repo, branch["branch"], name, tasks_dir)
            where = "브랜치"
        else:
            index = None
            where = "없음"

        deleted = find_deleted(repo, args.plan, tasks_dir) if index is None else None
        if deleted:
            name = deleted[0]
        if index is None and not branch["remote_exists"] and not deleted:
            raise PrecheckError(
                f"'{args.plan}' 의 index.json 을 로컬 {tasks_dir}/ 에서도 "
                f"원격 브랜치에서도 찾지 못했다. planning 을 먼저 돌린다."
            )
    except PrecheckError as exc:
        print(f"검사를 돌리지 못했다: {exc}", file=sys.stderr)
        return 2

    if index is None and deleted:
        found = [
            f"`{deleted[0]}` 은 커밋 {deleted[1]} 에서 지운 계획서다. "
            "구현이 끝난 plan 을 다시 도는 중일 수 있다."
        ]
        if prs:
            found.append(
                "이 브랜치로 열린 PR 이 있다: "
                + ", ".join(f"#{p['number']} {p['title']}" for p in prs)
            )
    elif index is None:
        # 브랜치는 있는데 task 가 없다. planning 이 중단됐거나 push 되지 않았다.
        found = [
            f"`{branch['branch']}` 브랜치는 있는데 그 안에 {tasks_dir}/{name}/index.json 이 없다. "
            "planning 이 중단됐거나 push 되지 않았다."
        ]
        if prs:
            found.append(
                "이 브랜치로 열린 PR 이 있다: "
                + ", ".join(f"#{p['number']} {p['title']}" for p in prs)
            )
    else:
        found = judge(index, branch, prs)
        if where == "브랜치":
            found.insert(0, f"task 가 로컬 {tasks_dir}/ 에 없고 `{branch['branch']}` 브랜치에만 있다.")

    if args.json:
        print(json.dumps(
            {"task": str(task_dir) if task_dir else name,
             "found_in": "지운 계획서" if index is None and deleted else where,
             "deleted_in": deleted[1] if deleted else None,
             "status": index.get("status") if index else None,
             "total_phases": index.get("total_phases") if index else None,
             "current_phase": index.get("current_phase") if index else None,
             "branch": branch, "open_prs": prs, "findings": found},
            ensure_ascii=False, indent=2,
        ))
    elif found:
        print(f"{name}: 사용자 결정이 필요하다.")
        for f in found:
            print(f"  - {f}")
    else:
        print(
            f"{name}: 진행 가능. "
            f"status={index.get('status')} "
            f"phase={index.get('current_phase')}/{index.get('total_phases')}"
        )

    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
