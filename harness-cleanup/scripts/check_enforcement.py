#!/usr/bin/env python3
"""지침이 금지하는 대상을 다른 수단이 실제로 막는지 판정한다.

사용법:
    check_enforcement.py <repo> gitignore <경로>
    check_enforcement.py <repo> lint <probe 파일 경로> '<probe 내용>' '<검사 명령>'
    check_enforcement.py <repo> grep <probe 파일 경로> '<probe 내용>' '<검사 명령>'
    check_enforcement.py <repo> tools <agent 정의 파일>

종료 코드:
    0  그 수단이 막는다. 같은 내용의 문장 지침은 지울 수 있다
    1  막지 못한다. 문장 지침을 남긴다
    2  사용법 오류

「이미 lint 가 잡으니 문장 지침은 지워도 된다」 는 판단은 자주 틀린다.
막는다고 믿은 수단에 구멍이 있으면, 유일한 지침을 지운 셈이 된다.

`lint` 와 `grep` 은 절차가 같고 종료 코드를 읽는 방향만 반대다. 관례가 정반대이기 때문이다.
린터는 위반이 있으면 non-zero 로 끝나고, 문서의 검증 grep 은 위반을 찾으면 히트라서 0 으로 끝난다.
방향을 잘못 고르면 「이미 막힌다」 를 「안 막힌다」 로 뒤집어 읽는다.
"""

import re
import subprocess
import sys
from pathlib import Path

# 파일을 고칠 수 있는 우회 경로. Write 와 Edit 만 막아도 이들 중 하나가 남으면 못 막는다.
BYPASS_TOOLS = ("Bash", "Agent", "Task", "NotebookEdit")

ALLOW_KEY = re.compile(r"^(tools|allowed-tools):(.*)$", re.I)
DENY_KEY = re.compile(r"^disallowedTools:(.*)$", re.I)
ANY_KEY = re.compile(r"^(tools|disallowedTools|allowed-tools):", re.I)


def usage(code=2):
    print(__doc__, file=sys.stderr)
    return code


def mode_gitignore(repo, target):
    print(f"대상: {target}")
    done = subprocess.run(["git", "check-ignore", "-v", target],
                          cwd=repo, capture_output=True, text=True)
    if done.returncode == 0:
        print(f"막힌다 — {(done.stdout + done.stderr).strip()}")
        print("판정: gitignore 가 강제한다. 같은 내용의 문장 지침은 지울 수 있다.")
        return 0
    print("막히지 않는다 (git check-ignore 히트 없음)")
    print("판정: gitignore 가 강제하지 않는다. 문장 지침을 남기거나 gitignore 를 고친다.")
    return 1


def mode_probe(repo, mode, probe, body, cmd):
    """probe 를 심고 검사 명령을 돌려, 그 검사가 probe 를 잡는지 본다."""
    path = repo / probe
    if path.exists():
        print(f"이미 있는 파일이다 — 다른 경로를 쓰라: {probe}", file=sys.stderr)
        return 2

    signal = "exit 0 히트" if mode == "grep" else "non-zero"
    print(f"모드: {mode} (검출 신호 = {signal})")
    print(f"probe: {probe}")
    print(f"명령: {cmd}")
    print("---")

    # probe 는 검사가 실제로 훑는 위치에 놓아야 한다. 설정의 include 범위 밖이면 통과가 당연하다.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body + "\n", encoding="utf-8")
    try:
        done = subprocess.run(cmd, cwd=repo, shell=True, capture_output=True, text=True)
    finally:
        path.unlink(missing_ok=True)

    out = (done.stdout or "") + (done.stderr or "")
    tail = out.splitlines()[-30:]
    if tail:
        print("\n".join(tail))
    print("---")
    print(f"exit code: {done.returncode}")

    detected = (done.returncode == 0) if mode == "grep" else (done.returncode != 0)
    if detected:
        print("판정: 검사가 probe 를 잡는다. 같은 내용의 문장 지침은 지울 수 있다.")
        return 0
    print("판정: 검사가 통과시킨다. 규칙이 없거나 probe 위치가 검사 범위 밖이다.")
    print("      모드를 반대로 고르지 않았는지 먼저 확인하고, 규칙 설정을 본다.")
    print("      규칙이 없으면 문장 지침을 남긴다.")
    return 1


def frontmatter(text):
    """첫 `---` 쌍 사이의 줄."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return []
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            return lines[1:i]
    return []


def mode_tools(repo, agent):
    path = repo / agent
    if not path.is_file():
        print(f"파일이 없다: {agent}", file=sys.stderr)
        return 2
    print(f"대상: {agent}")

    fm = frontmatter(path.read_text(encoding="utf-8", errors="replace"))
    declared = [line for line in fm if ANY_KEY.match(line)]
    if declared:
        print("\n".join(declared))
    else:
        print("  (도구 제한 선언 없음 — 전체 도구 사용 가능)")
    print("---")

    # 허용 목록과 금지 목록을 모두 본다. 허용 목록만 보고 판정하면 반대 결론이 난다.
    allow = "".join(m.group(2) for m in (ALLOW_KEY.match(x) for x in fm) if m)
    deny = "".join(m.group(1) for m in (DENY_KEY.match(x) for x in fm) if m)

    bypass = []
    for tool in BYPASS_TOOLS:
        if allow and "*" not in allow and not re.search(rf"\b{tool}\b", allow):
            continue  # 허용 목록 밖이면 애초에 못 쓴다
        if re.search(rf"\b{tool}\b", deny):
            continue
        bypass.append(tool)
        print(f"  우회 가능: {tool}")

    print("---")
    if not bypass:
        print("판정: 파일을 고칠 도구가 남아 있지 않다. 도구 제한이 강제한다.")
        return 0
    print("판정: 위 도구로 우회할 수 있어 도구 제한이 파일 수정을 막지 못한다.")
    print("      (예: Bash 의 리다이렉트로 Write 없이 파일을 덮어쓸 수 있다)")
    print("      문장 지침을 지우지 않는다.")
    return 1


def main(argv):
    if len(argv) < 3:
        return usage()
    repo, mode, rest = Path(argv[1]), argv[2], argv[3:]
    if not repo.is_dir():
        print(f"대상 저장소가 없다: {repo}", file=sys.stderr)
        return 2

    if mode == "gitignore":
        return mode_gitignore(repo, rest[0]) if rest else usage()
    if mode in ("lint", "grep"):
        return mode_probe(repo, mode, *rest[:3]) if len(rest) >= 3 else usage()
    if mode == "tools":
        return mode_tools(repo, rest[0]) if rest else usage()

    print(f"알 수 없는 모드: {mode}", file=sys.stderr)
    return usage()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
