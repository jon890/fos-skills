#!/usr/bin/env python3
"""PR 을 머지하기 전에 base 최신화가 필요한지 「단위」 겹침으로 판정한다.

머지 큐(`merge-queue.sh --up-to-date-when overlap`)가 PR 차례마다 부른다. 판정은 큐를 걸 때가 아니라
그 PR 차례에 한다. 앞 PR 이 머지되면 base 가 바뀌기 때문이다.

사용법:
    overlap_units.py --base REF --head REF [--shared-paths 정규식] [--unit-prefix 접두] [--unit-group a,b ...]
                     [--docs-glob G1,G2] [--repo DIR]

    PR 이 바꾼 파일(merge-base..HEAD)과 PR 이 갈라진 뒤 base 에서 바뀐 파일(merge-base..BASE)을 단위로 바꿔 비교한다.
    - 단위: 접두(기본 `modules/`) 아래의 첫 폴더 하나(`modules/api/x.py` 는 `api`). 그 밖의 파일은 경로 자체가 단위다
    - 단위 묶음: `--unit-group a,b`(여러 번)로 준 단위들은 한 단위로 센다. 계약 파일 없이 서로의 응답 모양에 기대는
      모듈 쌍(화면 모듈과 그 BFF)은 폴더가 달라도 묶음 안 어느 쪽이 바뀌든 같은 단위가 바뀐 것이다
    - 공용 경로: 정규식에 맞는 파일은 어느 쪽에 있든 겹친 것으로 본다(모든 모듈에 영향을 주는 경로)
    - 문서 파일: --docs-glob 에 맞는 파일은 세지 않는다. glob 은 merge-queue.sh 와 같이 `*` 가 `/` 도 넘는다
    - 이름을 바꾼 파일은 옛 경로와 새 경로를 모두 센다
    다음은 겹침을 따지지 않고 바로 머지로 본다: base 가 갈라진 뒤 문서 밖 변경이 없다(이미 최신이거나 문서만 들어왔다),
    PR 이 문서만 바꿨다.

출력(표준 출력 한 줄): `바로 머지` 또는 `갱신 필요(이유)`. 오류는 표준 오류에 `오류: ...` 를 쓴다.
종료 코드: 0 바로 머지, 1 갱신 필요, 2 판정하지 못함(사용법 오류, git 실패). 호출하는 쪽은 2 를 갱신 필요로 다룬다
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from typing import NamedTuple

SHOWN = 3  # 이유에 이름을 적는 개수. 넘으면 「외 N」 으로 줄인다


class Verdict(NamedTuple):
    update: bool
    reason: str = ""

    def __str__(self):
        return f"갱신 필요({self.reason})" if self.update else "바로 머지"


def normalize_prefix(prefix):
    """접두는 폴더 경계로 끝나야 `modules` 가 `modules-old/` 와 맞지 않는다."""
    return prefix if not prefix or prefix.endswith("/") else prefix + "/"


def unit_of(path, unit_prefix):
    """파일이 속한 단위. 접두 아래 폴더가 있으면 그 폴더 이름이고, 아니면 경로 자체다."""
    prefix = normalize_prefix(unit_prefix)
    if prefix and path.startswith(prefix):
        folder, slash, _ = path[len(prefix):].partition("/")
        if folder and slash:
            return folder
    return path


def group_map(groups):
    """묶음 목록([["a", "b"], ...])을 단위 이름에서 묶음 이름으로 가는 사전으로 바꾼다. 묶음 이름은 멤버를 `+` 로 이은 것이다.

    한 단위가 두 묶음에 들면 모호하므로 ValueError 다.
    """
    mapping = {}
    for members in groups:
        members = [m for m in members if m]
        label = "+".join(members)
        for member in members:
            if mapping.get(member, label) != label:
                raise ValueError(f"단위 {member} 가 묶음 둘에 들어 있다: {mapping[member]}, {label}")
            mapping[member] = label
    return mapping


def is_doc(path, docs_globs):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in docs_globs)


def split_globs(text):
    return [g for g in (text or "").split(",") if g]


def _names(items):
    items = sorted(items)
    shown = ", ".join(items[:SHOWN])
    return f"{shown} 외 {len(items) - SHOWN}" if len(items) > SHOWN else shown


def judge(pr_files, base_files, shared_paths="", unit_prefix="modules/", docs_globs=(), groups=()):
    """PR 쪽 파일 목록과 base 쪽 파일 목록으로 최신화가 필요한지 정한다."""
    pr_files = [f for f in pr_files if f and not is_doc(f, docs_globs)]
    base_files = [f for f in base_files if f and not is_doc(f, docs_globs)]
    if not base_files:
        return Verdict(False)
    if not pr_files:
        return Verdict(False)
    shared = re.compile(shared_paths) if shared_paths else None
    if shared:
        hits = sorted({f for f in pr_files + base_files if shared.search(f)})
        if hits:
            return Verdict(True, f"공용 경로: {_names(hits)}")
    mapping = group_map(groups)

    def units(files):
        found = {unit_of(f, unit_prefix) for f in files}
        return {mapping.get(u, u) for u in found}

    overlap = units(pr_files) & units(base_files)
    if overlap:
        return Verdict(True, f"단위 겹침: {_names(overlap)}")
    return Verdict(False)


def git_lines(repo, *args):
    done = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {done.stderr.strip() or '종료 코드 ' + str(done.returncode)}")
    return done.stdout.splitlines()


def changed_files(repo, base, head):
    """merge-base 이후 양쪽에서 바뀐 파일. 이름 바꾸기는 옛 경로와 새 경로를 따로 센다."""
    mb = git_lines(repo, "merge-base", base, head)[0]
    return (git_lines(repo, "diff", "--name-only", "--no-renames", mb, head),
            git_lines(repo, "diff", "--name-only", "--no-renames", mb, base))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--shared-paths", default="")
    parser.add_argument("--unit-prefix", default="modules/")
    parser.add_argument("--unit-group", action="append", default=[])
    parser.add_argument("--docs-glob", default="")
    parser.add_argument("--repo", default=".")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    try:
        re.compile(args.shared_paths)
        groups = [split_globs(g) for g in args.unit_group]
        group_map(groups)
        pr_files, base_files = changed_files(args.repo, args.base, args.head)
    except (re.error, RuntimeError, IndexError, ValueError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 2
    verdict = judge(pr_files, base_files, args.shared_paths, args.unit_prefix, split_globs(args.docs_glob), groups)
    print(verdict)
    return 1 if verdict.update else 0


if __name__ == "__main__":
    sys.exit(main())
