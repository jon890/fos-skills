#!/usr/bin/env python3
"""스킬을 열 때 설치본이 낡지 않았는지, 문서가 부르는 스크립트가 모두 있는지 본다.

플러그인 스킬은 체크아웃이 아니라 설치 캐시의 복사본이 실행된다. 캐시가 옛 커밋이면
문서가 부르는 스크립트(`spec-line.py` 같은 것)가 없어 그 단계를 건너뛰게 된다.
갱신 명령을 보여 주는 것까지만 하고 갱신은 하지 않는다. 다른 세션이 같은 캐시를 쓰고 있을 수 있다.

사용법:
    orch-doctor.py [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version] [--run ID] [--skip-questions]

    --skill-dir     볼 스킬 디렉터리. 기본은 이 스크립트의 상위 디렉터리($SKILL_DIR)
    --remote        원본 저장소. 주지 않으면 설치 경로의 마켓플레이스 clone 의 origin 을 쓴다
    --branch        원본의 기준 브랜치. 기본 main
    --skip-version  설치본 비교를 건너뛰고 스크립트 존재만 본다. 저장소 테스트가 스킬마다 이것으로 부른다

설치본 판정:
    설치 경로는 `<plugins>/cache/<마켓플레이스>/<플러그인>/<sha>/<스킬>` 이다. `<sha>` 가 설치한 커밋이다.
    원본 브랜치의 커밋을 `git ls-remote` 로 읽어 앞자리가 같으면 최신이다.
    다르면 설치본 스킬 디렉터리의 tree hash 를 마켓플레이스 clone 의 `<원본 커밋>:<스킬>` 과 비교한다.
    같으면 최신으로 본다. 다른 스킬만 바뀐 커밋에 갱신하라고 하지 않기 위해서다.
    마켓플레이스 clone 은 커밋 하나뿐인 shallow clone 이라 커밋끼리 diff 하지 못한다. 그래서 tree 를 비교한다.
    clone 에 원본 커밋이 없거나(마켓플레이스를 아직 갱신하지 않았다) 그 경로가 없으면 판정할 수 없어 낡은 것으로 본다.
    설치 경로가 이 꼴이 아니면(`--plugin-dir` 로 체크아웃을 실은 경우) 비교하지 않는다.
    원본을 읽지 못하면(오프라인) 비교하지 않고 SKIP-VERSION 을 낸다. 스킬을 여는 일을 막지 않는다.

스크립트 판정:
    SKILL.md 와 그 아래 .md 에서 `$SKILL_DIR/scripts/<이름>` 과 상대 링크 `](scripts/<이름>)`, `](../scripts/<이름>)` 를 읽는다.
    형제 번들 변수 `$PLANNING_SKILL_DIR/scripts/<이름>` 은 같은 플러그인의 `planning/scripts/<이름>` 으로 본다
    (변수 이름의 `_SKILL_DIR` 앞을 소문자로 바꾸고 `_` 를 `-` 로 바꾼 디렉터리).
    백틱 안의 `scripts/verify.sh` 처럼 앞에 아무것도 없는 경로는 저장소 쪽 예시일 수 있어 보지 않는다.

출력 (한 줄에 하나):
    OK-VERSION <sha>               설치본이 원본과 같거나 그 스킬이 바뀌지 않았다
    STALE <설치 sha> <원본 sha>    설치본이 낡았다. 다음 줄에 갱신 명령이 온다
    SKIP-VERSION <이유>            비교하지 않았다
    MISSING <문서>:<줄> <경로>     문서가 부르는 스크립트가 없다
    OK-SCRIPTS <개수>              문서가 부르는 스크립트가 모두 있다
    UNANSWERED <id> <설명>        10분 이상 답이 없는 질문이 있다
    SKIP-QUESTIONS <이유>         질문 상태를 조회하지 못했다

종료 코드:
    0  STALE, MISSING, UNANSWERED 가 없다(SKIP 출력은 있을 수 있다)
    1  STALE, MISSING 이나 UNANSWERED 가 있다
    2  사용법 오류
"""

from __future__ import annotations

import argparse
import json
import re
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import questions

SHA = re.compile(r"^[0-9a-f]{7,40}$")
REF = re.compile(r"(?:\$(?:(?P<sibling>[A-Z][A-Z0-9_]*)_)?SKILL_DIR/|\]\((?P<up>(?:\.\./)*))scripts/(?P<name>[A-Za-z0-9_.-]+)")


def git(*args, cwd=None, env=None):
    # ls-remote 가 ssh 나 인증을 표준 입력으로 물으면 스킬을 열 때 멈춘다. 입력을 막고 시간을 제한한다
    env = dict(env or os.environ, GIT_TERMINAL_PROMPT="0", GIT_SSH_COMMAND=os.environ.get("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"))
    try:
        done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, env=env,
                              stdin=subprocess.DEVNULL, timeout=20)
    except subprocess.TimeoutExpired:
        return 124, ""
    return done.returncode, done.stdout.strip()


def tree_hash(directory, excludes):
    """디렉터리 내용의 git tree hash. 임시 저장소에 쓰므로 원본과 clone 을 건드리지 않는다."""
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, GIT_DIR=os.path.join(tmp, "git"), GIT_INDEX_FILE=os.path.join(tmp, "index"),
                   GIT_WORK_TREE=str(directory))
        git("init", "-q", env=env)
        config = ["-c", f"core.excludesFile={excludes}"] if excludes and Path(excludes).is_file() else []
        code, _ = git(*config, "add", "-A", ".", env=env, cwd=str(directory))
        if code != 0:
            return None
        code, out = git("write-tree", env=env)
        return out if code == 0 else None


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
        return [f"SKIP-VERSION 원본 {branch} 의 커밋을 읽지 못했다(오프라인이면 그대로 진행한다)"], 0
    if latest.startswith(installed) or installed.startswith(latest):
        return [f"OK-VERSION {installed}"], 0
    if clone:
        code, upstream = git("-C", str(clone), "rev-parse", "--verify", "-q", f"{latest}:{skill_dir.name}")
        if code == 0 and upstream == tree_hash(skill_dir, clone / ".gitignore"):
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
                if m.group("sibling"):
                    bundle = m.group("sibling").lower().replace("_", "-")
                    target = skill_dir.parent / bundle / "scripts" / m.group("name")
                elif m.group("up") is None:
                    target = skill_dir / "scripts" / m.group("name")
                else:
                    target = (doc.parent / m.group("up") / "scripts" / m.group("name")).resolve()
                seen.add(target)
                if not target.exists():
                    shown = target.relative_to(skill_dir.parent) if m.group("sibling") else f"scripts/{m.group('name')}"
                    lines.append(f"MISSING {doc.relative_to(skill_dir)}:{no} {shown}")
    if not lines:
        lines.append(f"OK-SCRIPTS {len(seen)}")
    return lines, 1 if any(line.startswith("MISSING") for line in lines) else 0


def check_questions(run=None, now=None):
    try:
        run, pending = questions.snapshot(run)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return [f"SKIP-QUESTIONS {exc}"], 0
    now = time.time() if now is None else now
    overdue = [m for m in pending if questions.age_seconds(m, now) >= 600]
    return [f"UNANSWERED {m['id']} 10분 이상 답이 없다 (Run {run})" for m in overdue], bool(overdue)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skill-dir", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--remote")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--skip-version", action="store_true")
    parser.add_argument("--run", help="미답변 질문을 확인할 Run")
    parser.add_argument("--skip-questions", action="store_true", help="질문 상태 조회를 건너뛴다")
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
    question_lines, question_code = ([], 0) if args.skip_questions else check_questions(args.run)
    print("\n".join(out + script_lines + question_lines))
    return max(code, script_code, question_code)


if __name__ == "__main__":
    sys.exit(main())
