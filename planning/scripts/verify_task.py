#!/usr/bin/env python3
"""task 생성 직후 자동 검증.

index 스키마, 변경 파일 상태, 같은 phase 의 테스트 실행 지시와
스킬 번들 cwd, 사람 의존 검증, 필수 절, BSD sed 를 검사한다.
`bun test` 의 점 디렉터리 경로와 금지 문자열 검사가 같은 phase 의 테스트에 걸리는지도 본다.
완료 표시는 요구하지 않는다. 구현이 끝난 계획서는 build-with-teams 가 디렉터리째 지운다.
계획에 적힌 명령은 실행하지 않는다.

사용법:
    python3 scripts/verify_task.py PLAN
    python3 scripts/verify_task.py PLAN --audit
    python3 scripts/verify_task.py fe-plan27-login --tasks-dir tasks
    python3 scripts/verify_task.py --staged tasks/PLAN/phase-01.md

기본 검사는 구현 전 파일 상태를 대조한다. --audit 는 구현 후 문서 검사라
신규/수정/삭제 파일의 현재 존재 조건을 대조하지 않는다.
--staged 는 git index 와 phase 변경 파일 목록을 대조한다.
테스트 범위, 실패 전파, 식별자와 스키마의 일치는 사람이 확인한다.

cwd 는 타깃 레포 root 여야 한다. 계획서 디렉터리는 --tasks-dir 로 바꾼다 (기본값 tasks).
모노레포의 근거 문서는 `frontend/docs/flow.md` 처럼 하위 프로젝트의 docs 경로도 받는다.
경로는 이 스킬 번들 기준 상대경로다. 하네스가 알려주는 base 디렉터리에 붙여 쓴다.

종료 코드
    0  위반 없음 (경고는 별도 출력)
    1  위반 발견 (내용은 stdout 으로 출력)
    2  검사를 돌리지 못함 (인자 오류, 디렉터리 없음, JSON 파싱 실패)
"""

import argparse
import fnmatch
import json
import posixpath
import re
import shlex
import subprocess
import sys
from pathlib import Path

# task 생성 시 phase 파일에 필요한 필수 절을 검사한다.
REQUIRED_SECTIONS = [
    "## 목표",
    "**범위 외**",
    "## 작업 항목",
    "## 검증",
]

# 스키마에 없는 키. 실행 순서는 사용자 보고로 전달하고 task 파일에 넣지 않는다.
FORBIDDEN_KEYS = ("depends_on", "related_docs", "prerequisites")

PROFILES = {"fast", "standard", "deep"}
MODELS = {"haiku", "sonnet", "opus"}

VAGUE_SCOPE = re.compile(r"전체\s*(수정|변경|적용|교체|리팩토링|삭제)")
HUMAN_CHECK = re.compile(r"수동\s*(?:검토|확인|검증)|눈으로\s*확인|직접\s*확인|육안")
BSD_SED = re.compile(r"sed\s.*\\b")
# 모노레포는 하위 프로젝트마다 docs 를 둔다. 루트 기준 경로의 어느 조각이든 `docs` 면 근거 문서로 본다.
DOC_PATH = re.compile(r"`((?:[A-Za-z0-9_.-]+/)*docs/[^`\s]+)`")
TEST_DIRS = {"test", "tests", "__tests__"}
TEST_NAME = re.compile(r"^test_|(?:Test|Tests)\.[^.]+$|[._-](?:test|spec)\.[^.]+$")
# 테스트 디렉터리 안에서만 테스트로 보는 이름이다. `UserSpec.java`, `AppIT.java` 같은 JVM 규칙이다.
RUNNABLE_NAME = re.compile(r"(?:Spec|IT)\.[^.]+$")
BUNDLE = re.compile(r"\$(?:SKILL_DIR|\{SKILL_DIR\})|~/\.(?:claude|codex)/skills|\$HOME/\.(?:claude|codex)/skills")
CODE_SUFFIXES = {".java", ".kt", ".groovy", ".scala", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".cs", ".rb", ".php", ".swift", ".sh", ".bash", ".c", ".cpp"}
SHELL = {"", "bash", "sh", "shell", "zsh"}
# 「다음 케이스」 처럼 phase 와 무관한 「다음」 은 미루기가 아니다. 다른 phase 나 plan 을 가리키는 구절만 본다.
DEFER_TEST = re.compile(
    r"(?=.*(?:테스트|회귀\s*검증))"
    r"(?=.*(?:(?:다음|후속|이후)\s*(?:phase|단계|plan)|나중에?))"
    r"(?=.*(?:작성|추가|미루|미룬|넘기|넘긴|진행|수행|다루|다룬|구현|보강|처리))",
    re.I,
)
NOT_DEFERRED = re.compile(r"(?:미루|넘기)지\s*(?:않|말)")
HUMAN_ONLY = re.compile(r"(?:사람이|담당자가|사용자가)\s*(?:확인|검토|판정)|화면(?:에서|을)\s*(?:확인|검토)")


def is_test(rel):
    """테스트 디렉터리 아래 파일, 또는 테스트 이름을 가진 코드 파일이다.

    `UserSpec.java` 같은 운영 코드와 `docs/specs/` 문서는 테스트가 아니다.
    """
    parts = rel.removeprefix("./").split("/")
    if TEST_DIRS.intersection(parts[:-1]) or parts[-1] in TEST_DIRS:
        return True
    name = parts[-1]
    if not (Path(name).suffix in CODE_SUFFIXES or is_glob(name)):
        return False
    return bool({"spec", "specs"}.intersection(parts[:-1]) or TEST_NAME.search(name))


def runnable_test(rel):
    """테스트 실행기가 직접 실행하는 테스트다. 테스트 디렉터리의 fixture, fake, helper, conftest 는 뺀다.

    이름으로 판정하지 못하는 glob 과 테스트 디렉터리 자체는 실행 대상으로 둔다.
    """
    if not is_test(rel):
        return False
    name = rel.removeprefix("./").split("/")[-1]
    if name in TEST_DIRS or is_glob(name):
        return True
    return Path(name).suffix in CODE_SUFFIXES and bool(TEST_NAME.search(name) or RUNNABLE_NAME.search(name))


def fences(text):
    """(줄 번호, 줄, 종류, 언어)를 낸다. 종류는 open, code, close, text 다.

    닫는 fence 는 여는 fence 와 같은 문자로 같은 길이 이상이어야 한다.
    """
    fence, language = None, ""
    for n, line in enumerate(text.splitlines(), 1):
        if fence is None:
            marker = re.match(r"^\s*(`{3,}|~{3,})\s*([\w+-]*)", line)
            if marker:
                fence, language = marker.group(1), marker.group(2).lower()
                yield n, line, "open", language
            else:
                yield n, line, "text", ""
            continue
        marker = re.fullmatch(r"\s*(`{3,}|~{3,})\s*", line)
        if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
            fence = None
            yield n, line, "close", language
        else:
            yield n, line, "code", language


def section(text, name):
    """코드 블록 속 제목은 절 구분자로 쓰지 않는다."""
    lines, active = [], False
    for _, line, kind, _ in fences(text):
        if kind == "text" and line.startswith("## "):
            if active:
                break
            active = line.strip() == f"## {name}"
            continue
        if active:
            lines.append(line)
    return "\n".join(lines)


def code_blocks(text):
    lines, start = [], 0
    for n, line, kind, language in fences(text):
        if kind == "open":
            lines, start = [], n
        elif kind == "code":
            lines.append(line)
        elif kind == "close":
            yield start, language, "\n".join(lines)


def manifest(path, text, out, warnings):
    body = section(text, "변경 파일")
    if not body and section(text, "Critical Files"):
        body = section(text, "Critical Files")
        warnings.append(f"{path} — Critical Files 는 읽기 호환이다. 새 계획은 변경 파일 절을 쓴다")
    if not body:
        out.append(f"{path} — 변경 파일 절이 없다")
        return []
    entries = []
    for line in body.splitlines():
        if not line.lstrip().startswith("|") or "`" not in line:
            continue
        cells = line.strip().strip("|").split("|")
        if len(cells) != 2:
            out.append(f"{path} — 변경 파일 행은 파일과 변경 두 칸이어야 한다: {line}")
            continue
        files = re.findall(r"`([^`]+)`", cells[0])
        action = re.match(r"\s*(신규|수정|삭제)(?:\s|$|\()", cells[1])
        if len(files) != 1 or not action:
            out.append(f"{path} — 변경 파일 행의 경로 또는 변경 종류가 잘못됐다: {line}")
            continue
        rel = files[0].removeprefix("./")
        if Path(rel).is_absolute() or ".." in Path(rel).parts or "$" in rel or rel.startswith("~"):
            out.append(f"{path} — 저장소 상대경로가 필요하다: {rel}")
            continue
        if any(existing == rel for existing, _ in entries):
            out.append(f"{path} — 변경 파일 중복: {rel}")
        entries.append((rel, action.group(1)))
    if not entries:
        out.append(f"{path} — 변경 파일 목록이 비었다")
    return entries


# Next.js 동적 라우트 조각이다. `[id]`, `[...path]`, `[[...slug]]` 처럼 조각 전체가 대괄호다.
# 조각 전체를 문자 클래스로 쓰는 glob 은 한 글자 디렉터리만 맞아 계획서에 쓸 일이 없다.
DYNAMIC_SEGMENT = re.compile(r"\[\[?(?:\.\.\.)?[^\[\]/*?]+\]\]?")


def literal_segment(part):
    return bool(DYNAMIC_SEGMENT.fullmatch(part))


def omitted(rel):
    """`src/.../App.java` 처럼 생략한 경로다. 동적 라우트 조각 안의 `...` 는 생략이 아니다."""
    return any(("..." in part or "…" in part) and not literal_segment(part) for part in rel.split("/"))


def glob_pattern(rel):
    """동적 라우트 조각을 escape 해 glob 으로 넘긴다."""
    return "/".join(re.sub(r"\[", "[[]", part) if literal_segment(part) else part for part in rel.split("/"))


def matches(rel, pattern):
    """* 는 한 경로 조각, ** 는 0개 이상의 디렉터리를 나타낸다. 동적 라우트 조각은 문자 그대로 대조한다."""
    parts, patterns = rel.split("/"), glob_pattern(pattern).split("/")

    def match(i, j):
        if j == len(patterns):
            return i == len(parts)
        if patterns[j] == "**":
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], patterns[j]) and match(i + 1, j + 1)

    return match(0, 0)


def legacy_manifest(text):
    return not section(text, "변경 파일") and bool(section(text, "Critical Files"))


def is_glob(rel):
    return any(any(c in part for c in "*?[") and not literal_segment(part) for part in rel.split("/"))


def check_file_state(path, entries, repo, virtual, out, warnings, legacy=False, created=None):
    """앞 phase 의 생성과 삭제를 적용한 파일 상태로 대조한다.

    생략 경로는 커밋 전 staged 대조에서 막히므로 「변경 파일」 절에서는 생성 때 위반이다.
    Critical Files 는 읽기 호환이라 경고로 둔다.
    created 는 앞 phase 가 신규로 선언한 glob 이다. 뒤 phase 가 그 glob 과 겹치는 경로나 glob 을
    수정하거나 삭제하면 존재로 본다. 앞 phase 가 삭제한 경로와 glob 은 virtual 에 False 로 남아 계속 위반이다.
    """
    created = created if created is not None else []
    for rel, action in entries:
        if omitted(rel):
            if legacy:
                warnings.append(f"{path} — 생략 경로는 존재를 대조하지 않는다: {rel}")
            else:
                out.append(f"{path} — 변경 파일에는 생략하지 않은 경로가 필요하다: {rel}")
            continue
        glob = is_glob(rel)
        candidates = {p.relative_to(repo).as_posix() for p in repo.glob(glob_pattern(rel))} if glob else {rel}
        candidates.update(p for p in virtual if not is_glob(p) and matches(p, rel))
        exists = any(virtual.get(p, (repo / p).exists()) for p in candidates)
        deleted = [p for p, alive in virtual.items() if alive is False]
        if not exists and not any(matches(rel, p) for p in deleted):
            # glob 끼리는 한쪽 문자열을 경로로 보고 다른 쪽에 맞춰 포함 관계를 판정한다.
            exists = any(matches(rel, pattern) or matches(pattern, rel) for pattern in created)
        if action == "신규" and glob:
            warnings.append(f"{path} — 신규 glob 은 구체 파일의 부재를 보장하지 못한다: {rel}")
            created.append(rel)
        elif action == "신규" and exists:
            out.append(f"{path} — 신규 파일이 이미 존재한다: {rel} (구현 후 검사는 --audit)")
        elif action in {"수정", "삭제"} and not exists:
            out.append(f"{path} — {action} 파일이 존재하지 않는다: {rel} (선행 계획이 만들 파일이면 그 계획이 머지된 뒤 기준 브랜치로 rebase 해 다시 돌린다)")
        if action == "삭제" and glob:
            for candidate in candidates:
                virtual[candidate] = False
            virtual[rel] = False
    # 같은 phase 의 신규 선언으로 그 phase 의 수정 오류를 숨기지 않는다.
    for rel, action in entries:
        if not omitted(rel) and not is_glob(rel):
            virtual[rel] = action != "삭제"


def shell_commands(text):
    """프로그램 위치를 읽는다. echo/grep 에 적힌 테스트 이름은 실행이 아니다."""
    for _, language, body in code_blocks(text):
        if language not in SHELL:
            continue
        for line in body.replace("\\\n", " ").splitlines():
            try:
                lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|()")
                lexer.whitespace_split = True
                tokens = list(lexer)
            except ValueError:
                continue
            command = []
            for token in tokens + [";"]:
                if token and all(c in ";&|()" for c in token):
                    if command:
                        while command and re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", command[0]):
                            command.pop(0)
                        if command and command[0] == "env":
                            command.pop(0)
                            while command and re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", command[0]):
                                command.pop(0)
                        if command:
                            yield command
                    command = []
                else:
                    command.append(token)


# 실행기 앞에 붙어 뒤 명령을 그대로 실행하는 접두어다. 벗긴 뒤 판정한다.
WRAPPERS = (("npx",), ("bunx",), ("uv", "run"), ("poetry", "run"), ("pipenv", "run"), ("bundle", "exec"), ("pnpm", "exec"), ("pnpm", "dlx"), ("yarn", "exec"), ("yarn", "dlx"))
WRAPPER_VALUE_OPTIONS = {"--with", "--python", "--project", "--directory", "--package", "--from", "-p"}
# 패키지 관리자에서 값을 받는 옵션이다. 옵션을 건너뛰고 스크립트 이름을 찾는다.
VALUE_OPTIONS = {
    "npm": {"--prefix", "-w", "--workspace"},
    "pnpm": {"--filter", "-F", "-C", "--dir"},
    "yarn": {"--cwd"},
    "bun": {"--cwd", "--filter"},
}
TEST_RUNNERS = {"pytest", "pytest-3", "tox", "nox", "jest", "vitest", "mocha", "rspec", "phpunit", "ctest"}
# 테스트를 실행하지 않는다고 알려진 명령이다. 여기에도 실행기에도 없는 명령은 판정하지 못해 경고로 둔다.
NON_TEST = {
    "echo", "printf", "cat", "ls", "cd", "pwd", "git", "grep", "rg", "egrep", "sed", "awk", "find", "jq", "curl",
    "wc", "head", "tail", "diff", "cmp", "mkdir", "rm", "cp", "mv", "touch", "export", "source", ".", "set",
    "sleep", "exit", "true", "false", ":", "test", "[", "ruff", "flake8", "pylint", "mypy", "black", "isort",
    "eslint", "prettier", "tsc", "shellcheck", "shfmt", "docker", "kubectl",
}
KNOWN = TEST_RUNNERS | set(VALUE_OPTIONS) | {"python", "python3", "gradlew", "gradle", "mvn", "mvnw", "go", "cargo", "deno", "dotnet", "make", "gmake", "bash", "sh"}
# node 에서 값을 따로 받는 옵션이다. `--test` 가 스크립트 이름보다 앞에 있는지 볼 때 건너뛴다.
NODE_VALUE_OPTIONS = {"--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C"}


def node_test(args):
    """`node [옵션] --test [파일...]` 이다. 스크립트 이름 뒤의 `--test` 는 스크립트 인자다."""
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg == "--test":
            return True
        elif arg in NODE_VALUE_OPTIONS:
            skip = True
        elif not arg.startswith("-"):
            return False
    return False


def unwrap(command):
    command = list(command)
    for prefix in WRAPPERS:
        if tuple(Path(t).name if i == 0 else t for i, t in enumerate(command[:len(prefix)])) == prefix:
            command = command[len(prefix):]
            while command and command[0].startswith("-"):
                option = command.pop(0)
                if option in WRAPPER_VALUE_OPTIONS and command:
                    command.pop(0)
            return unwrap(command)
    return command


def positional(program, args):
    """패키지 관리자의 옵션을 건너뛴 나머지 인자를 낸다."""
    rest, skip = [], False
    for arg in args:
        if skip:
            skip = False
        elif arg in VALUE_OPTIONS.get(program, set()):
            skip = True
        elif not arg.startswith("-") or rest:
            rest.append(arg)
    if program == "yarn" and rest[:1] == ["workspace"]:
        rest = rest[2:]
    return rest


def classify(command, entries, repo):
    """test, other, unknown 중 하나를 낸다. unknown 은 판정하지 못한 실행기다."""
    command = unwrap(command)
    if not command:
        return "other"
    program, args = Path(command[0]).name, command[1:]
    if any(a in {"--skipTests", "-DskipTests", "-Dmaven.test.skip=true", "--collect-only", "--help", "--dry-run"} or (a.startswith("-DskipTests=") and a != "-DskipTests=false") for a in args):
        return "other"
    if program in {"gradlew", "gradle"}:
        excluded = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg in {"-x", "--exclude-task"}]
        excluded.extend(arg.split("=", 1)[1] for arg in args if arg.startswith("--exclude-task="))
        if "-m" in args or any(task.split(":")[-1] in {"test", "check"} for task in excluded):
            return "other"
    found = None
    if program in TEST_RUNNERS:
        found = True
    elif program in {"python", "python3"} and args[:2] in (["-m", "pytest"], ["-m", "unittest"]):
        found = True
    elif program in {"gradlew", "gradle"}:
        found = any(a.split(":")[-1] in {"test", "check", "build"} for a in args)
    elif program in {"mvn", "mvnw"}:
        found = any(a in {"test", "verify", "package", "install"} for a in args)
    elif program in VALUE_OPTIONS:
        rest = positional(program, args)
        if rest[:1] in (["run"], ["run-script"]):
            rest = rest[1:]
        found = bool(rest) and (rest[0] == "test" or rest[0].startswith("test:"))
    elif program == "node" and node_test(args):
        found = True
    elif program in {"go", "cargo", "deno", "dotnet"}:
        found = bool(args) and args[0] == "test"
    elif program in {"make", "gmake"}:
        found = any(a in {"test", "check"} for a in args)
    if found is not None:
        return "test" if found else "other"
    script = command[0]
    if program in {"bash", "sh", "python", "python3"}:
        if not args or args[0].startswith("-"):
            return "other"
        script = args[0]
    elif program in NON_TEST:
        return "other"
    script = script.removeprefix("./")
    if not script.startswith(("scripts/", "tests/", "test/")):
        return "other" if program in KNOWN or "/" in script else "unknown"
    named = is_test(script) or re.search(r"(?:^|/)(?:check|verify|test)[_.-]", script)
    available = (repo / script).is_file() or any(matches(script, rel) and action != "삭제" for rel, action in entries)
    return "test" if named and available else "other"


def test_command(command, entries, repo):
    return classify(command, entries, repo) == "test"


# 디렉터리 인자를 하위 테스트 전체로 받는 실행기다. jest 와 vitest 의 위치 인자는 경로 패턴이라 디렉터리 아래를
# 모두 실행하고, pytest 는 디렉터리를 재귀로 모은다. 패키지 관리자의 `test` 스크립트는 jest 나 vitest 를 부른다고 본다.
# bun test 의 위치 인자는 경로 필터라 디렉터리 이름을 주면 그 아래 테스트를 모두 실행한다. 점 디렉터리는 check_bun_dot_paths 가 따로 본다.
# mocha 는 `--recursive` 가 있어야 해서, 확인하지 못한 실행기와 함께 뺀다.
DIRECTORY_RUNNERS = {"jest", "vitest", "pytest", "pytest-3", "bun"}
DIRECTORY_PACKAGE_MANAGERS = {"npm", "pnpm", "yarn"}


def recursive_directory_runner(command):
    command = unwrap(command)
    if not command:
        return False
    program, args = Path(command[0]).name, command[1:]
    if program == "bun":
        return positional("bun", args)[:1] == ["test"]
    return program in DIRECTORY_RUNNERS or program in DIRECTORY_PACKAGE_MANAGERS or (program in {"python", "python3"} and args[:2] == ["-m", "pytest"])


def directory_args(command):
    """디렉터리일 수 있는 인자를 낸다. `bun test src/profile` 의 `profile` 처럼 이름이 테스트처럼 보이지 않아도 경로 필터다."""
    command = unwrap(command)
    if command and Path(command[0]).name == "bun":
        rest, skip = [], False
        for arg in positional("bun", command[1:])[1:]:
            if skip:
                skip = False
            elif arg in BUN_TEST_VALUE_OPTIONS:
                skip = True
            elif not arg.startswith("-"):
                rest.append(arg)
        return rest
    return [arg for arg in command if is_test(arg)]


def command_cwds(commands):
    """명령마다 앞선 `cd <dir>` 를 반영한 저장소 루트 기준 작업 디렉터리를 낸다. 절대 경로와 `cd` 인자 없음은 루트로 본다."""
    cwd = ""
    for command in commands:
        if command[0] == "cd":
            target = next((a for a in command[1:] if not a.startswith("-")), None)
            cwd = "" if target is None or target.startswith(("/", "~", "$")) else posixpath.normpath(posixpath.join(cwd, target))
            if cwd == "." or cwd.startswith(".."):
                cwd = ""
        yield cwd


# bun test 에서 값을 따로 받는 옵션이다. 값은 테스트 경로 인자가 아니다.
BUN_TEST_VALUE_OPTIONS = {"-t", "--test-name-pattern", "--timeout", "--rerun-each", "--preload", "-r", "--reporter", "--reporter-outfile", "--coverage-dir", "--coverage-reporter", "--seed", "--bail", "--max-concurrency"}
# git grep 에서 값을 따로 받는 옵션이다. 패턴과 경로를 찾을 때 건너뛴다.
GIT_GREP_VALUE_OPTIONS = {"-e", "-f", "-A", "-B", "-C", "-m", "--max-count", "--max-depth", "--threads", "--open-files-in-pager", "-O"}


def check_bun_dot_paths(path, commands, out):
    """bun 1.3.5 실측이다. `./`, `../`, `/` 로 시작하지 않는 인자는 경로가 아니라 파일 이름 필터다.

    필터로 읽힌 인자는 `.claude/` 같은 점 디렉터리 아래를 찾지 않는다.
    다른 인자가 테스트를 찾으면 종료 코드가 0 이라 그 테스트를 건너뛴 것이 드러나지 않는다.
    """
    for command in commands:
        command = unwrap(command)
        if not command or Path(command[0]).name != "bun":
            continue
        rest = positional("bun", command[1:])
        if rest[:1] != ["test"]:
            continue
        skip = False
        for arg in rest[1:]:
            if skip:
                skip = False
            elif arg in BUN_TEST_VALUE_OPTIONS:
                skip = True
            elif arg.startswith("-") or arg.startswith(("./", "../", "/")):
                continue
            elif any(part.startswith(".") and part not in {".", ".."} for part in arg.split("/")):
                out.append(f"{path} — bun test 는 `./` 로 시작하지 않는 인자를 이름 필터로 읽어 점 디렉터리 아래 테스트를 찾지 않는다. `./{arg}` 로 쓴다")


def git_grep_paths(command):
    """`! git grep ...` 이면 (포함 pathspec, 제외 pathspec) 을, 아니면 None 을 낸다. 경로가 없으면 저장소 전체다."""
    if command[:1] != ["!"]:
        return None
    command, prefix = command[1:], ""
    if not command or Path(command[0]).name != "git":
        return None
    args = command[1:]
    while args and args[0].startswith("-"):
        option = args.pop(0)
        if option == "-C" and args:
            prefix = args.pop(0).removeprefix("./").rstrip("/") + "/"
    if args[:1] != ["grep"]:
        return None
    args, positional_args, pattern_given, skip, separated = args[1:], [], False, None, False
    for arg in args:
        if skip:
            pattern_given = pattern_given or skip in {"-e", "-f"}
            skip = None
        elif separated:
            positional_args.append(arg)
        elif arg == "--":
            # `--` 앞의 위치 인자는 패턴과 revision 이다.
            separated, positional_args = True, []
        elif arg in GIT_GREP_VALUE_OPTIONS:
            skip = arg
        elif not arg.startswith("-"):
            positional_args.append(arg)
    if not separated and not pattern_given:
        positional_args = positional_args[1:]
    include, exclude = [], []
    for spec in positional_args:
        excluded = re.match(r"^:(?:!|\^|\(exclude\))", spec)
        target = exclude if excluded else include
        target.append(posixpath.normpath(prefix + spec[excluded.end() if excluded else 0:]))
    return include or [posixpath.normpath(prefix or ".")], exclude


def pathspec_matches(rel, spec):
    """git pathspec 의 기본 규칙이다. 디렉터리는 그 아래 전체이고 glob 의 `*` 는 `/` 도 넘는다."""
    spec = spec.rstrip("/")
    return spec in {"", "."} or rel == spec or rel.startswith(spec + "/") or fnmatch.fnmatchcase(rel, spec)


REMOTE_PROGRAMS = {"ssh", "scp", "sftp", "mosh"}


def remote_command(command):
    """push 나 원격 호스트 접속이 있어야 끝나는 명령이면 True 다."""
    command = unwrap(command)
    if not command:
        return False
    program, args = Path(command[0]).name, command[1:]
    if program in REMOTE_PROGRAMS:
        return True
    if program == "git":
        rest = list(args)
        while rest and rest[0].startswith("-"):
            option = rest.pop(0)
            if option in {"-C", "-c"} and rest:
                rest.pop(0)
        return rest[:1] == ["push"]
    if program == "rsync":
        # `host:경로` 나 `user@host:경로` 는 원격이다. 옵션 값의 `=` 뒤 콜론은 보지 않는다.
        return any(re.match(r"^(?:[\w.-]+@)?[\w.-]+:", arg) for arg in args if not arg.startswith("-"))
    return False


def check_remote_commands(path, commands, warnings):
    for command in commands:
        if remote_command(command):
            warnings.append(f"{path} — 검증 절에 push 나 원격 접속이 있다. phase 검증은 커밋 전에 작업 공간에서 끝나야 한다. remote-verification.md 로 옮긴다: {' '.join(command)}")


def check_forbidden_grep_paths(path, commands, entries, warnings):
    """금지 문자열 검사의 경로에 같은 phase 의 테스트 파일이 있으면 경고한다.

    「X 가 없어야 한다」 를 단언하는 테스트는 X 를 문자열로 담는다. 그 파일이 검사 경로에 있으면
    두 검증이 동시에 통과할 수 없다. 테스트가 X 를 담는지는 구현 전이라 알 수 없어 경고로 둔다.
    """
    tests = [rel for rel, action in entries if action != "삭제" and is_test(rel)]
    for command in commands:
        paths = git_grep_paths(command)
        if not paths:
            continue
        include, exclude = paths
        for rel in tests:
            if any(pathspec_matches(rel, spec) for spec in include) and not any(pathspec_matches(rel, spec) for spec in exclude):
                warnings.append(f"{path} — 금지 문자열 검사가 같은 phase 의 테스트 파일에 걸릴 수 있다. 경로에서 빼거나 pathspec 제외(`':!{rel}'`)를 쓴다: {' '.join(command)}")


def check_staged(path, text, repo, out, warnings):
    entries = manifest(path, text, out, warnings)
    if any(omitted(rel) for rel, _ in entries):
        out.append(f"{path} — staged 대조에는 생략하지 않은 변경 파일 경로가 필요하다")
        return
    result = subprocess.run(["git", "diff", "--cached", "--name-status", "-z", "--find-renames"], cwd=repo, capture_output=True, check=True)
    fields = result.stdout.decode("utf-8").split("\0")
    changes, i = [], 0
    while i < len(fields) and fields[i]:
        status, rel = fields[i], fields[i + 1]
        i += 2
        if status.startswith(("R", "C")):
            new = fields[i]
            i += 1
            if status.startswith("R"):
                changes.append((rel, "삭제"))
            changes.append((new, "신규"))
        else:
            changes.append((rel, {"A": "신규", "D": "삭제"}.get(status, "수정")))
    if not changes:
        out.append(f"{path} — staged 변경이 없다")
    for rel, action in changes:
        allowed = [(pattern, kind) for pattern, kind in entries if matches(rel, pattern)]
        if not allowed:
            out.append(f"{path} — phase 범위 밖의 staged 파일: {rel}")
        elif not any(kind == action for _, kind in allowed):
            out.append(f"{path} — staged 변경 종류가 목록과 다르다: {rel} ({action})")
    # 목록에 있는데 staged 에 없는 파일이다. 신규 테스트가 빠진 커밋을 막는다.
    staged = set(changes)
    for rel, action in entries:
        if is_glob(rel) or (rel, action) in staged:
            continue
        if action == "신규":
            out.append(f"{path} — 신규로 적은 파일이 staged 에 없다: {rel}")
        else:
            warnings.append(f"{path} — {action}로 적은 파일이 staged 에 없다: {rel}")


def check_index(path: Path, plan_name: str, phase_files: list, out: list) -> None:
    """index.json 이 스키마와 실제 파일에 맞는지 본다.

    execution_profile 은 provider 중립 필드이고 model 은 읽기 호환용이다.
    둘 다 있으면 어느 쪽이 이기는지 정해져 있지 않아 실행 등급이 갈린다.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("phases"), list):
        out.append(f"{path} — index 객체와 phases 배열이 필요하다")
        return

    if data.get("name") != plan_name:
        out.append(f"{path} — name 이 디렉터리명과 다르다: {data.get('name')!r} != {plan_name!r}")

    phases = data.get("phases", [])
    if data.get("total_phases") != len(phases):
        out.append(f"{path} — total_phases({data.get('total_phases')}) 가 phases 길이({len(phases)})와 다르다")

    for key in FORBIDDEN_KEYS:
        if key in data:
            out.append(f"{path} — 스키마에 없는 키: {key}")

    on_disk = {f.name for f in phase_files}
    listed = []
    for i, phase in enumerate(phases):
        if not isinstance(phase, dict):
            out.append(f"{path} — phases[{i}] 가 객체가 아니다")
            continue
        for key in ("number", "file"):
            if key not in phase:
                out.append(f"{path} — phases[{i}] 에 {key} 가 없다")

        if phase.get("number") != i + 1:
            out.append(f"{path} — phases[{i}] number 가 {i + 1} 이 아니다: {phase.get('number')}")

        f = phase.get("file")
        if not isinstance(f, str) or f not in on_disk:
            out.append(f"{path} — phases[{i}] 가 가리키는 {f} 가 없다")
        else:
            listed.append(f)

        has_profile = isinstance(phase.get("execution_profile"), str) and phase["execution_profile"] in PROFILES
        has_model = isinstance(phase.get("model"), str) and phase["model"] in MODELS
        both = "execution_profile" in phase and "model" in phase
        if both or not (has_profile or has_model):
            out.append(f"{path} — phases[{i}] execution_profile/model schema 오류")
    if set(listed) != on_disk or len(listed) != len(on_disk):
        out.append(f"{path} — phases 목록과 실제 phase 파일이 일치하지 않는다")


def check_bash_cwd(path: Path, text: str, out: list) -> None:
    """번들 스크립트 경로와 실행할 저장소를 혼동하는 블록만 검사한다."""
    for start, language, body in code_blocks(text):
        if language in {"bash", "sh", "shell", "zsh"} and BUNDLE.search(body):
            if not re.search(r"^\s*# cwd:", body, re.M):
                out.append(f"{path}:{start} — 스킬 번들 명령의 cwd 주석 누락")


def iter_prose(text: str):
    """코드 블록 밖의 산문만 낸다. 「의도 메모」 절과 첫 절 이전의 머리말은 뺀다.

    의도 메모를 빼는 이유는 설계 근거를 적는 절이라 「직접 확인」 같은 표현이
    자연스럽게 나오기 때문이다. 그것까지 잡으면 글을 규칙에 맞춰 비틀게 되고,
    정작 검증 기준의 결함은 그대로 남는다.

    뺄 절을 하나만 지정한다. 볼 절을 열거하면 작업 항목처럼 자동 실행이 실제로
    끊기는 자리를 놓친다. 사람 의존 지시는 검증 절보다 작업 항목에 더 자주 들어간다.
    """
    skip = True  # 첫 "## " 이전은 phase 를 소개하는 문장이라 뺀다
    for n, line, kind, _ in fences(text):
        if kind != "text":
            continue
        if line.startswith("## "):
            skip = "의도 메모" in line
            continue
        if not skip:
            yield n, line


def check_phase_prompt(path, text, out, entries=(), repo=None, warnings=None):
    """같은 phase 의 테스트 작업과 실행 지시를 본다. 작업 순서는 강제하지 않는다."""
    repo = repo or Path.cwd()
    warnings = warnings if warnings is not None else []
    context = section(text, "컨텍스트") or text
    evidence = re.search(r"\*\*근거 문서\*\*\s*:(.*?)(?=\n\s*\n|\Z)", context, re.S)
    if not evidence or not DOC_PATH.findall(evidence.group(1)):
        out.append(f"{path} — 근거 문서에 docs/ 경로가 없다")
    else:
        for rel in DOC_PATH.findall(evidence.group(1)):
            if not (repo / rel).is_file():
                out.append(f"{path} — 근거 문서가 없는 경로를 가리킨다: {rel}")
    work, validation = section(text, "작업 항목"), section(text, "검증")
    if not re.search(r"^### .+", work, re.M):
        out.append(f"{path} — 작업 항목이 없다")
    commands = list(shell_commands(validation))
    cwds = list(command_cwds(commands))
    runners = [command for command in commands if test_command(command, entries, repo)]
    if not commands:
        out.append(f"{path} — 검증 절에 실행할 명령이 없다")
    elif not runners:
        unknown = [command for command in commands if classify(command, entries, repo) == "unknown"]
        if unknown:
            warnings.append(f"{path} — 테스트 실행 여부를 판정하지 못한 명령이다. 테스트를 실행하는지 직접 확인한다: {' '.join(unknown[0])}")
        else:
            out.append(f"{path} — 검증 절에 테스트 실행 명령이 없다 (lint/grep/echo 만으로 완료할 수 없다)")
    check_bun_dot_paths(path, commands, out)
    check_forbidden_grep_paths(path, commands, entries, warnings)
    check_remote_commands(path, commands, warnings)

    def runs(part):
        return any(test_command(c, entries, repo) for c in shell_commands(f"```bash\n{part}\n```"))

    for _, language, body in code_blocks(validation):
        if language not in SHELL:
            continue
        pipefail = re.search(r"set\s+-[A-Za-z]*o\s+pipefail", body)
        for line in body.splitlines():
            if re.search(r"\|\|\s*(?:true|:|exit\s+0)(?:\s|;|$)", line) and runs(line.split("||", 1)[0]):
                out.append(f"{path} — 테스트 실패를 무시하는 명령: {line.strip()}")
            pipes = re.split(r"(?<!\|)\|(?!\|)", line)
            if not pipefail and len(pipes) > 1 and re.match(r"\s*tee\b", pipes[-1]) and runs(pipes[0]):
                warnings.append(f"{path} — pipefail 없이 tee 로 넘기면 테스트 실패 종료 코드가 사라진다: {line.strip()}")
    for _, line in iter_prose("## 작업 항목\n" + work + "\n## 검증\n" + validation):
        if DEFER_TEST.search(line) and not NOT_DEFERRED.search(line):
            out.append(f"{path} — 테스트를 다른 phase 로 미루는 지시: {line.strip()}")
    changed_code = [rel for rel, action in entries if action != "삭제" and Path(rel).suffix in CODE_SUFFIXES and not is_test(rel)]
    changed_tests = [rel for rel, action in entries if action != "삭제" and is_test(rel)]
    prose = "\n".join(line for _, line in iter_prose("## 작업 항목\n" + work))
    references = re.findall(r"`([^`\n]+)`", prose)
    test_references = [ref for ref in references if is_test(ref) or re.search(r"(?:Test|Tests|Spec)$", ref)]
    declared_tests = [
        rel for rel in changed_tests
        if any(ref == rel or Path(ref).name in {Path(rel).name, Path(rel).stem} for ref in references)
        or (is_glob(rel) and test_references)
    ]
    checked_script = any(any(arg.removeprefix("./") in changed_code and arg in work for arg in command) for command in runners)
    if changed_code and not declared_tests and not checked_script:
        out.append(f"{path} — 코드 변경을 검증할 테스트 파일 또는 검증 스크립트 작업이 같은 phase 에 없다")
    targeted = [arg for command in runners for arg in command if is_test(arg)]
    # 디렉터리 인자는 `cd <dir> &&` 를 반영한 저장소 루트 기준 경로로도 대조한다.
    directories = [
        posixpath.normpath(posixpath.join(cwd, arg))
        for command, cwd in zip(commands, cwds)
        if test_command(command, entries, repo) and recursive_directory_runner(command)
        for arg in directory_args(command) if not arg.startswith(("/", "-"))
    ]
    # 보조 파일은 그것을 쓰는 테스트가 실행한다. 어느 테스트가 쓰는지는 구현 전이라 알 수 없어 파일 단위로 대조하지 않는다.
    runnable = [rel for rel in declared_tests if runnable_test(rel)]
    if runnable and (targeted or directories) and not any(Path(command[0]).name in {"gradle", "gradlew", "mvn", "mvnw"} for command in runners):
        for rel in runnable:
            if not any(matches(rel, arg) or Path(rel).name == Path(arg).name or rel.startswith(arg.rstrip("/") + "/") for arg in targeted) \
                    and not any(rel.startswith(directory + "/") for directory in directories):
                out.append(f"{path} — 검증 명령이 작업 항목의 테스트를 실행하지 않는다: {rel}")
    for command in runners:
        if any(arg.removeprefix("./").startswith("scripts/") for arg in command):
            warnings.append(f"{path} — 저장소 스크립트의 테스트 범위와 실패 종료 코드는 직접 확인한다: {' '.join(command)}")


def check_code_sed(path, text, out):
    """셸 블록의 `sed ... \\b` 도 산문과 같이 본다. BSD sed 는 `\\b` 를 모른다."""
    for n, line, kind, language in fences(text):
        if kind == "code" and language in SHELL and BSD_SED.search(line):
            out.append(f"{path}:{n}: {line}")


def check_human_verification(path, text, out):
    """추가 낱말은 명령 없는 검증 절에 한정해 설계 설명의 오탐을 피한다."""
    validation = section(text, "검증")
    if not list(shell_commands(validation)):
        for _, line in iter_prose("## 검증\n" + validation):
            if HUMAN_ONLY.search(line):
                out.append(f"{path} — 명령 없는 사람 의존 검증: {line.strip()}")


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", nargs="?")
    parser.add_argument("--audit", action="store_true", help="구현 후 문서 검사. 구현 전 파일 상태는 대조하지 않는다")
    parser.add_argument("--staged", type=Path, metavar="PHASE", help="phase 변경 파일 목록과 git index 대조")
    parser.add_argument("--tasks-dir", default="tasks", help="계획서 디렉터리. 저장소 루트 기준 (기본값 tasks)")
    try:
        args = parser.parse_args(argv[1:])
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if bool(args.plan) == bool(args.staged) or (args.audit and args.staged):
        print("plan 또는 --staged PHASE 중 하나를 지정한다", file=sys.stderr)
        return 2
    repo, out, warnings = Path.cwd(), [], []
    try:
        if args.staged:
            check_staged(args.staged, args.staged.read_text(encoding="utf-8"), repo, out, warnings)
        else:
            if Path(args.plan).name != args.plan:
                raise ValueError(f"plan 은 {args.tasks_dir}/ 아래 디렉터리 이름이어야 한다")
            plan_dir = repo / args.tasks_dir / args.plan
            phases = sorted(plan_dir.glob("phase-*.md"))
            if not phases:
                raise ValueError(f"phase 파일 없음: {plan_dir}")
            check_index(plan_dir / "index.json", args.plan, phases, out)
            virtual, created = {}, []
            if args.audit:
                warnings.append("구현 후 문서 검사: 신규/수정/삭제 파일의 구현 전 존재 조건은 대조하지 않는다")
            for path in phases:
                text = path.read_text(encoding="utf-8")
                for marker in REQUIRED_SECTIONS:
                    if marker not in text:
                        out.append(f"{path} — 필수 섹션 누락: {marker}")
                entries = manifest(path, text, out, warnings)
                if not args.audit:
                    check_file_state(path, entries, repo, virtual, out, warnings, legacy_manifest(text), created)
                check_bash_cwd(path, text, out)
                for n, line in iter_prose(text):
                    if VAGUE_SCOPE.search(line) or HUMAN_CHECK.search(line) or BSD_SED.search(line):
                        out.append(f"{path}:{n}: {line}")
                check_code_sed(path, text, out)
                check_human_verification(path, text, out)
                check_phase_prompt(path, text, out, entries, repo, warnings)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"검사를 실행하지 못했다: {exc}", file=sys.stderr)
        return 2
    for line in out:
        print(line)
    for warning in warnings:
        print(f"경고: {warning}")
    print(f"위반 {len(out)}건, 경고 {len(warnings)}건")
    return 1 if out else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
