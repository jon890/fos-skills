#!/usr/bin/env python3
"""머지가 끝난 worktree 와 로컬 브랜치, 그 worker 터미널과 지시서를 찾아 정리한다.

머지마다 수동으로 정리하면 잊히고, 프로세스가 worktree 를 잡고 있어 그 자리에서 실패한 것은 다시 돌아보지 않는다.
이 스크립트는 상태로만 판정하므로 몇 번을 돌려도 같다. 건너뛴 항목은 다음 실행에서 다시 판정된다.
사용자가 말하지 않아도 깨어날 때마다 돈다. 코디네이터가 끝난 항목을 직접 지우지 않는다.

사용법 (기본은 dry-run. 무엇을 할지만 낸다):
    cleanup-sweep.py --repo DIR [--repo DIR ...] [--base main] [--run RUN_ID] [--specs-dir DIR] [--kill-holders] [--apply]

    --repo        대상 저장소의 기본 체크아웃. 여러 번 줄 수 있다. 여기서 git worktree 목록과 gh 를 읽는다.
                  하나를 읽지 못해도 나머지는 돌고, 종료 코드만 2 가 된다
    --base        기준 브랜치. 없으면 저장소마다 origin/HEAD 를 읽고, 그것도 없으면 main
    --run         worker 를 찾을 Orca Run. 없으면 worker 확인과 release 를 건너뛰고 터미널만 경로로 찾는다
    --specs-dir   지시서 폴더(저장소 기준 상대경로 또는 절대경로). worktree 이름과 같은
                  `<이름>.md` 와 `spec-<이름>.md` 를 지운다. 없으면 지시서는 건드리지 않는다
    --kill-holders  터미널을 닫은 뒤에도 그 경로를 쓰는 프로세스를 끈다(아래 「남은 프로세스 끄기」)
    --apply       실제로 정리한다

PR 찾기 (브랜치마다):
    로컬 브랜치 이름과 PR 의 head 브랜치 이름이 다르면(`<user>/<접두>-<주제>` 와 `<접두>/<주제>`) 이름 하나로는 못 찾는다.
    아래 순서로 `gh pr list --head` 를 부르고 처음 나온 PR 을 쓴다. fork 에서 온 PR 은 건너뛴다.
      1. 브랜치의 upstream 에서 읽은 원격 브랜치 이름
      2. `git config branch.<b>.merge`
      3. 로컬 브랜치 이름
      4. 이름 변형(사용자 접두 제거, 첫 하이픈을 슬래시로). 지시서의 브랜치 이름으로 만들지 않은 옛 워크트리용이다
    어느 이름으로 찾았든 브랜치 끝 커밋이 PR HEAD 와 같거나 그 조상일 때만 그 PR 을 쓴다.
    base 위 커밋이 0 개인 브랜치는 끝 커밋이 PR HEAD 와 정확히 같을 때만 쓴다.
    예전에 머지된 PR 과 이름만 같은 새 브랜치를 「머지됨」 으로 읽어 일하는 워크트리를 지우지 않으려는 것이다.
    이름은 맞는데 이 검사에 걸린 PR 만 있으면 「이름만 같은 PR」 로 보고 PR 없음과 같이 다룬다.
    조회 결과는 JSON 으로 읽는다. 빈 목록이면 「PR 없음」 이고, JSON 이 아니거나 필드가 없으면 「조회 실패」 다.
    둘 다 머지로 읽지 않는다. PR HEAD 가 로컬에 없으면(머지 큐의 update-branch 로 앞서 간 경우) `refs/pull/<번호>/head` 를 받아 온다.

정리 대상 (브랜치마다):
    - 그 브랜치의 PR 이 MERGED 다
    - PR 이 없거나 MERGED 가 아니면, upstream 이 gone 이고 `git cherry` 로 base 에 없는 커밋이 0 개다

건너뜀 (이유를 낸다):
    - 커밋 안 된 변경이 있다
    - 원격에도 머지된 PR HEAD 에도 없는 커밋이 있다
    - 살아 있는 worker 가 그 worktree 를 맡고 있다. workerState 가 working 이나 ready 이거나,
      Dispatch 상태와 상관없이 그 worker 의 터미널이 `orca terminal list` 에 살아 있으면 살아 있다고 본다.
      Dispatch 가 succeeded 여도 같은 터미널에서 후속 일을 하는 worker 가 있고,
      그 브랜치가 막 만든 상태(base 와 같고 커밋 0)면 머지 판정을 통과해 일하는 worker 를 지우게 된다
    - 터미널을 닫은 뒤에도 그 경로를 작업 디렉터리로 쓰는 프로세스가 있다. 다음 실행에서 다시 시도한다.
      단, PR 이 MERGED 이고 남은 프로세스가 전부 자식 없는 로그인 셸(Orca 가 worker 를 반납한 뒤 띄운 빈 셸)이고
      그 경로에 Orca 터미널이 있으면, 그 터미널을 `orca terminal close` 로 닫고 한 번 더 기다린다

남은 프로세스 끄기 (--kill-holders):
    `worker-stop` 이 `process=none` 을 돌려줘도 그 worker 의 claude 세션, 로그인 셸, 플러그인 node, Gradle 같은
    프로세스가 그 경로를 작업 디렉터리로 쥐고 남아 `remove-worktree.sh` 가 매번 거부한다.
    이 옵션은 아래가 모두 참일 때만 그 프로세스를 TERM, HUP, KILL 순으로 끈다. 신호마다 --wait 초(최소 1초) 기다리고,
    그때도 그 경로를 쓰는 pid 만 다시 골라 다음 신호를 보낸다. 로그인 셸은 TERM 을 무시해 HUP 이 필요하다.
      - PR 이 MERGED 다
      - --run 으로 찾은 그 경로의 worker 가 하나 이상이고, 모두 workerState 가 succeeded 나 fenced 다
      - 그 경로에 Orca 터미널이 남아 있지 않다
      - 프로세스의 작업 디렉터리가 그 경로이거나 그 아래다
    하나라도 거짓이면 끄지 않고 이유를 낸다. 위가 참이어도 아래 프로세스는 빼고 끈다.
      - 이 스크립트와 그 조상
      - 그 경로 안에 놓인 다른 워크트리를 작업 디렉터리로 쓰는 프로세스
      - 조상에 Orca(`Orca.app/` 아래 실행 파일), `login`, 같은 경로를 쥔 프로세스 말고 다른 프로세스가 있는 것.
        Orca 터미널은 `Orca` → `Orca Helper` → `login` → 로그인 셸로 이어진다(실측). iTerm 이나 VS Code 에서
        그 폴더로 들어간 사용자 셸과 language server 는 조상이 그 앱이라 빠진다. 부모를 잃어 launchd(pid 1)
        아래로 간 프로세스는 끈다
    열린 파일로만 그 경로를 쥔 프로세스는 끄지 않는다.
    워크트리 삭제를 막는 것은 작업 디렉터리이고, 작업 디렉터리가 밖에 있는 Gradle daemon 같은 프로세스는
    다른 워크트리의 빌드도 맡을 수 있다.

실행 순서 (worktree 마다):
    그 경로의 Orca 터미널 close(PR 이 MERGED 일 때만), 끝난 Dispatch release, `remove-worktree.sh --delete-branch --merged-head`,
    원격 브랜치 삭제(이미 없으면 통과), 지시서 삭제.
    기준 브랜치, `release/*`, 다른 열린 PR 의 base 인 브랜치는 지우지 않는다.
    worktree 없이 남은 로컬 브랜치도 같은 조건으로 판정해 지운다.

원격 브랜치 삭제:
    지울 이름은 PR 의 head 브랜치, upstream, `branch.<b>.merge`, 로컬 이름이다. 이름마다 기준 브랜치, `release/*`,
    다른 열린 PR 의 base 는 지우지 않는다. 원격 끝점이 머지된 PR HEAD(PR 이 없으면 로컬 브랜치 끝점)와 다르면
    그 뒤에 커밋이 더해진 것이므로 지우지 않는다. fork 에서 온 PR 의 head 이름은 쓰지 않는다.

ORCA, GH, ORCH_KILL 환경 변수로 실행 파일을 바꾼다. 기본 orca, gh, kill.

종료 코드:
    0  돌았다. 건너뛴 항목이 있어도 0 이다
    2  사용법 오류, 또는 저장소를 읽지 못했다
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REMOVE = HERE / "remove-worktree.sh"
LIVE_STATES = {"working", "ready"}
# 이 상태의 worker 만 남은 프로세스를 끌 수 있다. failed 나 abandoned 는 같은 워크트리로 다시 맡길 수 있어 뺀다
FINISHED_STATES = {"succeeded", "fenced"}
STOP_SIGNALS = ("TERM", "HUP", "KILL")
PR_STATES = {"MERGED", "OPEN", "CLOSED"}
SHELLS = {"sh", "bash", "zsh", "fish", "dash", "ksh"}
BY_PR = "PR MERGED"
ORCA = os.environ.get("ORCA", "orca")
GH = os.environ.get("GH", "gh")
KILL = os.environ.get("ORCH_KILL", "kill")
# 조상에 이 문자열이 든 실행 파일이 있으면 Orca 가 띄운 프로세스다
ORCA_APP = "Orca.app/"
MAX_VARIANTS = 4


def run(cmd, cwd=None):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def git(repo, *args):
    return run(["git", "-C", str(repo), *args])


def worktrees(repo):
    """기본 체크아웃을 뺀 (경로, 브랜치) 목록. 브랜치가 없으면 빈 문자열이다."""
    code, out, _ = git(repo, "worktree", "list", "--porcelain")
    if code != 0:
        raise RuntimeError(f"git worktree list 실패: {repo}")
    items, path, branch = [], None, ""
    for line in out.splitlines() + [""]:
        if line.startswith("worktree "):
            path, branch = line[len("worktree "):], ""
        elif line.startswith("branch "):
            branch = line[len("branch "):].removeprefix("refs/heads/")
        elif not line and path:
            items.append((path, branch))
            path = None
    return items[1:]


def default_base(repo):
    code, out, _ = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    return out.removeprefix("origin/") if code == 0 and out.startswith("origin/") else "main"


def pr_list(repo, head):
    """`gh pr list --head` 를 JSON 으로 읽는다. (상태, PR 목록). 상태는 ok 나 error 다.

    빈 목록은 ok 와 [] 다. JSON 이 아니거나 목록이 아니거나 state 가 모르는 값이면 error 다.
    출력 문자열을 비교하지 않고 파싱한다. `null` 같은 문자열이 PR 로 읽히지 않게 한다.
    """
    code, out, _ = run([GH, "pr", "list", "--head", head, "--state", "all", "--limit", "5",
                        "--json", "number,state,headRefOid,headRefName,isCrossRepository"], cwd=repo)
    if code != 0:
        return "error", []
    try:
        prs = json.loads(out) if out else []
    except json.JSONDecodeError:
        return "error", []
    if not isinstance(prs, list):
        return "error", []
    for pr in prs:
        if not isinstance(pr, dict) or pr.get("state") not in PR_STATES or not isinstance(pr.get("number"), int):
            return "error", []
    return "ok", prs


def name_variants(branch):
    """로컬 브랜치 `<user>/<접두>-<주제>` 에 대응할 법한 PR head 이름. `<접두>/<주제>` 가 대표적이다."""
    rest = branch.split("/", 1)[1] if "/" in branch else branch
    names = [rest] if rest != branch else []
    pos = -1
    for _ in range(MAX_VARIANTS - len(names)):
        pos = rest.find("-", pos + 1)
        if pos <= 0:
            break
        names.append(rest[:pos] + "/" + rest[pos + 1:])
    return names


def pr_candidates(repo, branch):
    """(PR head 이름, 이름이 확실한지). upstream, branch.<b>.merge, 로컬 이름이 확실하고 변형은 확인이 필요하다."""
    names = []
    _, remote, _ = git(repo, "config", "--get", f"branch.{branch}.remote")
    _, upstream, _ = git(repo, "for-each-ref", "--format=%(upstream)", f"refs/heads/{branch}")
    prefix = f"refs/remotes/{remote or 'origin'}/"
    if upstream.startswith(prefix):
        names.append((upstream[len(prefix):], True))
    _, merge, _ = git(repo, "config", "--get", f"branch.{branch}.merge")
    if merge.startswith("refs/heads/"):
        names.append((merge[len("refs/heads/"):], True))
    names.append((branch, True))
    names += [(n, False) for n in name_variants(branch)]
    seen, unique = set(), []
    for name, exact in names:
        if name and name not in seen:
            seen.add(name)
            unique.append((name, exact))
    return unique


def ensure_commit(repo, pr):
    """PR HEAD 가 로컬에 없으면 `refs/pull/<번호>/head` 로 받아 온다. 머지 큐의 update-branch 로 앞서 간 HEAD 가 그런 경우다."""
    head = pr.get("headRefOid")
    if not head or git(repo, "cat-file", "-e", f"{head}^{{commit}}")[0] == 0:
        return
    git(repo, "fetch", "-q", "origin", f"refs/pull/{pr['number']}/head")


def belongs_to(repo, ref, base, pr):
    """그 PR 이 이 브랜치의 것인지. 끝 커밋이 PR HEAD 와 같거나 그 조상이어야 한다.

    base 위 커밋이 0 개면 막 만든 브랜치일 수 있다. 그 끝 커밋은 옛 PR HEAD 의 조상(base 의 옛 커밋)이기도 하므로
    PR HEAD 와 정확히 같을 때만 인정한다. 일반 merge 로 머지돼 커밋이 base 에 들어간 브랜치가 이 경우다.
    """
    head = pr.get("headRefOid")
    if not head:
        return False
    code, tip, _ = git(repo, "rev-parse", "--verify", "-q", f"{ref}^{{commit}}")
    if code != 0:
        return False
    if tip == head:
        return True
    code, out, _ = git(repo, "rev-list", "--count", f"origin/{base}..{ref}")
    if code != 0 or out in ("", "0"):
        return False
    return git(repo, "merge-base", "--is-ancestor", ref, head)[0] == 0


def find_pr(repo, branch, base):
    """그 브랜치의 PR. (PR dict 또는 None, 조회 실패가 있었는지, 이름만 같은 PR 이 있었는지)."""
    failed = foreign = False
    for name, _exact in pr_candidates(repo, branch):
        status, prs = pr_list(repo, name)
        if status == "error":
            failed = True
            continue
        for pr in prs:
            if pr.get("isCrossRepository"):
                continue
            ensure_commit(repo, pr)
            if belongs_to(repo, f"refs/heads/{branch}", base, pr):
                return pr, failed, foreign
            foreign = True
    return None, failed, foreign


def merged(repo, branch, base):
    """(머지됐는지, 머지된 PR HEAD, 판정 근거, PR)."""
    pr, failed, foreign = find_pr(repo, branch, base)
    if pr and pr["state"] == "MERGED":
        return True, pr.get("headRefOid"), BY_PR, pr
    state = pr["state"] if pr else ("조회 실패" if failed else "이름만 같은 PR(이 브랜치의 커밋이 아니다)" if foreign else "없음")
    _, track, _ = git(repo, "for-each-ref", "--format=%(upstream:track)", f"refs/heads/{branch}")
    if track != "[gone]":
        return False, None, f"PR {state}, upstream 이 남아 있다", pr
    code, out, _ = git(repo, "cherry", f"origin/{base}", branch)
    if code != 0:
        return False, None, "git cherry 실패", pr
    plus = sum(1 for line in out.splitlines() if line.startswith("+"))
    if plus:
        return False, None, f"upstream gone 이지만 base 에 없는 커밋 {plus} 개", pr
    return True, None, "upstream gone, base 에 없는 커밋 0 개", pr


def unpushed(repo, ref, merged_head, by_cherry):
    """원격에도 머지된 PR HEAD 에도 없는 커밋 수. cherry 로 판정했으면 이미 base 에 있으므로 0 이다."""
    if by_cherry:
        return 0
    args = ["rev-list", ref, "--not", "--remotes"]
    if merged_head and git(repo, "cat-file", "-e", f"{merged_head}^{{commit}}")[0] == 0:
        args.append(merged_head)
    code, out, _ = git(repo, *args)
    return len(out.splitlines()) if code == 0 else -1


def dirty(path):
    code, out, _ = git(path, "status", "--porcelain")
    return code != 0 or bool(out)


def under(child, parent):
    return child == parent or child.startswith(parent + "/")


def holder_cwds(path):
    """그 경로나 하위를 작업 디렉터리로 쓰는 프로세스의 pid 와 작업 디렉터리."""
    _, out, _ = run(["lsof", "-d", "cwd", "-Fpn"])
    found, pid = {}, None
    for line in out.splitlines():
        if line.startswith("p"):
            pid = line[1:]
        elif line.startswith("n") and under(line[1:], path):
            found[pid] = line[1:]
    return found


def holder_pids(path):
    """그 경로나 하위를 작업 디렉터리로 쓰는 프로세스 pid 목록."""
    return list(holder_cwds(path))


def holders(path):
    return len(holder_pids(path))


def ps_rows():
    """pid 마다 (ppid, command)."""
    _, out, _ = run(["ps", "-axo", "pid=,ppid=,command="])
    rows = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            rows[parts[0]] = (parts[1], parts[2])
    return rows


def only_idle_shells(pids):
    """그 프로세스가 모두 자식 없는 로그인 셸이면 True. 로그인 셸은 argv[0] 이 `-` 로 시작한다(`-/bin/zsh`)."""
    if not pids:
        return False
    table = ps_rows()
    rows = {pid: command for pid, (_, command) in table.items()}
    parents = {ppid for ppid, _ in table.values()}
    for pid in pids:
        argv0 = rows.get(pid, "").split(None, 1)[0] if rows.get(pid) else ""
        if not argv0.startswith("-") or Path(argv0[1:]).name not in SHELLS or pid in parents:
            return False
    return True


def orca_json(*args):
    code, out, _ = run([ORCA, *args, "--json"])
    if code != 0:
        return None
    try:
        return json.loads(out)["result"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def workers_at(workers, path):
    return [w for w in workers if str((w.get("resource") or {}).get("worktreeId", "")).endswith("::" + path)]


def live_terminals():
    """살아 있는 터미널 목록. 조회에 실패하면 None 이다."""
    result = orca_json("terminal", "list")
    return None if result is None else result.get("terminals", [])


def terminals_at(terminals, path):
    return [t["handle"] for t in terminals or [] if t.get("worktreePath") == path and t.get("handle")]


def close_terminals(handles, apply, log, what="터미널"):
    for handle in handles:
        if apply:
            code, _, _ = run([ORCA, "terminal", "close", "--terminal", handle, "--json"])
            log(f"  {what} 닫음 {handle}" if code == 0 else f"  {what} 닫기 실패 {handle}")
        else:
            log(f"  {what}을 닫을 것 {handle}")


def wait_free(path, seconds):
    """그 경로를 쓰는 프로세스가 빠지기를 기다린다. 남은 pid 목록을 돌려준다."""
    pids = holder_pids(path)
    for _ in range(seconds):
        if not pids:
            break
        time.sleep(1)
        pids = holder_pids(path)
    return pids


def own_ancestors():
    """이 스크립트와 그 조상의 pid. 이 스크립트를 부른 셸이 그 경로에 있어도 끄지 않는다."""
    parent = {pid: ppid for pid, (ppid, _) in ps_rows().items()}
    pid, seen = str(os.getpid()), set()
    while pid and pid not in seen and pid not in ("0", "1"):
        seen.add(pid)
        pid = parent.get(pid)
    return seen


def kill_blocker(mine, path, by_pr, check_terminals=True):
    """남은 프로세스를 끄면 안 되는 이유. 끌 수 있으면 None 이다.

    dry-run 은 터미널을 닫기 전이라 `check_terminals` 를 끈다. 실제 실행은 MERGED 면 터미널을 먼저 닫는다.
    """
    if not by_pr:
        return "PR 이 MERGED 가 아니다"
    if not mine:
        return "그 경로의 worker 를 모른다(--run 이 없거나 그 Run 에 없다)"
    unfinished = [w.get("dispatchId", "?") for w in mine if w.get("workerState") not in FINISHED_STATES]
    if unfinished:
        return f"끝나지 않은 dispatch {', '.join(unfinished)}"
    if not check_terminals:
        return None
    terminals = live_terminals()
    if terminals is None or terminals_at(terminals, path):
        return "그 경로에 Orca 터미널이 남아 있거나 터미널 목록을 읽지 못했다"
    return None


def describe(pids):
    rows = ps_rows()
    return ", ".join(f"{pid} {Path(rows[pid][1].split(None, 1)[0].lstrip('-')).name}" if pid in rows else pid for pid in pids)


def started_outside_orca(pid, rows, holders):
    """조상에 Orca, `login`, 같은 경로를 쥔 프로세스 말고 다른 프로세스가 있으면 True. 조상을 못 읽어도 True 다."""
    seen = set()
    while True:
        row = rows.get(pid)
        if row is None:
            return True
        pid = row[0]
        if pid in ("0", "1"):
            return False
        if pid in seen:
            return True
        seen.add(pid)
        command = rows.get(pid, ("", ""))[1]
        if not (pid in holders or ORCA_APP in command or Path(command.split(None, 1)[0] if command else "").name == "login"):
            return True


def targets(path, nested, log=None):
    """끌 pid 목록. 빼는 것은 머리 주석의 「남은 프로세스 끄기」 가 정한다."""
    cwds = holder_cwds(path)
    rows, keep = ps_rows(), own_ancestors()
    chosen, skipped = [], []
    for pid, cwd in cwds.items():
        if pid in keep or any(under(cwd, other) for other in nested) or started_outside_orca(pid, rows, cwds):
            skipped.append(pid)
        else:
            chosen.append(pid)
    if skipped and log:
        log(f"  Orca 밖에서 띄웠거나 다른 워크트리를 쓰는 프로세스라 끄지 않는다: {describe(skipped)}")
    return chosen


def stop_holders(path, nested, seconds, log):
    """`targets` 가 고른 프로세스를 TERM, HUP, KILL 순으로 끈다. 그 경로를 아직 쓰는 pid 목록을 돌려준다.

    신호마다 대상을 다시 고른다. 앞 신호로 빠진 pid 가 다른 프로세스로 재사용돼도 닿지 않는다.
    """
    pids = targets(path, nested, log)
    for sig in STOP_SIGNALS:
        if not pids:
            break
        log(f"  {sig} 를 보낸다: {describe(pids)}")
        run([KILL, f"-{sig}", *pids])
        wait_free(path, max(seconds, 1))
        pids = targets(path, nested)
    return holder_pids(path)


def protected(repo, branch, base):
    if branch == base or branch.startswith("release/"):
        return "기준 브랜치나 release 브랜치"
    code, out, _ = run([GH, "pr", "list", "--state", "open", "--base", branch, "--json", "number", "--jq", "length"], cwd=repo)
    if code != 0 or out not in ("", "0"):
        return "다른 열린 PR 의 base 이거나 조회 실패"
    return None


def remote_plan(repo, branch, pr):
    """지울 원격 브랜치 이름과, 그 끝점이 가져야 할 커밋. 로컬 브랜치를 지우기 전에 만든다."""
    names = [name for name, exact in pr_candidates(repo, branch) if exact]
    if pr and not pr.get("isCrossRepository") and pr.get("headRefName"):
        names.insert(0, pr["headRefName"])
    expect = pr.get("headRefOid") if pr and pr.get("state") == "MERGED" else git(repo, "rev-parse", f"refs/heads/{branch}")[1]
    return list(dict.fromkeys(names)), expect


def delete_remote(repo, plan, base, apply, log):
    names, expect = plan
    for name in names:
        reason = protected(repo, name, base)
        if reason:
            log(f"  원격 브랜치 남김 {name}: {reason}")
            continue
        code, out, _ = git(repo, "ls-remote", "--heads", "origin", f"refs/heads/{name}")
        if code != 0:
            log(f"  원격 브랜치 확인 실패 {name}")
            continue
        if not out:
            log(f"  원격 브랜치 이미 없음 {name}")
            continue
        tip = out.split()[0]
        if expect and tip != expect:
            log(f"  원격 브랜치 남김 {name}: 끝점이 머지된 커밋과 다르다")
            continue
        if apply:
            code, _, err = git(repo, "push", "-q", "origin", "--delete", name)
            log(f"  원격 브랜치 삭제 {name}" if code == 0 else f"  원격 브랜치 삭제 실패 {name}: {err}")
        else:
            log(f"  원격 브랜치를 지울 것 {name}")


def delete_specs(specs_dir, name, apply, log):
    if not specs_dir:
        return
    for candidate in (specs_dir / f"{name}.md", specs_dir / f"spec-{name}.md"):
        if candidate.is_file():
            if apply:
                candidate.unlink()
                log(f"  지시서 삭제 {candidate}")
            else:
                log(f"  지시서를 지울 것 {candidate}")


def sweep_worktree(repo, path, branch, args, workers, terminals, specs_dir, log):
    name = Path(path).name
    if not branch:
        log(f"건너뜀 {path}: 브랜치가 없다(detached)")
        return
    reason = protected(repo, branch, args.base)
    if reason:
        log(f"건너뜀 {path}: {reason} ({branch})")
        return
    ok, merged_head, why, pr = merged(repo, branch, args.base)
    if not ok:
        log(f"남김 {path}: {why}")
        return
    if dirty(path):
        log(f"건너뜀 {path}: 커밋 안 된 변경")
        return
    lost = unpushed(path, "HEAD", merged_head, merged_head is None)
    if lost:
        log(f"건너뜀 {path}: 원격에 없는 커밋 {lost if lost > 0 else '확인 실패'}")
        return
    mine = workers_at(workers, path)
    alive = {t.get("handle") for t in terminals or []}
    live = [w for w in mine if w.get("workerState") in LIVE_STATES or w.get("agentTerminalHandle") in alive]
    if live:
        log(f"건너뜀 {path}: 살아 있는 worker {', '.join(w.get('dispatchId', '?') for w in live)}")
        return
    by_pr = why == BY_PR
    if not by_pr and terminals_at(terminals, path):
        log(f"건너뜀 {path}: 살아 있는 터미널이 있다. PR 이 MERGED 가 아니면 터미널을 닫지 않는다")
        return

    log(f"정리 {path} ({branch}, {why})")
    plan = remote_plan(repo, branch, pr)
    # 터미널은 PR 이 MERGED 일 때만 닫는다. cherry 로만 판정한 브랜치는 막 만든 브랜치일 수 있다
    close_terminals(terminals_at(terminals, path) if by_pr else [], args.apply, log)
    for w in mine:
        dispatch = w.get("dispatchId")
        if not dispatch or (w.get("resource") or {}).get("releaseState") == "released":
            continue
        if args.apply:
            code, _, _ = run([ORCA, "orchestration", "worker-release", "--dispatch", dispatch, "--json"])
            log(f"  dispatch release {dispatch}" if code == 0 else f"  dispatch release 실패 {dispatch}")
        else:
            log(f"  dispatch 를 release 할 것 {dispatch}")
    if not args.apply:
        pids = holder_pids(path)
        if pids and by_pr and only_idle_shells(pids):
            log(f"  남은 프로세스 {len(pids)} 개가 유휴 셸뿐이면 그 Orca 터미널을 닫고 다시 시도한다")
        elif pids and args.kill_holders:
            blocker = kill_blocker(mine, path, by_pr, check_terminals=False)
            log(f"  터미널을 닫은 뒤에도 프로세스 {len(pids)} 개가 남으면 "
                + (f"다음 실행으로 미룬다. 끄지 않는 이유: {blocker}" if blocker else "TERM, HUP, KILL 순으로 끈다"))
        elif pids:
            log(f"  터미널을 닫은 뒤에도 프로세스 {len(pids)} 개가 남으면 다음 실행으로 미룬다")
        log(f"  worktree 와 로컬 브랜치를 지울 것 {branch}")
        delete_remote(repo, plan, args.base, False, log)
        delete_specs(specs_dir, name, False, log)
        return

    pids = wait_free(path, args.wait)
    if pids and by_pr and only_idle_shells(pids):
        # worker 를 반납한 뒤 Orca 가 띄운 빈 셸이 폴더를 붙잡는다. 목록을 다시 읽어 그 터미널을 닫는다
        handles = terminals_at(live_terminals(), path)
        if handles:
            log(f"  남은 프로세스 {len(pids)} 개가 유휴 셸뿐이다. Orca 터미널을 닫고 다시 시도한다")
            close_terminals(handles, True, log, "유휴 셸 터미널")
            pids = wait_free(path, args.wait)
    if pids and args.kill_holders:
        blocker = kill_blocker(mine, path, by_pr)
        if blocker:
            log(f"  남은 프로세스를 끄지 않는다: {blocker}")
        else:
            nested = [other for other, _ in worktrees(repo) if other.startswith(path + "/")]
            pids = stop_holders(path, nested, args.wait, log)
    if pids:
        log(f"  건너뜀: 그 경로를 쓰는 프로세스 {len(pids)} 개({describe(pids)}). 다음 실행에서 다시 시도한다")
        return
    cmd = ["zsh", str(REMOVE), path, "--delete-branch"]
    if merged_head:
        cmd += ["--merged-head", merged_head]
    code, out, err = run(cmd)
    log("  " + (out or err).replace("\n", "\n  "))
    if code != 0:
        return
    delete_remote(repo, plan, args.base, True, log)
    delete_specs(specs_dir, name, True, log)


def sweep_branches(repo, args, checked_out, log):
    code, out, _ = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    if code != 0:
        return
    for branch in out.splitlines():
        if branch in checked_out or protected(repo, branch, args.base):
            continue
        ok, merged_head, why, pr = merged(repo, branch, args.base)
        if not ok:
            continue
        lost = unpushed(repo, branch, merged_head, merged_head is None)
        if lost:
            log(f"건너뜀 브랜치 {branch}: 원격에 없는 커밋 {lost if lost > 0 else '확인 실패'}")
            continue
        plan = remote_plan(repo, branch, pr)
        if args.apply:
            code, _, err = git(repo, "branch", "-D", branch)
            log(f"브랜치 삭제 {branch} ({why})" if code == 0 else f"브랜치 삭제 실패 {branch}: {err}")
        else:
            log(f"브랜치를 지울 것 {branch} ({why})")
        delete_remote(repo, plan, args.base, args.apply, log)


def sweep_repo(repo, args, workers, terminals, log):
    base = args.base or default_base(repo)
    args = argparse.Namespace(**{**vars(args), "base": base})
    specs_dir = None
    if args.specs_dir:
        specs_dir = Path(args.specs_dir)
        specs_dir = specs_dir if specs_dir.is_absolute() else repo / specs_dir
    git(repo, "fetch", "-q", "--prune", "origin")
    items = worktrees(repo)
    log(f"cleanup-sweep {'apply' if args.apply else 'dry-run'}: {repo} (base {base})")
    for path, branch in items:
        sweep_worktree(repo, path, branch, args, workers, terminals, specs_dir, log)
    remaining = {branch for _, branch in worktrees(repo)}
    _, main_branch, _ = git(repo, "branch", "--show-current")
    sweep_branches(repo, args, remaining | {main_branch}, log)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, action="append")
    parser.add_argument("--base")
    parser.add_argument("--run")
    parser.add_argument("--specs-dir")
    parser.add_argument("--kill-holders", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--wait", type=int, default=5, help="터미널을 닫은 뒤 프로세스가 빠지기를 기다리는 초. 기본 5")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    repos = list(dict.fromkeys(Path(r).resolve() for r in args.repo))

    def log(line):
        print(line, flush=True)

    terminals = live_terminals()
    if terminals is None:
        print("cleanup-sweep: orca terminal list 를 읽지 못해 살아 있는 worker 를 판정할 수 없다", file=sys.stderr)
        return 2
    workers = []
    if args.run:
        workers = (orca_json("orchestration", "worker-list", "--run", args.run) or {}).get("workers", [])
    code = 0
    for repo in repos:
        try:
            sweep_repo(repo, args, workers, terminals, log)
        except RuntimeError as exc:
            print(f"cleanup-sweep: {exc}", file=sys.stderr)
            code = 2
    return code


if __name__ == "__main__":
    sys.exit(main())
