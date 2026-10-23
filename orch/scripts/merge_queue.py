#!/usr/bin/env python3
"""사용: merge_queue.py [옵션] PR[:머지 전 명령] ...

받은 순서대로 PR 을 하나씩 머지한다. 한 PR 이라도 조건에 못 미치면 이유를 찍고 종료 코드 1 로 멈춘다.
PR 마다 하는 일:
  1. 이미 MERGED 면 건너뛴다. OPEN 이 아니면 멈춘다
  2. 필수 체크가 모두 나타나고 끝날 때까지 기다린다(--check-timeout 분까지).
     PR 을 연 직후에는 체크 목록이 비어 있어 「대기 0」이 「모두 끝남」이 아니기 때문이다
     --require-up-to-date 이면 PR 이 base 최신을 품는지 보고, 아니면 base 를 merge 한 뒤 2 를 다시 한다
     (--up-to-date-when overlap 이면 base 최신을 품지 않아도 단위가 겹치지 않으면 merge 없이 3 으로 간다)
  3. 실패한 체크, 미해결 리뷰 스레드, 충돌이 있으면 멈춘다. mergeable 이 UNKNOWN 이면 몇 번 다시 묻는다
     --allow-fail 로 준 체크의 실패는 세지 않고 경고 줄만 찍는다
  3-1. --stop-on-overlap 이나 --verify-merged 를 주면, PR 이 바꾼 파일과 PR 이 갈라진 뒤 base 에서 바뀐 파일이
     겹치는지 본다. 겹치면 --stop-on-overlap 은 겹친 파일을 찍고 멈추고, --verify-merged 는 base 와 합친
     임시 사본에서 그 명령을 돌려 0 일 때만 이어 간다. 체크는 PR 기준으로 돌아 같은 파일을 고친 base 와 합친
     상태는 아무도 검사하지 않았기 때문이다. 겹치지 않으면 그대로 이어 간다.
     --verify-merged-when 으로 겹치지 않아도 검사하게 하고, --docs-glob 에 맞는 문서 PR 은 검사 없이 머지한다
  4. 머지 전 명령이 있으면 돌리고, 0 이 아니면 멈춘다(DB 백업 같은 것)
  5. 체크를 보기 전에 읽어 둔 HEAD 와 지금 PR HEAD, 원격 브랜치 HEAD 가 모두 같은지 본다.
     검사나 머지 전 명령이 도는 사이에 push 된 커밋이 검사 없이 머지되는 것을 막는다
  6. 처음 읽은 HEAD 로 --match-head-commit 머지하고 MERGED 를 확인한 뒤 원격을 fetch 하고 원격 브랜치를 지운다.
     fork PR, release/* 브랜치, 다른 열린 PR 의 base 인 브랜치는 지우지 않는다

origin 은 PR 이 속한 저장소를 가리켜야 한다. fork 를 origin 으로 둔 체크아웃에서는 HEAD 대조가 STOP 으로 끝난다.

옵션
  --repo DIR            대상 저장소 경로. 기본은 현재 디렉터리. gh 호스트와 저장소는 이 저장소의 origin 이 정한다
                        `gh pr` 는 origin 으로 호스트를 찾지만 `gh api` 는 찾지 않고 기본 호스트(보통 github.com)로 간다.
                        그래서 `gh api` 에는 PR URL 의 호스트(`gh pr` 가 origin 으로 정한 값)를 --hostname 으로 넘긴다.
                        GH_HOST 환경 변수는 보지 않는다. 전역 GH_HOST 가 다른 호스트를 가리켜도 `gh pr` 와 같은 호스트로 간다
  --before CMD          모든 PR 에 쓸 머지 전 명령. `PR:명령` 으로 준 PR 은 그 명령을 쓴다
  --method M            merge | squash | rebase. 기본 merge
  --threads-cmd CMD     미해결 스레드 수를 정수로 내는 명령. 기본은 형제 스킬 review-fix 의 review_threads.py
  --check-timeout MIN   체크 대기 한도(분). 기본 60
  --required A,B,C      나타나야 하는 필수 체크 이름. 없으면 저장소 규칙(rules/branches/BASE 의
                        required_status_checks)에서 읽는다. 둘 다 비면 목록이 비었다는 경고를 찍고
                        지금 있는 체크만 기다린다(예전 동작). 규칙 조회가 실패하면 멈춘다.
                        예전 방식의 브랜치 보호 규칙은 규칙 조회에 나오지 않으므로 이 옵션으로 준다
  --allow-fail A,B      실패해도 멈추지 않을 비필수 체크 이름. 실패한 체크마다 `경고: PR 실패를 허용한 체크 이름` 을
                        찍고 머지한다. 코드와 무관한 이유(사용량 한도, 외부 장애)로 실패했고 그 대신 할 검증을
                        끝냈을 때만 쓴다. 진행 중인 체크는 이 옵션과 상관없이 끝날 때까지 기다린다.
                        필수 체크(--required 나 저장소 규칙)에 든 이름은 허용할 수 없다
  --require-up-to-date  머지 전에 PR 이 base 최신을 품지 않으면 update-branch 로 base 를 merge 하고
                        필수 체크를 다시 기다린 뒤 머지한다. 기본은 끔. 필수 체크 목록이 있어야 켤 수 있다
  --up-to-date-when W   --require-up-to-date 가 base 를 merge 하는 때. always(기본, 뒤처졌으면 늘) 또는 overlap.
                        overlap 은 PR 이 바꾼 단위와 PR 이 갈라진 뒤 base 에 들어온 변경의 단위가 겹치지 않으면
                        최신화와 CI 재대기 없이 머지한다. 판정은 PR 차례마다 하고 `<PR> 판정: 바로 머지` 나
                        `<PR> 판정: 갱신 필요(이유)` 한 줄을 찍는다. 판정은 overlap_units.py 가 소유한다.
                        단위는 --unit-prefix 아래 폴더 하나이고 그 밖의 파일은 경로 자체다. --shared-paths 에 맞는 파일과
                        --docs-glob 에 맞는 문서 파일은 각각 겹친 것으로 보거나 세지 않는다.
                        판정하지 못하면 갱신 필요로 다룬다. --require-up-to-date 가 있어야 한다.
                        판정은 한 번으로 끝나지 않는다. 갱신하고 CI 를 기다리는 사이나, 바로 머지로 판정한 뒤 머지 직전에
                        base 가 또 움직이면 다시 판정한다. 갱신을 마친 PR 은 새로 들어온 변경(PR 의 새 merge-base 기준)만 보고,
                        갱신하지 않은 PR 은 처음 갈라진 뒤 base 의 변경을 모두 다시 본다.
                        겹치지 않으면 다시 갱신하지 않고 머지하고, 겹칠 때만 또 갱신한다. PR HEAD 는 --match-head-commit 으로 계속 지킨다.
                        다시 판정하는 횟수는 PR 하나에 5번까지이고 넘으면 `STOP <PR> 다시 판정을 5번 했는데도 base(<브랜치>) 가 계속 움직인다` 로 멈춘다
                        GitHub 의 「브랜치를 최신으로 유지」 보호 규칙이 켜진 저장소는 머지가 거부되므로 쓰지 않는다
  --shared-paths RE     overlap 에서 어느 쪽에 있든 겹친 것으로 보는 공용 경로의 정규식(Python 정규식, re.search 라 경로 어디든 맞는다).
                        모든 모듈에 영향을 주는 경로(공용 모듈, 루트 빌드 파일, 계약, CI 설정)를 적는다
  --unit-prefix P       overlap 에서 폴더 하나를 단위로 보는 접두. 기본 modules/
  --unit-group A,B      overlap 에서 한 단위로 세는 단위 묶음. 여러 번 줄 수 있다. 계약 파일 없이 서로의 응답 모양에
                        기대는 모듈 쌍(화면 모듈과 그 BFF)은 폴더가 달라도 묶음 안 어느 쪽이 바뀌든 겹친 것으로 본다
  --stop-on-overlap     PR 의 바뀐 파일이 PR 기준 이후 base 에서 바뀐 파일과 겹치면 `STOP PR 겹침: 파일...` 로 멈춘다
  --verify-merged CMD   겹치면 origin/BASE 에 PR HEAD 를 merge 한 임시 사본을 만들고, 그 안에서 CMD 를 bash -c 로
                        돌린다. 사본의 절대경로를 첫 인자($1)로 받는다. 0 이면 이어 가고 아니면 멈춘다.
                        합치다 충돌하거나, 검사하는 동안 원격 base 가 움직였으면 멈춘다. 사본은 끝나면 지운다.
                        검사 명령은 저장소마다 달라 오버레이가 정한다(예: --verify-merged 'cd "$1" && make test')
                        MERGE_COPY(사본), PR(번호), PR_HEAD, BASE_HEAD, CHANGED_FILES, OVERLAP_FILES 를 환경 변수로
                        받는다. 파일 목록은 줄바꿈으로 이으며 삭제된 파일도 포함한다. $1 도 사본 경로다
  --verify-merged-when W  합친 사본 검사를 언제 할지. overlap(기본, 겹칠 때만), code(문서만 바꾼 PR 이 아니면 늘),
                        always(모든 PR). 파일이 겹치지 않아도 합쳐서 깨질 수 있다(두 PR 이 각자 통과했지만 합치니
                        같은 상한을 함께 넘었다). code 와 always 는 --verify-merged 가 있어야 한다
  --docs-glob G1,G2     문서 파일의 glob. PR 이 바꾼 파일이 모두 이것에 맞으면 overlap 과 code 에서 합친 사본 검사 없이
                        머지한다. 충돌은 mergeable 로 이미 걸렀다. case 패턴이라 `*` 가 `/` 도 넘는다
                        (예: --docs-glob 'docs/*,*.md'). 여러 번 주면 이어 붙인다.
                        --verify-merged, --after-merged, --update-docs-on-overlap 가운데 하나와 함께 쓴다
  --update-docs-on-overlap  문서 PR 의 파일이 base 와 겹치면 GitHub mergeStateStatus 가 CLEAN 일 때 base 를 합치고
                        필수 CI 를 다시 기다린다. --docs-glob 과 필수 체크 목록이 필요하다. --stop-on-overlap 과도 쓴다
  --copy-dir DIR        임시 사본을 둘 폴더. 기본은 TMPDIR(없으면 /tmp). 상대경로는 --repo 기준이다.
                        저장소 hook 이 워크트리 위치를 막으면 오버레이가 허용된 폴더를 준다.
                        링크를 푼 실경로로 바꿔 쓴다. macOS 의 TMPDIR(/var/folders/...)는 /var 가 /private/var 를
                        가리키는 링크라, 실경로를 요구하는 검사가 사본 경로를 거부한다. 검사 명령의 TMPDIR 도 실경로로 준다
                        사본 이름은 merge-queue-pr<PR>-<pid> 다. 시작할 때 이 폴더에서 pid 가 죽은 사본을 지운다.
                        EXIT trap 은 KILL 로 끝나면 돌지 못해 사본이 남기 때문이다
  --continue-on-hold    한 PR 이 조건에 못 미치면 멈추지 않고 STOP 줄을 찍은 뒤 다음 PR 로 간다. 끝에
                        `QUEUE-HELD 번호...` 를 찍고 정리를 부른 뒤 종료 코드 1 로 끝난다. 기본은 첫 보류에서 멈춘다
  --skipped-is-missing  결론이 SKIPPED 인 체크는 나타나지 않은 것으로 본다. 필수 체크가 SKIPPED 로만 있으면
                        실제로 돌 때까지 기다린다. draft 에서는 CI 를 건너뛰게 둔 저장소용이다. 기본은 끔
                        (GitHub 처럼 SKIPPED 를 통과로 본다). 필수 체크 목록이 있어야 뜻이 있다
  --after-merged CMD    이번 실행에서 PR 을 하나라도 머지했으면, 큐가 끝나거나 보류로 멈춘 뒤 CMD 를 한 번 bash -c 로
                        돌린다(배포 같은 것). 환경 변수 MERGED_PRS(머지한 PR 번호, 공백으로 이음)와 CODE_PRS(그 가운데
                        --docs-glob 에 맞는 문서 PR 을 뺀 것. --docs-glob 이 없으면 MERGED_PRS 와 같다)를 받는다.
                        실패하면 `AFTER-MERGED-FAILED 종료코드` 를 찍는다. 머지 결과는 바뀌지 않는다
  --keep-branch         머지 뒤 원격 브랜치를 지우지 않는다
  --sweep-arg ARG       머지가 끝난 뒤 부르는 cleanup-sweep.py 에 넘길 인자. 하나씩 준다
                        (예: --sweep-arg --run --sweep-arg run_x --sweep-arg --specs-dir --sweep-arg .orch/specs)
  --no-sweep            머지 뒤 cleanup-sweep.py --apply 를 부르지 않는다

모든 PR 이 머지되면 cleanup-sweep.py --apply 로 머지된 worktree, 브랜치, 터미널, 지시서를 정리한다.
정리가 실패해도 머지 결과는 바뀌지 않으므로 경고만 찍고 종료 코드는 0 이다.
CLEANUP_SWEEP 환경 변수로 정리 스크립트 경로를 바꾼다.

PR 조회(gh pr view)가 실패하면 MERGE_QUEUE_GH_RETRIES 번(기본 3)까지 MERGE_QUEUE_GH_RETRY_SECONDS 초(기본 10)
간격으로 다시 부른다. 일시 실패로 CI 를 통과한 PR 이 「체크 조회 실패」 로 보류되지 않게 하기 위해서다.

머지 전 명령, --threads-cmd, --verify-merged 는 bash -c 로 돈다. 환경 변수 PR(번호), BRANCH(head 브랜치), OWNER, REPO,
GH_HOST(위 --hostname 과 같은 값)를 받는다.
예: merge_queue.py 101 102:'./bin/backup-db.sh orders "pr-$PR"' 103

종료 코드: 0 모두 머지(또는 이미 MERGED), 1 어느 PR 에서 멈춤(--continue-on-hold 면 보류한 PR 이 있음), 2 사용법 오류,
          3 모두 머지했지만 --after-merged 명령이 실패했다

MERGE_QUEUE_SLEEP_SCALE 는 모든 대기 시간에 곱할 배율이다(기본 1). tests 가 0 으로 둔다.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from overlap_units import group_map  # noqa: E402

# merge-with-finish.py 가 값을 받는 옵션과 맞는지 tests 가 본다
VALUE_OPTIONS = {"--repo", "--before", "--method", "--threads-cmd", "--check-timeout", "--required", "--allow-fail",
                 "--up-to-date-when", "--shared-paths", "--unit-prefix", "--unit-group", "--verify-merged",
                 "--verify-merged-when", "--docs-glob", "--copy-dir", "--after-merged", "--sweep-arg"}
REJUDGE_LIMIT = 5  # 첫 판정 뒤에 base 가 움직여 다시 판정하는 횟수의 상한. 넘으면 멈춘다
SLEEP_SCALE = float(os.environ.get("MERGE_QUEUE_SLEEP_SCALE", "1"))
DOCS_ONLY_NOTE = "--docs-glob 은 --after-merged 나 --verify-merged 와 함께 쓴다(--up-to-date-when overlap 과도 쓴다)"

# 롤업에 나타난 체크 이름(체크 실행은 name, 커밋 상태는 context)
ROLL_NAMES = "[.statusCheckRollup[] | (.name // .context)]"
ROLL_NAMES_NO_SKIPPED = '[.statusCheckRollup[] | select((.conclusion // "") != "SKIPPED") | (.name // .context)]'
PENDING = ('[.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING" '
           'or (.state // "") == "EXPECTED")] | length')
FAIL_SEL = ('select(((.conclusion // "") | test("FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE")) '
            'or ((.state // "") | test("FAILURE|ERROR")))')
RULES_JQ = ('[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] '
            '| unique | join(",")')


class Usage(Exception):
    """사용법 오류. 종료 코드 2 로 끝난다."""


class Stop(Exception):
    """PR 하나가 조건에 못 미쳐 멈춘다. 종료 코드 1 이고 --continue-on-hold 면 다음 PR 로 간다."""


def now():
    return time.strftime("%H:%M")


def log(message):
    print(f"{now()} {message}", flush=True)


def nap(seconds):
    time.sleep(seconds * SLEEP_SCALE)


def stop(message):
    raise Stop(message)


def names_json(names):
    """쉼표로 이은 이름을 jq 배열 리터럴로 바꾼다."""
    return json.dumps([x for x in names.split(",") if x], ensure_ascii=False)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def git(*args, **kw):
    return run(["git", *args], **kw)


class Options:
    def __init__(self):
        self.repo = "."
        self.before_all = ""
        self.method = "merge"
        self.threads_cmd = ""
        self.check_timeout = "60"
        self.required = ""
        self.allow_fail = ""
        self.up_to_date = False
        self.up_to_date_when = "always"
        self.shared_paths = ""
        self.unit_prefix = "modules/"
        self.unit_groups = []
        self.keep_branch = False
        self.sweep = True
        self.sweep_args = []
        self.overlap = False
        self.verify_merged = ""
        self.verify_when = "overlap"
        self.docs_glob = ""
        self.update_docs = False
        self.continue_on_hold = False
        self.skipped_missing = False
        self.after_merged = ""
        self.copy_dir = ""
        self.items = []


def parse_args(argv):
    o = Options()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            raise Usage("")
        if arg in VALUE_OPTIONS:
            value = argv[i + 1] if i + 1 < len(argv) else ""
            if not value:
                raise Usage(f"{arg} 에 값이 없다")
            i += 2
            if arg == "--repo":
                o.repo = value
            elif arg == "--before":
                o.before_all = value
            elif arg == "--method":
                o.method = value
            elif arg == "--threads-cmd":
                o.threads_cmd = value
            elif arg == "--check-timeout":
                o.check_timeout = value
            elif arg == "--required":
                o.required = value
            elif arg == "--allow-fail":
                o.allow_fail = value
            elif arg == "--up-to-date-when":
                o.up_to_date_when = value
            elif arg == "--shared-paths":
                o.shared_paths = value
            elif arg == "--unit-prefix":
                o.unit_prefix = value
            elif arg == "--unit-group":
                o.unit_groups += ["--unit-group", value]
            elif arg == "--verify-merged":
                o.verify_merged, o.overlap = value, True
            elif arg == "--verify-merged-when":
                o.verify_when = value
            elif arg == "--docs-glob":
                o.docs_glob = f"{o.docs_glob},{value}" if o.docs_glob else value
            elif arg == "--copy-dir":
                o.copy_dir = value
            elif arg == "--after-merged":
                o.after_merged = value
            elif arg == "--sweep-arg":
                o.sweep_args.append(value)
            continue
        flags = {"--require-up-to-date": "up_to_date", "--keep-branch": "keep_branch",
                 "--continue-on-hold": "continue_on_hold", "--skipped-is-missing": "skipped_missing"}
        if arg in flags:
            setattr(o, flags[arg], True)
        elif arg == "--stop-on-overlap":
            o.overlap = True
        elif arg == "--update-docs-on-overlap":
            o.update_docs = o.overlap = True
        elif arg == "--no-sweep":
            o.sweep = False
        elif arg.startswith("-"):
            raise Usage(f"모르는 옵션: {arg}")
        else:
            o.items.append(arg)
        i += 1
    return validate(o)


def validate(o):
    if not o.items:
        raise Usage("")
    if o.method not in ("merge", "squash", "rebase"):
        raise Usage("--method 는 merge, squash, rebase 중 하나다")
    if not o.check_timeout.isdigit():
        raise Usage("--check-timeout 은 분 단위 정수다")
    if o.verify_when not in ("overlap", "code", "always"):
        raise Usage("--verify-merged-when 은 overlap, code, always 중 하나다")
    if o.up_to_date_when not in ("always", "overlap"):
        raise Usage("--up-to-date-when 은 always, overlap 중 하나다")
    if o.up_to_date_when == "overlap":
        if not o.up_to_date:
            raise Usage("--up-to-date-when overlap 은 --require-up-to-date 와 함께 쓴다")
    elif o.shared_paths or o.unit_groups:
        raise Usage("--shared-paths 와 --unit-group 은 --up-to-date-when overlap 과 함께 쓴다")
    if not o.verify_merged:
        if o.verify_when != "overlap":
            raise Usage(f"--verify-merged-when {o.verify_when} 은 --verify-merged 와 함께 쓴다")
        if o.docs_glob and not (o.after_merged or o.update_docs or o.up_to_date_when == "overlap"):
            raise Usage(DOCS_ONLY_NOTE)
    if o.update_docs and not o.docs_glob:
        raise Usage("--update-docs-on-overlap 은 --docs-glob 이 필요하다")
    if re.search(r'["\\]', o.required):
        raise Usage("--required 에 따옴표나 역슬래시를 넣을 수 없다")
    if re.search(r'["\\]', o.allow_fail):
        raise Usage("--allow-fail 에 따옴표나 역슬래시를 넣을 수 없다")
    for name in o.allow_fail.split(","):
        if name and name in o.required.split(","):
            raise Usage(f"--allow-fail 의 {name} 는 --required 에도 있다. 필수 체크의 실패는 허용할 수 없다")
    try:
        group_map([g.split(",") for g in o.unit_groups[1::2]])
    except ValueError as exc:
        raise Usage(f"--unit-group: {exc}") from None
    for item in o.items:
        number = item.split(":", 1)[0]
        if not number.isdigit():
            raise Usage(f"PR 번호가 아니다: {item}")
    return o


class PR:
    """PR 하나를 처리하는 동안 쓰는 값."""


class Queue:
    def __init__(self, opts):
        self.o = opts
        self.script_dir = HERE
        self.overlap_units = os.environ.get("OVERLAP_UNITS", str(HERE / "overlap_units.py"))
        self.sweep_base = ""
        self.merged = []  # (번호, code|docs). --after-merged 가 읽는다
        self.held = []
        self.copy = ""
        self.after_failed = False
        self.real_tmp = ""
        self.copy_dir = ""
        self.gh_retries = 3
        self.gh_retry_seconds = 10
        self.pr = None
        self.env = dict(os.environ)

    # ---- 준비 -------------------------------------------------------------------------------------

    def setup(self):
        o = self.o
        try:
            os.chdir(o.repo)
        except OSError as exc:
            raise Usage(f"{o.repo} 로 이동하지 못했다: {exc.strerror}") from exc
        tmp = os.environ.get("TMPDIR") or "/tmp"
        if not os.path.isdir(tmp):
            raise Usage(f"TMPDIR 를 읽지 못했다: {tmp}")
        self.real_tmp = os.path.realpath(tmp)
        self.copy_dir = o.copy_dir or self.real_tmp
        if not o.threads_cmd:
            rt = HERE / "../../review-fix/scripts/review_threads.py"
            if not rt.is_file():
                raise Usage(f"review_threads.py 를 찾지 못했다: {rt}. --threads-cmd 로 준다")
            o.threads_cmd = f"python3 '{rt}' list --count \"$OWNER\" \"$REPO\" \"$PR\""
        # 빈 값은 설정하지 않은 것으로 보고 기본값을 쓴다
        retries = os.environ.get("MERGE_QUEUE_GH_RETRIES") or "3"
        seconds = os.environ.get("MERGE_QUEUE_GH_RETRY_SECONDS") or "10"
        for name, value in (("MERGE_QUEUE_GH_RETRIES", retries), ("MERGE_QUEUE_GH_RETRY_SECONDS", seconds)):
            if not (value.isascii() and value.isdigit()):
                raise Usage(f"{name} 는 정수다: {value!r}")
        self.gh_retries, self.gh_retry_seconds = int(retries), int(seconds)
        self.drop_stale_copies()

    def drop_stale_copies(self):
        """앞 실행이 KILL 로 끝나 남긴 사본을 지운다. 이름 끝의 pid 가 살아 있으면 다른 큐가 쓰는 중이다."""
        base = Path(self.copy_dir)
        if not base.is_dir():
            return
        for old in sorted(base.glob("merge-queue-pr[0-9]*-[0-9]*")):
            if not old.is_dir():
                continue
            pid = old.name.rsplit("-", 1)[1]
            if pid.isdigit() and pid_alive(int(pid)):
                continue
            self.remove_copy(str(old))
            log(f"끝난 실행(pid {pid})이 남긴 사본을 지웠다: {old}")
        git("worktree", "prune")

    def remove_copy(self, path):
        if git("worktree", "remove", "--force", path).returncode != 0:
            shutil.rmtree(path, ignore_errors=True)

    def drop_copy(self):
        if not self.copy:
            return
        self.remove_copy(self.copy)
        git("worktree", "prune")
        self.copy = ""

    # ---- gh 조회 ----------------------------------------------------------------------------------

    def field(self, n, json_field, jq):
        """PR 하나의 필드. 호출이 실패하면 gh_retries 번까지 다시 부르고, 그래도 실패하면 빈 문자열이다."""
        attempt = 1
        while True:
            done = run(["gh", "pr", "view", str(n), "--json", json_field, "--jq", jq])
            if done.returncode == 0:
                return done.stdout.rstrip("\n")
            if attempt >= self.gh_retries:
                return ""
            attempt += 1
            time.sleep(self.gh_retry_seconds * SLEEP_SCALE)

    def api(self, *args):
        return run(["gh", "api", "--hostname", self.pr.api_host, *args])

    # ---- 겹침 -------------------------------------------------------------------------------------

    def fetch_pr_refs(self):
        p = self.pr
        # 단일 브랜치 clone 이어도 origin/BASE 가 갱신되도록 대상 ref 를 명시한다
        if git("fetch", "-q", "origin", f"+refs/heads/{p.base}:refs/remotes/origin/{p.base}").returncode != 0:
            return False
        if git("cat-file", "-e", f"{p.ph}^{{commit}}").returncode != 0:
            ref = p.branch if not p.cross else f"refs/pull/{p.n}/head"
            git("fetch", "-q", "origin", ref)
        return git("cat-file", "-e", f"{p.ph}^{{commit}}").returncode == 0

    def names(self, *args):
        done = git("diff", "--name-only", *args)
        return None if done.returncode != 0 else [x for x in done.stdout.split("\n") if x]

    def overlap_files(self):
        """PR 이 바꾼 파일 가운데 PR 이 갈라진 뒤 base 에서도 바뀐 파일. 판정하지 못하면 None."""
        p = self.pr
        if not self.fetch_pr_refs():
            return None
        mb = git("merge-base", f"origin/{p.base}", p.ph)
        if mb.returncode != 0:
            return None
        mine, theirs = self.names(mb.stdout.strip(), p.ph), self.names(mb.stdout.strip(), f"origin/{p.base}")
        if mine is None or theirs is None:
            return None
        return sorted(set(mine) & set(theirs))

    def docs_only(self):
        """PR 이 바꾼 파일이 모두 --docs-glob 에 맞으면 True. 바꾼 파일이 없거나 판정하지 못하면 False."""
        p = self.pr
        mb = git("merge-base", f"origin/{p.base}", p.ph)
        if mb.returncode != 0:
            return False
        files = self.names(mb.stdout.strip(), p.ph)
        patterns = [g for g in self.o.docs_glob.split(",") if g]
        return bool(files) and all(any(fnmatch.fnmatchcase(f, g) for g in patterns) for f in files)

    def needs_update(self):
        """--up-to-date-when overlap: 최신화가 필요하면(판정하지 못한 경우 포함) True. 판정 한 줄은 여기서 찍는다."""
        p, o = self.pr, self.o
        if not self.fetch_pr_refs():
            log(f"{p.n} 판정: 갱신 필요(판정 실패: PR HEAD 나 base 를 받지 못했다)")
            return True
        judged_base = git("rev-parse", "-q", "--verify", f"origin/{p.base}").stdout.strip()
        done = subprocess.run(
            [sys.executable, self.overlap_units, "--base", f"origin/{p.base}", "--head", p.ph,
             # 값이 `-` 로 시작해도 옵션으로 읽히지 않도록 `=` 로 붙여 넘긴다
             f"--shared-paths={o.shared_paths}", f"--unit-prefix={o.unit_prefix}", f"--docs-glob={o.docs_glob}",
             *[f"--unit-group={g}" for g in o.unit_groups[1::2]]],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        verdict = done.stdout.rstrip("\n")
        if done.returncode == 0:
            log(f"{p.n} 판정: {verdict}")
            # 판정한 base 를 적어 둔다. 머지 직전에 base 가 움직였는지 다시 본다
            p.judged_base = judged_base
            return False
        if done.returncode == 1:
            log(f"{p.n} 판정: {verdict}")
            return True
        log(f"{p.n} 판정: 갱신 필요(판정 실패: {verdict.replace(chr(10), ' ')})")
        return True

    def verify_merged(self):
        """origin/BASE 에 PR HEAD 를 merge 한 임시 사본에서 --verify-merged 명령을 돌린다. 실패하면 멈춘다."""
        p, o = self.pr, self.o
        try:
            os.makedirs(self.copy_dir, exist_ok=True)
            parent = os.path.realpath(self.copy_dir)
        except OSError:
            stop(f"{p.n} 사본 폴더를 만들지 못했다: {self.copy_dir}")
        bh = git("rev-parse", "-q", "--verify", f"origin/{p.base}")
        if bh.returncode != 0:
            stop(f"{p.n} origin/{p.base} 를 읽지 못했다")
        bh = bh.stdout.strip()
        mb = git("merge-base", bh, p.ph)
        if mb.returncode != 0:
            stop(f"{p.n} 파일 목록의 기준을 읽지 못했다")
        changed = self.names(mb.stdout.strip(), p.ph)
        if changed is None:
            stop(f"{p.n} 바뀐 파일 목록을 읽지 못했다")
        self.copy = f"{parent}/merge-queue-pr{p.n}-{os.getpid()}"
        if git("worktree", "add", "-q", "--detach", self.copy, bh).returncode != 0:
            stop(f"{p.n} 사본을 만들지 못했다: {self.copy}")
        merged = git("-C", self.copy, "-c", "core.hooksPath=/dev/null", "-c", "user.name=merge-queue",
                     "-c", "user.email=merge-queue@localhost", "merge", "-q", "--no-edit", p.ph)
        if merged.returncode != 0:
            stop(f"{p.n} base({p.base}) 와 합치면 충돌한다")
        log(f"{p.n} 합친 사본에서 검사: {o.verify_merged}")
        env = dict(self.pr_env(), TMPDIR=self.real_tmp, GH_HOST=p.api_host, MERGE_COPY=self.copy, PR_HEAD=p.ph,
                   BASE_HEAD=bh, CHANGED_FILES="\n".join(changed), OVERLAP_FILES="\n".join(p.ov))
        code = subprocess.run(["bash", "-c", o.verify_merged, "verify-merged", self.copy], cwd=self.copy,
                              env=env).returncode
        self.drop_copy()
        if code != 0:
            stop(f"{p.n} 합친 사본의 검사 실패(종료 코드 {code})")
        # 검사하는 동안 base 가 움직였으면 검사한 조합과 머지할 조합이 다르다
        if self.remote_base() != bh:
            stop(f"{p.n} 검사하는 동안 base({p.base}) 가 움직였다. 다시 돌린다")
        log(f"{p.n} 합친 사본의 검사 통과")

    def pr_env(self):
        p = self.pr
        return dict(os.environ, PR=p.n, BRANCH=p.branch, OWNER=p.owner, REPO=p.repo)

    # ---- PR 하나 ----------------------------------------------------------------------------------

    def process_pr(self, item):
        o = self.o
        p = self.pr = PR()
        p.n = item.split(":", 1)[0]
        before = item.partition(":")[2] if ":" in item else o.before_all
        n = p.n

        st = self.field(n, "state", ".state")
        if st == "MERGED":
            log(f"{n} 이미 MERGED")
            self.sweep_base = self.sweep_base or self.field(n, "baseRefName", ".baseRefName")
            return
        if st != "OPEN":
            stop(f"{n} state={st or '조회 실패'}")

        # 검사 대상 HEAD 를 체크를 보기 전에 고정한다
        p.ph = self.field(n, "headRefOid", ".headRefOid")
        p.branch = self.field(n, "headRefName", ".headRefName")
        p.cross = self.field(n, "isCrossRepository", ".isCrossRepository")
        if not p.ph:
            stop(f"{n} headRefOid 조회 실패")
        if not p.branch:
            stop(f"{n} headRefName 조회 실패")
        if p.cross not in ("true", "false"):
            stop(f"{n} isCrossRepository 조회 실패")
        p.cross = p.cross == "true"

        url = self.field(n, "url", ".url")
        host_part = url.partition("://")[2]
        p.api_host, _, path_part = host_part.partition("/")
        p.owner, _, rest = path_part.partition("/")
        p.repo = rest.partition("/")[0]
        if not (p.owner and p.repo and p.api_host):
            stop(f"{n} url 조회 실패")
        p.base = self.field(n, "baseRefName", ".baseRefName")
        if not p.base:
            stop(f"{n} baseRefName 조회 실패")
        self.sweep_base = p.base

        req = self.required_checks()
        for name in o.allow_fail.split(","):
            if name and name in req.split(","):
                stop(f"{n} --allow-fail 의 {name} 는 필수 체크다. 필수 체크의 실패는 허용할 수 없다")
        roll = ROLL_NAMES_NO_SKIPPED if o.skipped_missing else ROLL_NAMES
        allowed = (f'(.name // .context) as $nm | ({names_json(o.allow_fail)} | any(. == $nm))')
        self.q = {
            "missing": f"(({names_json(req)}) - {roll})",
            "failed": f"[.statusCheckRollup[] | {FAIL_SEL} | select({allowed} | not)] | length",
            "allowed_failed": f"[.statusCheckRollup[] | {FAIL_SEL} | select({allowed}) | (.name // .context)] "
                              "| unique | .[]",
        }

        p.before_head = None
        p.judgments = 0
        self.ready_to_merge(before)

        # 머지 뒤에는 merge-base 가 바뀌어 문서 PR 인지 다시 판정할 수 없다. 머지 전에 정한다
        kind = "docs" if o.docs_glob and self.docs_only() else "code"
        merge = subprocess.run(["gh", "pr", "merge", n, f"--{o.method}", "--match-head-commit", p.ph],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        out = (merge.stdout or "").rstrip("\n").split("\n")[-1]
        if out:
            print(out, flush=True)
        merged = False
        for _ in range(3):
            nap(5)
            if self.field(n, "state", ".state") == "MERGED":
                merged = True
                break
        if not merged:
            stop(f"{n} 머지 실패")
        log(f"{n} MERGED")
        self.merged.append((n, kind))
        # 머지 뒤 원격 추적 브랜치를 갱신해야 remove-worktree.py 가 워크트리 커밋을 원격에 있다고 본다
        git("fetch", "-q", "origin")
        if not o.keep_branch and not p.cross:
            self.delete_branch()

    def ready_to_merge(self, before):
        """머지 직전까지의 확인을 끝낸다. 바로 머지로 판정한 뒤 base 가 움직였으면 다시 판정한다."""
        o, p = self.o, self.pr
        n = p.n
        while True:
            self.bring_up_to_date()

            f = self.field(n, "statusCheckRollup", self.q["failed"])
            for name in self.field(n, "statusCheckRollup", self.q["allowed_failed"]).split("\n"):
                if name:
                    print(f"경고: {n} 실패를 허용한 체크 {name}", flush=True)
            done = subprocess.run(["bash", "-c", o.threads_cmd], stdout=subprocess.PIPE, text=True,
                                  env=dict(self.pr_env(), GH_HOST=p.api_host))
            if done.returncode != 0:
                stop(f"{n} 스레드 조회 실패")
            t = done.stdout.rstrip("\n")

            m = self.field(n, "mergeable", ".mergeable")
            for _ in range(4):
                if m != "UNKNOWN":
                    break
                nap(20)
                m = self.field(n, "mergeable", ".mergeable")

            log(f"{n} fails={f} threads={t} mergeable={m}")
            if f != "0" or t != "0" or m != "MERGEABLE":
                stop(n)

            p.ov = []
            if o.overlap:
                ov = self.overlap_files()
                if ov is None:
                    stop(f"{n} 겹침 판정 실패(PR HEAD 나 base 를 받지 못했다)")
                p.ov = ov
                listing = " ".join(ov)
                if not o.verify_merged:
                    if ov:
                        stop(f"{n} 겹침: {listing}")
                else:
                    if ov:
                        log(f"{n} 겹침: {listing}")
                    if o.verify_when != "overlap" or ov:
                        if o.verify_when != "always" and o.docs_glob and self.docs_only():
                            log(f"{n} 문서만 바꿨다(--docs-glob). 합친 사본 검사 없이 머지한다")
                        else:
                            self.verify_merged()

            if before and p.before_head != p.ph:
                p.before_head = p.ph
                log(f"{n} 머지 전 명령: {before}")
                if subprocess.run(["bash", "-c", before], env=dict(self.pr_env(), GH_HOST=p.api_host)).returncode != 0:
                    stop(f"{n} 머지 전 명령 실패")

            ph2 = self.field(n, "headRefOid", ".headRefOid")
            if p.ph != ph2:
                stop(f"{n} 검사 뒤 HEAD 가 바뀌었다 checked={p.ph[:8]} now={ph2[:8]}")
            if not p.cross:
                if git("fetch", "-q", "origin", p.branch).returncode != 0:
                    stop(f"{n} 원격 브랜치 fetch 실패")
                rh = git("rev-parse", "-q", "--verify", f"origin/{p.branch}").stdout.strip()
                if p.ph != rh:
                    stop(f"{n} head 불일치 pr={p.ph[:8]} remote={rh[:8]}")
            if not p.judged_base:
                return
            if self.remote_base() == p.judged_base:
                return
            log(f"{n} 판정한 뒤 base({p.base}) 가 움직였다. 새로 들어온 변경으로 다시 판정한다")

    def remote_base(self):
        """원격 base 의 지금 SHA. 조회하지 못하면 base 가 움직인 것으로 읽지 않고 멈춘다."""
        p = self.pr
        done = git("ls-remote", "origin", f"refs/heads/{p.base}")
        sha = done.stdout.split("\t")[0].strip() if done.returncode == 0 else ""
        if not sha:
            stop(f"{p.n} base 조회 실패")
        return sha

    def required_checks(self):
        o, p = self.o, self.pr
        req = o.required
        if not req:
            done = self.api(f"repos/{p.owner}/{p.repo}/rules/branches/{p.base}", "--jq", RULES_JQ)
            if done.returncode == 0:
                req = done.stdout.rstrip("\n")
            elif "HTTP 403" in done.stderr and "Upgrade to GitHub Pro" in done.stderr:
                # 무료 플랜의 비공개 저장소는 규칙 API 를 읽을 수 없다. 필수 체크 목록이 없는 것으로 다룬다
                log(f"{p.n} 경고: 이 플랜은 저장소 규칙을 읽을 수 없다(HTTP 403, 플랜 제한). 필수 체크 목록을 비어 있는 것으로 본다")
                req = ""
            else:
                stop(f"{p.n} 필수 체크 규칙 조회 실패. --required 로 준다")
        if not req:
            if o.up_to_date:
                stop(f"{p.n} 필수 체크 목록이 비어 있어 --require-up-to-date 를 쓸 수 없다. --required 로 준다")
            if o.update_docs:
                stop(f"{p.n} 문서 PR 갱신에는 필수 체크 목록이 필요하다. --required 로 준다")
            log(f"{p.n} 필수 체크 목록이 비어 있다. 지금 있는 체크만 기다린다")
        return req

    def wait_checks(self):
        n, q = self.pr.n, self.q
        limit = int(self.o.check_timeout) * 60
        waited = 0
        while True:
            f = self.field(n, "statusCheckRollup", q["failed"])
            if (f or "0") != "0":
                stop(f"{n} 실패한 체크 {f} 개")
            p = self.field(n, "statusCheckRollup", PENDING)
            m = self.field(n, "statusCheckRollup", f"{q['missing']} | length")
            if not p or not m:
                stop(f"{n} 체크 조회 실패")
            if p == "0" and m == "0":
                break
            if waited >= limit:
                names = self.field(n, "statusCheckRollup", f'{q["missing"]} | join(",")')
                stop(f"{n} 체크 대기 {self.o.check_timeout}분 초과(진행 중 {p}, 나타나지 않은 필수 체크 {names})")
            nap(30)
            waited += 30
        # 체크가 끝난 직후에 새 체크가 붙는 경우가 있어 잠시 뒤 다시 본다
        nap(15)
        p = self.field(n, "statusCheckRollup", PENDING)
        m = self.field(n, "statusCheckRollup", f"{q['missing']} | length")
        if not (p == "0" and m == "0"):
            stop(f"{n} 새로 붙은 체크가 아직 돈다(진행 중 {p or '?'}, 미등장 {m or '?'}). 다시 돌린다")

    def bring_up_to_date(self):
        """필수 체크를 기다리고, 켜져 있으면 base 최신화와 문서 PR 갱신을 한다."""
        o, p = self.o, self.pr
        n = p.n
        rounds = 0
        p.judged_base = None
        while True:
            p.judged_base = None
            self.wait_checks()
            update_docs = False
            if o.update_docs:
                ov = self.overlap_files()
                if ov is None:
                    stop(f"{n} 문서 PR 의 겹침 판정 실패")
                if ov and self.docs_only():
                    ms = self.field(n, "mergeStateStatus", ".mergeStateStatus")
                    if ms != "CLEAN":
                        stop(f"{n} 문서 PR 을 갱신하려면 GitHub CLEAN 이 필요하다(현재 {ms})")
                    update_docs = True
            if not (o.up_to_date or update_docs):
                return
            # 비교보다 먼저 읽는다. 그 사이 base 가 움직였으면 나중에 다른 값으로 보여 다시 판정한다
            base_at_compare = self.remote_base() if o.up_to_date_when == "overlap" else None
            behind = self.api(f"repos/{p.owner}/{p.repo}/compare/{p.base}...{p.ph}", "--jq", ".behind_by")
            behind = behind.stdout.rstrip("\n") if behind.returncode == 0 else ""
            if not behind.isdigit():
                stop(f"{n} base 와 비교 실패")
            if behind == "0":
                # 최신이라 판정은 거치지 않는다. 이 뒤(스레드 조회, mergeable 재시도, 머지 전 명령)에 base 가
                # 움직이면 ready_to_merge 가 다시 판정하도록 지금 base 를 적어 둔다
                if o.up_to_date_when == "overlap":
                    p.judged_base = base_at_compare
                return
            # 문서 PR 갱신(update_docs)은 겹침을 이미 확인한 뒤의 결정이라 판정을 거치지 않는다
            if o.up_to_date_when == "overlap" and not update_docs:
                # 갱신하고 CI 를 기다리는 사이 base 가 또 움직였을 수 있어, 이 자리에 올 때마다 새로 판정한다
                p.judgments += 1
                if p.judgments > REJUDGE_LIMIT + 1:
                    stop(f"{n} 다시 판정을 {REJUDGE_LIMIT}번 했는데도 base({p.base}) 가 계속 움직인다")
                if not self.needs_update():
                    return
            rounds += 1
            if rounds > (REJUDGE_LIMIT + 1 if o.up_to_date_when == "overlap" else 3):
                stop(f"{n} base 를 {rounds - 1}번 merge 해도 최신이 아니다. base 가 계속 움직인다")
            log(f"{n} base({p.base}) 보다 {behind} 커밋 뒤처졌다. update-branch 후 체크를 다시 기다린다")
            updated = self.api("-X", "PUT", f"repos/{p.owner}/{p.repo}/pulls/{n}/update-branch",
                               "-f", f"expected_head_sha={p.ph}")
            if updated.returncode != 0:
                stop(f"{n} update-branch 실패(충돌 가능)")
            # update-branch 는 비동기라 PR HEAD 가 바뀔 때까지 기다린다
            new = ""
            for _ in range(12):
                nap(5)
                new = self.field(n, "headRefOid", ".headRefOid")
                if new and new != p.ph:
                    break
            if not new or new == p.ph:
                stop(f"{n} update-branch 뒤 HEAD 가 바뀌지 않았다")
            p.ph = new

    def delete_branch(self):
        p = self.pr
        if p.branch.startswith("release/"):
            log(f"{p.n} release 브랜치는 남긴다 {p.branch}")
            return
        based = run(["gh", "pr", "list", "--state", "open", "--base", p.branch, "--json", "number", "--jq", "length"])
        count = based.stdout.rstrip("\n") if based.returncode == 0 else ""
        if (count or "1") != "0":
            log(f"{p.n} 다른 열린 PR 의 base 이거나 조회 실패라 남긴다 {p.branch}")
            return
        if git("push", "-q", "origin", "--delete", p.branch).returncode == 0:
            log(f"{p.n} 원격 브랜치 삭제 {p.branch}")
        git("fetch", "-q", "--prune", "origin")

    # ---- 큐 ---------------------------------------------------------------------------------------

    def run_after_merged(self):
        """이번 실행에서 머지한 PR 이 있으면 --after-merged 를 한 번 돌린다."""
        if not (self.o.after_merged and self.merged):
            return
        merged_prs = " ".join(n for n, _ in self.merged)
        code_prs = " ".join(n for n, kind in self.merged if kind == "code")
        log(f"머지 뒤 명령(머지 {merged_prs}, 코드 {code_prs or '없음'}): {self.o.after_merged}")
        code = subprocess.run(["bash", "-c", self.o.after_merged],
                              env=dict(os.environ, MERGED_PRS=merged_prs, CODE_PRS=code_prs)).returncode
        self.merged = []
        if code != 0:
            print(f"AFTER-MERGED-FAILED {code}", flush=True)
            self.after_failed = True

    def run(self):
        o = self.o
        for item in o.items:
            try:
                self.process_pr(item)
            except Stop as exc:
                print(f"STOP {exc}", flush=True)
                code = 1
            except Exception:  # noqa: BLE001 예상 못 한 오류도 그 PR 의 보류로 다룬다
                traceback.print_exc()
                print(f"STOP {item.split(':', 1)[0]} 예상 못 한 오류", flush=True)
                code = 1
            else:
                code = 0
            finally:
                self.drop_copy()
            if code == 0:
                continue
            if not o.continue_on_hold:
                # 보류로 멈춰도 앞에서 머지한 PR 의 머지 뒤 명령은 돌린다
                self.run_after_merged()
                return 1
            self.held.append(item.split(":", 1)[0])
            log(f"{item.split(':', 1)[0]} 보류. 다음 PR 로 간다")
        print(f"QUEUE-HELD {' '.join(self.held)}" if self.held else "QUEUE-DONE", flush=True)
        self.run_after_merged()
        if o.sweep:
            sweep = os.environ.get("CLEANUP_SWEEP", str(HERE / "cleanup-sweep.py"))
            done = subprocess.run([sys.executable, sweep, "--repo", os.getcwd(), "--base", self.sweep_base or "main",
                                   "--apply", *o.sweep_args])
            if done.returncode != 0:
                print("경고: cleanup-sweep.py 가 실패했다. 머지 결과는 그대로다")
        if self.held:
            return 1
        return 3 if self.after_failed else 0


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def main(argv=None):
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        opts = parse_args(sys.argv[1:] if argv is None else argv)
        queue = Queue(opts)
        queue.setup()
    except Usage as exc:
        if str(exc):
            print(str(exc), file=sys.stderr)
        else:
            print(__doc__)
        return 2
    try:
        return queue.run()
    finally:
        queue.drop_copy()


if __name__ == "__main__":
    sys.exit(main())
