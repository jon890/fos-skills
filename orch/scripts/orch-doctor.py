#!/usr/bin/env python3
"""스킬을 열 때 설치본이 낡지 않았는지, 문서가 부르는 스크립트가 모두 있는지 본다.

플러그인 스킬은 체크아웃이 아니라 설치 캐시의 복사본이 실행된다. 캐시가 옛 커밋이면
문서가 부르는 스크립트(`spec-line.py` 같은 것)가 없어 그 단계를 건너뛰게 된다.
갱신 명령을 보여 주는 것까지만 하고 갱신은 하지 않는다. 다른 세션이 같은 캐시를 쓰고 있을 수 있다.

사용법:
    orch-doctor.py [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version]

    --skill-dir     볼 스킬 디렉터리. 기본은 이 스크립트의 상위 디렉터리($SKILL_DIR)
    --remote        원본 저장소. 주지 않으면 설치 경로의 마켓플레이스 clone 의 origin 을 쓴다
    --branch        원본의 기준 브랜치. 기본 main
    --skip-version  설치본 비교를 건너뛰고 스크립트 존재만 본다. 저장소 테스트가 스킬마다 이것으로 부른다

설치본 판정:
    설치 경로는 `<plugins>/cache/<마켓플레이스>/<플러그인>/<sha>/<스킬>` 이다. `<sha>` 가 설치한 커밋이다.
    원본 브랜치의 커밋을 `git ls-remote` 로 읽어 앞자리가 같으면 최신이다.
    다르면 마켓플레이스 clone 에 두 커밋이 모두 있을 때만 그 스킬 디렉터리의 diff 로 좁힌다.
    스킬 디렉터리가 바뀌지 않았으면 최신으로 본다. 다른 스킬만 바뀐 커밋에 갱신하라고 하지 않기 위해서다.
    설치 경로가 이 꼴이 아니면(`--plugin-dir` 로 체크아웃을 실은 경우) 비교하지 않는다.

스크립트 판정:
    SKILL.md 와 그 아래 .md 에서 `$SKILL_DIR/scripts/<이름>` 과 상대 링크 `](scripts/<이름>)`, `](../scripts/<이름>)` 를 읽는다.
    백틱 안의 `scripts/verify.sh` 처럼 앞에 아무것도 없는 경로는 저장소 쪽 예시일 수 있어 보지 않는다.

출력 (한 줄에 하나):
    OK-VERSION <sha>               설치본이 원본과 같거나 그 스킬이 바뀌지 않았다
    STALE <설치 sha> <원본 sha>    설치본이 낡았다. 다음 줄에 갱신 명령이 온다
    SKIP-VERSION <이유>            비교하지 않았다
    MISSING <문서>:<줄> <경로>     문서가 부르는 스크립트가 없다
    OK-SCRIPTS <개수>              문서가 부르는 스크립트가 모두 있다

종료 코드:
    0  STALE 도 MISSING 도 없다(SKIP-VERSION 은 있을 수 있다)
    1  STALE 이나 MISSING 이 있다
    2  사용법 오류, 또는 원본 커밋을 읽지 못했다
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{7,40}$")
REF = re.compile(r"(?:\$SKILL_DIR/|\]\((?P<up>(?:\.\./)*))scripts/(?P<name>[A-Za-z0-9_.-]+)")


def git(*args, cwd=None):
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return done.returncode, done.stdout.strip()


def install_layout(skill_dir):
    """(plugins 디렉터리, 마켓플레이스, 플러그인, 설치 sha). 설치 캐시가 아니면 None."""
    parts = skill_dir.parents
    if len(parts) < 5 or parts[3].name != "cache" or not SHA.match(skill_dir.parent.name):
        return None
    return parts[4], parts[2].name, parts[1].name, skill_dir.parent.name


def marketplace_clone(plugins, marketplace):
    try:
        known = json.loads((plugins / "known_marketplaces.json").read_text(encoding="utf-8"))
        loc = known[marketplace]["installLocation"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return Path(loc) if Path(loc, ".git").exists() else None


def check_version(skill_dir, remote, branch):
    """(출력 줄 목록, 종료 코드)."""
    layout = install_layout(skill_dir)
    if layout is None:
        return [f"SKIP-VERSION 설치 캐시가 아니다: {skill_dir}"], 0
    plugins, marketplace, plugin, installed = layout
    clone = marketplace_clone(plugins, marketplace)
    if remote:
        code, out = git("ls-remote", remote, f"refs/heads/{branch}")
    elif clone:
        code, out = git("-C", str(clone), "ls-remote", "origin", f"refs/heads/{branch}")
    else:
        return [f"SKIP-VERSION 마켓플레이스 clone 을 찾지 못했다: {marketplace}"], 0
    latest = out.split()[0] if code == 0 and out else ""
    if not latest:
        print(f"orch-doctor: 원본 {branch} 의 커밋을 읽지 못했다", file=sys.stderr)
        return [], 2
    if latest.startswith(installed) or installed.startswith(latest):
        return [f"OK-VERSION {installed}"], 0
    if clone:
        have = all(git("-C", str(clone), "cat-file", "-e", f"{sha}^{{commit}}")[0] == 0 for sha in (installed, latest))
        if have:
            code, _ = git("-C", str(clone), "diff", "--quiet", installed, latest, "--", skill_dir.name)
            if code == 0:
                return [f"OK-VERSION {installed}"], 0
    return [
        f"STALE {installed} {latest[:12]}",
        f"  claude plugin marketplace update {marketplace}",
        f"  claude plugin update {plugin}@{marketplace}",
    ], 1


def check_scripts(skill_dir):
    lines, seen = [], set()
    docs = sorted(p for p in skill_dir.rglob("*.md") if "tests" not in p.relative_to(skill_dir).parts)
    for doc in docs:
        for no, text in enumerate(doc.read_text(encoding="utf-8").splitlines(), 1):
            for m in REF.finditer(text):
                if m.group("up") is None:
                    target = skill_dir / "scripts" / m.group("name")
                else:
                    target = (doc.parent / m.group("up") / "scripts" / m.group("name")).resolve()
                seen.add(target)
                if not target.exists():
                    lines.append(f"MISSING {doc.relative_to(skill_dir)}:{no} scripts/{m.group('name')}")
    if not lines:
        lines.append(f"OK-SCRIPTS {len(seen)}")
    return lines, 1 if any(line.startswith("MISSING") for line in lines) else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skill-dir", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--remote")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--skip-version", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    skill_dir = Path(args.skill_dir).resolve()
    if not (skill_dir / "SKILL.md").is_file():
        print(f"orch-doctor: SKILL.md 가 없다: {skill_dir}", file=sys.stderr)
        return 2
    out, code = [], 0
    if not args.skip_version:
        out, code = check_version(skill_dir, args.remote, args.branch)
    script_lines, script_code = check_scripts(skill_dir)
    print("\n".join(out + script_lines))
    if code == 2:
        return 2
    return max(code, script_code)


if __name__ == "__main__":
    sys.exit(main())
