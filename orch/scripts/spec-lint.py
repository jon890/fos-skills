#!/usr/bin/env python3
"""worker 를 띄우기 전에 지시서끼리, 그리고 저장소 계약과 어긋나는 곳을 찾는다.

지시서를 띄운 뒤에야 담당 파일이 겹치거나, 가리킨 함수가 없거나, 금지 명령을 요구한다는 것을 알게 되면
worker 가 ask 로 멈추거나 먼저 머지된 쪽 때문에 뒤 PR 이 충돌한다. 띄우기 전에 한 번 돌린다.

사용법:
    spec-lint.py --repo DIR [--overlay FILE] SPEC [SPEC ...]
    spec-lint.py --repo DIR [--overlay FILE] --check-overlay [--base main] [SPEC ...]

    --repo     대상 저장소. 존재 확인과 담당 경로 확장을 이 저장소의 git 으로 한다
    --overlay  저장소 값을 읽을 파일. 없으면 <repo>/.claude/orch-overlay.md 를 읽고, 그것도 없으면 저장소 값 없이 돈다
    SPEC       검사할 지시서. 공통 지시서(spec-common.md)는 넘기지 않는다
    --check-overlay  오버레이와 <repo>/.claude/orch-finish.json 이 가리키는 경로가 origin/<base> 에 있는지도 본다.
                     이 옵션을 주면 SPEC 을 생략할 수 있다. `--overlay` 는 지금처럼 오버레이 파일 위치다
    --base     --check-overlay 가 대조할 기준 브랜치. 기본 main. fetch 하지 않고 지금 있는 origin/<base> 를 본다

지시서에서 읽는 줄:
    담당: `src/a/**`, `docs/a.md`     그 worker 가 고치는 경로. glob 을 쓴다. 여러 줄이어도 된다
    예외: ...                          그 줄은 금지 문구와 존재 확인에서 뺀다

오버레이의 `## spec-lint` 절에서 읽는 줄 (저장소 값은 여기에만 둔다):
    코디네이터 소유: `docs/adr/**`, `CHANGELOG.md`   어느 지시서도 담당으로 가질 수 없는 경로
    소유: `src/net/**` spec-net                       그 경로는 이름이 그 값인 지시서만 담당으로 가질 수 있다
    금지 문구: `rm -rf`, `pkill`                      지시서가 요구하면 안 되는 명령. 기본 목록에 더한다

검사 (발견마다 `<파일>:<줄>: <종류>: <내용>` 한 줄):
    겹침        두 지시서의 담당 경로가 같은 파일을 가리킨다. 둘 다 glob 이면 패턴끼리도 대조한다
    코디네이터  담당 경로가 코디네이터 소유 경로와 겹친다
    소유        담당 경로가 다른 지시서 소유로 정한 경로와 겹친다
    없음        백틱 안의 함수 호출 꼴(`name()`, `Class.method()`)이 저장소에 없다(`git grep -w`)
    금지        금지 문구가 든 줄인데 그 줄에 부정 표현(않, 말고, 대신, 금지, 없이)이 없다
    경로        백틱 안의 파일 경로(확장자가 있는 것)가 저장소에 없다. 파일 이름만 적었으면 어느 폴더에든 있으면 된다. 새로 만들 파일일 수 있어 경고이고 종료 코드에 넣지 않는다
    오버레이    (--check-overlay) 오버레이의 백틱 값과 orch-finish.json 의 문자열 값에서 읽은 상대 경로가 origin/<base> 에 없다.
                명령(`bash scripts/verify.sh --fast`)이면 낱말마다 본다. `/` 가 든 확장자 있는 낱말만 경로로 본다.
                파일 이름만 적은 것(스킬 스크립트일 수 있다), 절대경로, `~`, `$`, glob, `<...>` 가 든 값, git 이 무시하는 경로(`.omc/` 같은 로컬 폴더)는 보지 않는다.
                로컬에만 있는 스크립트를 오버레이가 부르면 다른 워크트리와 worker 에서 그 단계가 「파일 없음」 으로 멈춘다

종료 코드:
    0  막을 발견이 없다(경로 경고는 있을 수 있다)
    1  겹침, 코디네이터, 소유, 없음, 금지, 오버레이 중 하나 이상
    2  사용법 오류, 또는 저장소, 지시서, origin/<base> 를 읽지 못했다
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_FORBIDDEN = ("--no-verify", "push --force", "push -f ", "reset --hard", "pkill", "killall")
NEGATION = ("않", "말고", "대신", "금지", "없이")
TICK = re.compile(r"`([^`]+)`")
CALL = re.compile(r"^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\(\)$")
# 마지막 마디에 확장자가 있는 것만 경로로 본다. `mac/battle-join` 같은 브랜치 이름과 `feature/` 같은 접두를 빼려는 것이다
PATHLIKE = re.compile(r"^(?:[\w.\-]+/)*[\w\-]+(?:\.[\w\-]+)*\.[A-Za-z]{1,5}$")


def ticks(line):
    return TICK.findall(line)


def field(line, name):
    """`이름:` 으로 시작하는 줄이면 그 뒤 백틱 값들. 목록 기호와 굵게는 무시한다."""
    stripped = line.strip().removeprefix("- ").removeprefix("* ").strip()
    stripped = re.sub(r"^\*\*([^*]+?)\*\*", r"\1", stripped)
    if not stripped.startswith(name + ":"):
        return None
    return stripped[len(name) + 1:]


class Repo:
    def __init__(self, root):
        self.root = Path(root)
        done = subprocess.run(["git", "-C", str(root), "ls-files"], capture_output=True, text=True)
        if done.returncode != 0:
            raise RuntimeError(f"git 저장소가 아니다: {root}")
        self.files = done.stdout.splitlines()

    def expand(self, pattern):
        pattern = pattern.rstrip("/")
        hits = {f for f in self.files if fnmatch.fnmatch(f, pattern) or f.startswith(pattern + "/")}
        return hits or {pattern}

    def exists(self, path):
        path = path.rstrip("/")
        if "/" not in path:
            # 파일 이름만 적은 것은 어느 폴더에든 있으면 있다고 본다
            return any(f == path or f.endswith("/" + path) for f in self.files)
        return (self.root / path).exists() or any(f == path or f.startswith(path + "/") for f in self.files)

    def has_name(self, name):
        done = subprocess.run(["git", "-C", str(self.root), "grep", "-qw", name], capture_output=True)
        return done.returncode == 0


def path_words(value):
    """값에서 저장소 상대 경로로 볼 낱말. 명령이면 낱말마다 본다."""
    for word in value.split():
        word = word.strip("\"'(),;").removeprefix("./")
        if "/" not in word or word.startswith(("/", "~", "-")) or any(ch in word for ch in "$*?<>{}[]="):
            continue
        if PATHLIKE.match(word):
            yield word


def overlay_refs(repo_root, overlay):
    """(파일, 줄, 경로) 목록. 오버레이는 백틱 값, orch-finish.json 은 문자열 값에서 읽는다."""
    refs = []
    if overlay and Path(overlay).is_file():
        for no, line in enumerate(Path(overlay).read_text(encoding="utf-8").splitlines(), 1):
            for tok in ticks(line):
                refs += [(Path(overlay), no, w) for w in path_words(tok)]
    finish = Path(repo_root) / ".claude" / "orch-finish.json"
    if finish.is_file():
        text = finish.read_text(encoding="utf-8")
        lines = text.splitlines()

        def strings(node):
            if isinstance(node, str):
                yield node
            elif isinstance(node, dict):
                for v in node.values():
                    yield from strings(v)
            elif isinstance(node, list):
                for v in node:
                    yield from strings(v)

        for value in strings(json.loads(text)):
            for word in path_words(value):
                no = next((i for i, line in enumerate(lines, 1) if word in line), 0)
                refs.append((finish, no, word))
    return refs


def check_overlay(repo_root, overlay, base):
    """origin/<base> 에 없는 오버레이 경로마다 한 줄."""
    ref = f"origin/{base}"
    done = subprocess.run(["git", "-C", str(repo_root), "ls-tree", "-r", "--name-only", ref],
                          capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"{ref} 를 읽지 못했다")
    files = set(done.stdout.splitlines())
    errors = []
    for path, no, word in overlay_refs(repo_root, overlay):
        if word in files or any(f.startswith(word.rstrip("/") + "/") for f in files):
            continue
        ignored = subprocess.run(["git", "-C", str(repo_root), "check-ignore", "-q", "--no-index", word])
        if ignored.returncode == 0:
            continue
        errors.append(f"{path.name}:{no}: 오버레이: `{word}` 가 {ref} 에 없다")
    return errors


def overlap(repo, a, b):
    if fnmatch.fnmatch(a, b) or fnmatch.fnmatch(b, a):
        return True
    return bool(repo.expand(a) & repo.expand(b))


def read_overlay(path):
    coordinator, owners, forbidden = [], [], list(DEFAULT_FORBIDDEN)
    if not path or not Path(path).is_file():
        return coordinator, owners, forbidden
    section = False
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip() == "spec-lint"
            continue
        if not section:
            continue
        if (rest := field(line, "코디네이터 소유")) is not None:
            coordinator += ticks(rest)
        elif (rest := field(line, "소유")) is not None:
            globs = ticks(rest)
            owner = TICK.sub("", rest).strip()
            owners += [(g, owner) for g in globs if owner]
        elif (rest := field(line, "금지 문구")) is not None:
            forbidden += ticks(rest)
    return coordinator, owners, forbidden


def read_spec(path):
    """(담당 [(glob, 줄 번호)], 줄 목록)."""
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    owned = []
    for no, line in enumerate(lines, 1):
        rest = field(line, "담당")
        if rest is not None:
            owned += [(g, no) for g in ticks(rest)]
    return owned, lines


def lint(repo, specs, overlay):
    coordinator, owners, forbidden = read_overlay(overlay)
    errors, warnings = [], []
    parsed = {Path(s): read_spec(s) for s in specs}

    names = list(parsed)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            for ga, na in parsed[a][0]:
                for gb, _ in parsed[b][0]:
                    if overlap(repo, ga, gb):
                        errors.append(f"{a.name}:{na}: 겹침: `{ga}` 와 {b.name} 의 `{gb}`")

    for spec, (owned, lines) in parsed.items():
        name = spec.stem
        for glob, no in owned:
            for c in coordinator:
                if overlap(repo, glob, c):
                    errors.append(f"{spec.name}:{no}: 코디네이터: `{glob}` 가 코디네이터 소유 `{c}` 와 겹친다")
            for g, owner in owners:
                if owner not in (name, name.removeprefix("spec-")) and overlap(repo, glob, g):
                    errors.append(f"{spec.name}:{no}: 소유: `{glob}` 는 {owner} 소유 `{g}` 와 겹친다")
        for no, line in enumerate(lines, 1):
            if field(line, "예외") is not None or field(line, "담당") is not None:
                continue
            for phrase in forbidden:
                if phrase in line and not any(n in line for n in NEGATION):
                    errors.append(f"{spec.name}:{no}: 금지: `{phrase.strip()}` 를 요구한다")
            for tok in ticks(line):
                tok = tok.strip()
                call = CALL.match(tok)
                if call and not repo.has_name(call.group(1)):
                    errors.append(f"{spec.name}:{no}: 없음: `{tok}` 를 저장소에서 찾지 못했다")
                elif not call and PATHLIKE.match(tok) and not any(ch in tok for ch in "*<{") \
                        and not repo.exists(tok):
                    warnings.append(f"{spec.name}:{no}: 경로: `{tok}` 가 저장소에 없다(새 파일이면 무시)")
    return errors, warnings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--overlay")
    parser.add_argument("--check-overlay", action="store_true")
    parser.add_argument("--base", default="main")
    parser.add_argument("specs", nargs="*")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if not args.specs and not args.check_overlay:
        print("spec-lint: 지시서를 하나 이상 주거나 --check-overlay 를 준다", file=sys.stderr)
        return 2
    missing = [s for s in args.specs if not Path(s).is_file()]
    if missing:
        print(f"spec-lint: 지시서를 읽지 못했다: {', '.join(missing)}", file=sys.stderr)
        return 2
    try:
        repo = Repo(args.repo)
    except RuntimeError as exc:
        print(f"spec-lint: {exc}", file=sys.stderr)
        return 2
    overlay = args.overlay or Path(args.repo) / ".claude" / "orch-overlay.md"
    errors, warnings = lint(repo, args.specs, overlay) if args.specs else ([], [])
    if args.check_overlay:
        try:
            errors += check_overlay(args.repo, overlay, args.base)
        except (RuntimeError, ValueError) as exc:
            print(f"spec-lint: {exc}", file=sys.stderr)
            return 2
    for line in errors + warnings:
        print(line)
    print(f"spec-lint: 막을 발견 {len(errors)}건, 경로 경고 {len(warnings)}건", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
