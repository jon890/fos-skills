#!/usr/bin/env python3
"""plan_number.sh 가 모은 git 이력, main 트리, PR 브랜치 이름에서 쓰인 plan 번호와 다음 번호를 낸다.

직접 부르지 않는다. 입력 파일은 plan_number.sh 가 만든다.

    --log FILE        git log --all --full-history --name-status --format=%x01%S -- TASKS_DIR 의 출력
    --main-tree FILE  main 의 TASKS_DIR 디렉터리 목록(git ls-tree -d --name-only)
    --heads FILE      PR head 브랜치 이름. 주지 않으면 PR 이력을 보지 못한 것이다

이름 형식은 디렉터리 이름 앞에서부터 맞춘다. 캡처 그룹이 하나이고 그 그룹이 번호다.
--name-regex 가 없으면 `{prefix}plan(\\d+)-` 이다.

종료 코드: 0 성공, 2 인자 오류 또는 tasks 이력의 이름을 하나도 해석하지 못함.
"""

import argparse
import re
import sys
from pathlib import Path

PR_WARNING = "PR 이력을 보지 못했다 (gh 미설치 또는 인증 실패). squash 머지 후 브랜치를 지운 번호는 빠졌을 수 있다."
STATUS_LINE = re.compile(r"^([A-Z])\d*\t(.+)$")


def read_lines(path):
    return Path(path).read_text(encoding="utf-8").splitlines()


def dir_of(path, tasks_dir):
    """tasks_dir 바로 아래 디렉터리 이름이다. 디렉터리 안의 파일이 아니면 None."""
    prefix = tasks_dir + "/"
    if not path.startswith(prefix):
        return None
    parts = path[len(prefix):].split("/")
    return parts[0] if len(parts) >= 2 else None


def parse_log(lines, tasks_dir):
    """디렉터리 이름마다 (지금 살아 있는지, 살아 있는 쪽의 ref 목록)을 낸다.

    log 는 최신 커밋부터 나온다. 파일마다 처음 만난 상태가 마지막 상태다.
    디렉터리는 살아 있는 파일이 하나라도 있으면 살아 있다.
    """
    source, last, sources = "", {}, {}
    for line in lines:
        if line.startswith("\x01"):
            source = line[1:].removeprefix("refs/heads/").removeprefix("refs/remotes/")
            continue
        found = STATUS_LINE.match(line)
        if not found:
            continue
        name = dir_of(found[2], tasks_dir)
        if name is None or (name, found[2]) in last:
            continue
        last[(name, found[2])] = found[1]
        if found[1] != "D":
            sources.setdefault(name, [])
            if source and source not in sources[name]:
                sources[name].append(source)
    alive = {name for (name, _), status in last.items() if status != "D"}
    return {name: (name in alive, sources.get(name, [])) for name in {n for n, _ in last}}


def main_names(lines, tasks_dir):
    return {line.removeprefix(tasks_dir + "/").strip("/") for line in lines if line.strip()}


def head_patterns(prefix):
    escaped = re.escape(prefix)
    return [re.compile(rf"^(?:.*/)?{escaped}plan(\d+)(?:-.*)?$"), re.compile(rf"^plan/{escaped}(\d+)(?:-.*)?$")]


def branch_numbers(heads, name_regex, prefix):
    """PR head 브랜치 이름에서 번호를 읽는다.

    기본 형식은 `{접두사}plan{N}-...` 와 `plan/{접두사}{N}-...` 다.
    --name-regex 가 있으면 브랜치 이름의 어느 `/` 뒤에서든 그 형식을 앞에서부터 맞춘다.
    """
    numbers = set()
    for head in heads:
        if name_regex is None:
            for pattern in head_patterns(prefix):
                found = pattern.match(head)
                if found:
                    numbers.add(int(found[1]))
            continue
        pieces = head.split("/")
        for i in range(len(pieces)):
            found = name_regex.match("/".join(pieces[i:]))
            if found and found[1].isdigit():
                numbers.add(int(found[1]))
                break
    return numbers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks-dir", required=True)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--name-regex")
    parser.add_argument("--log", required=True)
    parser.add_argument("--main-tree", required=True)
    parser.add_argument("--main-ref", required=True)
    parser.add_argument("--heads")
    parser.add_argument("--allow-empty", action="store_true")
    args = parser.parse_args()

    name_regex = None
    if args.name_regex is not None:
        if args.prefix:
            parser.error("--name-regex 와 --prefix 는 함께 쓰지 않는다. 접두사는 정규식에 넣는다")
        try:
            name_regex = re.compile(args.name_regex)
        except re.error as error:
            parser.error(f"--name-regex 가 정규식이 아니다: {error}")
        if name_regex.groups != 1:
            parser.error("--name-regex 에는 번호를 잡는 캡처 그룹이 하나여야 한다. 예: 'analysis-(\\d{3})-'")
    else:
        name_regex = re.compile(rf"{re.escape(args.prefix)}plan(\d+)-")

    def number_of(name):
        found = name_regex.match(name)
        return int(found[1]) if found and found[1].isdigit() else None

    history = parse_log(read_lines(args.log), args.tasks_dir)
    in_main = main_names(read_lines(args.main_tree), args.tasks_dir)
    names = sorted(set(history) | in_main)

    numbers = {}  # 번호 -> 그 번호로 읽힌 디렉터리 이름
    for name in names:
        number = number_of(name)
        if number is not None:
            numbers.setdefault(number, []).append(name)

    if not numbers and not args.allow_empty:
        # 접두사를 준 기본 형식은 그 접두사로 시작하는 디렉터리가 있을 때만 형식 불일치로 본다.
        # 모노레포에서 다른 하위 프로젝트의 계획만 있는 경우는 정상이다.
        relevant = [n for n in names if args.name_regex is not None or n.startswith(args.prefix)]
        if relevant:
            print(f"tasks 이력에 계획 디렉터리 {len(relevant)}개가 있는데 이름 형식으로 해석한 번호가 0개다: "
                  f"{', '.join(relevant[:5])}", file=sys.stderr)
            print("저장소의 이름 형식을 --name-regex 로 준다. 예: --name-regex 'analysis-(\\d{3})-' "
                  "(캡처 그룹이 번호). 다른 형식의 계획만 있는 정상 상태면 --allow-empty 를 준다", file=sys.stderr)
            return 2

    pr_seen = args.heads is not None
    pr_numbers = branch_numbers(read_lines(args.heads), name_regex if args.name_regex else None, args.prefix) if pr_seen else set()
    all_numbers = sorted(set(numbers) | pr_numbers)

    if not all_numbers:
        print("쓰인 번호가 없다")
        if not pr_seen:
            print(PR_WARNING)
        print("다음 번호: 1")
        return 0

    print("쓰인 번호:")
    for number in all_numbers:
        dirs = numbers.get(number, [])
        if args.name_regex is None:
            label = f"{args.prefix}plan{number}"
        else:
            label = ", ".join(dirs[:2]) or f"번호 {number}"
        if any(d in in_main for d in dirs):
            print(f"  {label:<12} {args.main_ref} 안에 있다")
            continue
        # main 은 위에서 트리로 판정했다. main 에서 지운 계획이 main 쪽 이력에서 살아 있는 것으로 읽혀도 밖에 있는 것으로 세지 않는다.
        main_labels = {args.main_ref, args.main_ref.removeprefix("origin/")}
        outside = [src for d in dirs if history.get(d, (False, []))[0] for src in history[d][1] if src not in main_labels]
        if outside:
            print(f"  {label:<12} {args.main_ref} 밖에만 있다: {' '.join(dict.fromkeys(outside))}")
        elif dirs:
            print(f"  {label:<12} 지워졌고 git 이력에만 있다")
        else:
            print(f"  {label:<12} PR 브랜치 이름에만 있다")
    if not pr_seen:
        print(PR_WARNING)
    print(f"다음 번호: {all_numbers[-1] + 1}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
