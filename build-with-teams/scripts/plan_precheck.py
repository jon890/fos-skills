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

DONE_STATUS = {"completed"}
STOPPED_STATUS = {"cancelled", "failed"}
# 구현 커밋과 기획 커밋을 가르는 경로. 이 밖을 건드리면 구현으로 본다.
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


def find_local(repo: Path, plan: str) -> Path | None:
    """plan 이름이나 그 앞부분으로 task 디렉터리를 찾는다."""
    tasks = repo / "tasks"
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


def load_remote_index(repo: Path, branch: str, name: str) -> dict | None:
    """브랜치에만 있는 task 를 읽는다. planning 이 push 한 직후가 이 상태다."""
    # branch_facts 가 방금 fetch 했다. origin/<branch> 는 오래됐을 수 있다.
    blob = try_run(["git", "show", f"FETCH_HEAD:tasks/{name}/index.json"], repo)
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


def branch_facts(repo: Path, branch: str) -> dict:
    remote_ref = f"refs/heads/{branch}"
    ls = run(["git", "ls-remote", "--heads", "origin", branch], repo)
    exists = any(line.endswith(remote_ref) for line in ls.splitlines())
    facts = {"branch": branch, "remote_exists": exists}
    if not exists:
        return facts

    run(["git", "fetch", "--quiet", "origin", branch], repo)
    changed = try_run(
        ["git", "diff", "--name-only", "origin/main...FETCH_HEAD"], repo
    ) or ""
    impl = [
        f for f in changed.splitlines()
        if f and not f.startswith(PLANNING_PREFIXES)
    ]
    facts["impl_files"] = impl
    facts["has_impl_commits"] = bool(impl)

    merged = try_run(["git", "branch", "--remotes", "--contains", "FETCH_HEAD"], repo) or ""
    facts["merged_into_main"] = any(
        line.strip() in ("origin/main", "origin/HEAD -> origin/main")
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

    if status in DONE_STATUS and not branch.get("merged_into_main"):
        found.append(
            "completed 인데 브랜치가 main 에 머지되지 않았다. 완료 표기가 실제와 어긋난다."
        )

    return found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("plan", help="task 디렉터리 이름이나 그 앞부분 (예: plan260)")
    ap.add_argument("--repo", default=".", help="저장소 루트 (기본: 현재 디렉터리)")
    ap.add_argument("--branch", help="원격 브랜치 이름 (기본: task 디렉터리 이름)")
    ap.add_argument("--json", action="store_true", help="사실을 JSON 으로 출력한다")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    try:
        task_dir = find_local(repo, args.plan)
        name = task_dir.name if task_dir else args.plan
        branch = branch_facts(repo, args.branch or name)
        prs = open_pr(repo, branch["branch"]) if branch["remote_exists"] else []

        if task_dir:
            index = parse_index(task_dir / "index.json")
            where = "로컬"
        elif branch["remote_exists"]:
            index = load_remote_index(repo, branch["branch"], name)
            where = "브랜치"
        else:
            index = None
            where = "없음"

        if index is None and not branch["remote_exists"]:
            raise PrecheckError(
                f"'{args.plan}' 의 index.json 을 로컬 tasks/ 에서도 "
                f"원격 브랜치에서도 찾지 못했다. planning 을 먼저 돌린다."
            )
    except PrecheckError as exc:
        print(f"검사를 돌리지 못했다: {exc}", file=sys.stderr)
        return 2

    if index is None:
        # 브랜치는 있는데 task 가 없다. planning 이 중단됐거나 push 되지 않았다.
        found = [
            f"`{branch['branch']}` 브랜치는 있는데 그 안에 tasks/{name}/index.json 이 없다. "
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
            found.insert(0, f"task 가 로컬 tasks/ 에 없고 `{branch['branch']}` 브랜치에만 있다.")

    if args.json:
        print(json.dumps(
            {"task": str(task_dir) if task_dir else name, "found_in": where,
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
