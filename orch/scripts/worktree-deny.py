#!/usr/bin/env python3
"""워크트리의 `.claude/settings.local.json` 에 다른 worker 의 자원을 빼앗는 명령과 PR 머지의 deny 규칙을 더한다.

한 머신에서 worker 여럿이 같은 이름의 프로세스와 같은 브라우저를 쓴다.
하위 에이전트가 `pkill -f 'node server/local-host.cjs'` 로 자기 호스트를 끄다 다른 worker 의 호스트까지 껐고,
`browser-driver reset` 이 다른 worker 의 탭을 닫았다(실측 5건). 지시서 문장으로는 하위 에이전트까지 닿지 않아
권한 규칙으로 막는다. 자기가 띄운 프로세스는 PID 로 `kill` 한다.
`gh pr merge` 도 막는다. 머지는 코디네이터가 하는데, 지시서에 「머지하지 않는다」 를 적어도 worker 가 PR 다섯 개를
직접 머지했다(실측). 코디네이터는 기본 체크아웃에서 `merge_queue.py` 로 머지하므로 이 규칙에 닿지 않는다.

사용법:
    worktree-deny.py <워크트리>

    기존 설정의 다른 키와 규칙은 그대로 두고, 없는 deny 규칙만 더한다. 몇 번을 돌려도 같다.
    그 파일을 git 이 추적하면 쓰지 않고 종료 코드 1 을 낸다. 고치면 워크트리가 dirty 해져 정리가 거부된다.

종료 코드: 0 썼거나 이미 있다, 1 추적되는 파일이라 쓰지 않았다, 2 사용법 오류나 JSON 을 읽지 못했다
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

DENY = ("Bash(pkill:*)", "Bash(killall:*)", "Bash(browser-driver reset:*)", "Bash(gh pr merge:*)")
REL = ".claude/settings.local.json"


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__.split("사용법:")[1].split("종료 코드")[0].strip(), file=sys.stderr)
        return 2
    wt = Path(argv[0])
    tracked = subprocess.run(["git", "-C", str(wt), "ls-files", "--error-unmatch", REL], capture_output=True)
    if tracked.returncode == 0:
        print(f"worktree-deny: {REL} 를 git 이 추적해 쓰지 않는다. deny 규칙은 저장소 설정에 둔다", file=sys.stderr)
        return 1
    path = wt / REL
    try:
        settings = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except ValueError as exc:
        print(f"worktree-deny: {path} 를 JSON 으로 읽지 못했다: {exc}", file=sys.stderr)
        return 2
    deny = settings.setdefault("permissions", {}).setdefault("deny", [])
    added = [rule for rule in DENY if rule not in deny]
    if added:
        deny.extend(added)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # 새로 만든 설정 파일이 untracked 로 남으면 remove-worktree.sh 가 커밋 안 된 변경으로 거부한다
    ignored = subprocess.run(["git", "-C", str(wt), "check-ignore", "-q", REL])
    if ignored.returncode != 0:
        common = subprocess.run(["git", "-C", str(wt), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                capture_output=True, text=True).stdout.strip()
        exclude = Path(common) / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a") as f:
            f.write(f"/{REL}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
