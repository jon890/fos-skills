#!/usr/bin/env python3
"""덱 HTML 한 파일의 구조를 검사한다.

눈으로 훑어서는 놓치는 것만 본다. 장 수와 주석 번호, 활성 장 개수,
JS 문법, 이전에 남은 하드코딩 값, 노트 누락, 금지어다.
금지어의 단일 소스는 ~/.claude/rules/korean-style.md 의 매핑 표다.
세로 넘침은 렌더링해야 알 수 있으므로 --browser 로 따로 잰다.

종료 코드: 0 통과, 1 위반, 2 검사기가 돌지 못함
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

# 발표 고유 금지어. 전역 매핑 표에 없고 덱에서만 문제가 되는 것만 둔다.
DECK_BANNED = [
    "굳혔다", "굳혀", "띄울 곳", "확인할 방법이 없",
    "당연히 된다", "정직하게", "솔직히 말하면",
]

# 전역 금지어의 단일 소스는 ~/.claude/rules/korean-style.md 의 "외래어 매핑 표" 다.
# 사본을 두지 않는다. 사본은 원본과 갈라지고, 실제로 갈라졌다.
#   - 「되돌린 사례」 표의 `정점` 을 금지어로 잘못 옮겨 `수정점검`·`그래프의 정점` 이 걸렸다.
#   - 매핑 표에 있는 `ingest`·`ramp`·`강등` 은 빠져 있었다.
RULES = os.path.expanduser(
    os.environ.get("KOREAN_STYLE_RULES", "~/.claude/rules/korean-style.md")
)

# 금지어를 부분 문자열로 품고 있지만 그 자체로는 정당한 합성어.
# 전역 검사기의 COMPOUND_ALLOW 와 같은 목록을 같은 이유로 둔다.
COMPOUND_ALLOW = ["게이트웨이"]


def global_banned():
    """매핑 표 첫 열에서 금지어를 뽑는다. 전역 검사기의 추출 규칙과 같다.

    "클램프 / clamp"     -> 클램프, clamp   (슬래시는 동의어 구분)
    "게이트 (gate)"      -> 게이트, gate    (괄호 안 영어 원어도 금지어)
    "폭주 (CPU 폭주 등)" -> 폭주            (괄호 안이 한국어면 용례 설명이라 제외)

    규칙 파일이 없는 환경(팀원 등)에서는 빈 목록을 돌려주고 조용히 건너뛴다.
    """
    if not os.path.isfile(RULES):
        return None
    terms, inside = set(), False
    for line in open(RULES, encoding="utf-8"):
        if line.startswith("## 외래어 매핑 표"):
            inside = True
            continue
        if inside and line.startswith("## "):
            break
        if not inside or not line.startswith("| "):
            continue
        if re.match(r"^\|\s*-", line) or line.startswith("| 금지 "):
            continue
        col = line.split("|")[1]
        for inner in re.findall(r"\(([^)]*)\)", col):
            if re.fullmatch(r"[A-Za-z][A-Za-z -]*", inner):
                terms.add(inner.strip())
        col = re.sub(r"\([^)]*\)", " ", col)
        for part in col.split("/"):
            if part.strip():
                terms.add(part.strip())
    return terms


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    use_browser = "--browser" in sys.argv
    if not args:
        print("사용법: check-deck.py <deck.html> [--browser]", file=sys.stderr)
        return 2
    path = args[0]
    if not os.path.isfile(path):
        print(f"파일이 없다: {path}", file=sys.stderr)
        return 2
    src = open(path, encoding="utf-8").read()

    bad = []
    note = []

    # 속성 순서를 고정하지 않는다. data-title 이 먼저 오면 장이 0개로 세어져
    # "장 주석 개수가 다르다" 라는 엉뚱한 지적으로 나온다.
    SECTION_TAG = re.compile(r'<section\b[^>]*\bclass="slide[^"]*"[^>]*>')
    TITLE_ATTR = re.compile(r'data-title="([^"]*)"')
    tags = SECTION_TAG.findall(src)
    sections = [m.group(1) for t in tags for m in [TITLE_ATTR.search(t)] if m]
    if len(tags) != len(sections):
        bad.append(f"data-title 이 없는 장이 {len(tags) - len(sections)}개다")
    comments = re.findall(r"^<!-- (\d{2}) -->", src, re.M)
    note.append(f"장 {len(sections)}개")

    if len(comments) != len(sections):
        bad.append(f"장 주석 {len(comments)}개와 section {len(sections)}개가 다르다")
    else:
        want = [f"{n + 1:02d}" for n in range(len(comments))]
        if comments != want:
            first = next(i for i, (a, b) in enumerate(zip(comments, want)) if a != b)
            bad.append(f"장 주석 번호가 어긋난다: {first + 1}번째가 <!-- {comments[first]} -->")

    n_active = len(re.findall(r'class="slide[^"]*\bactive\b', src))
    if n_active != 1:
        bad.append(f"active 장이 {n_active}개다. 정확히 1개여야 한다")

    empty_titles = [i + 1 for i, t in enumerate(sections) if not t.strip()]
    if empty_titles:
        bad.append(f"data-title 이 빈 장: {empty_titles}")

    n_note = src.count('<template class="note">')
    if n_note != len(sections):
        bad.append(f"노트가 {n_note}개, 장이 {len(sections)}개다. 장마다 노트가 있어야 한다")

    # 이전 버전에서 남은 하드코딩 값. JS 가 매번 채우므로 파일에 값이 남으면 낡은 것이다.
    for el_id, label in (("pageno", "쪽 표시"), ("ovgrid", "개요 버튼"), ("sv-body", "스크립트 패널")):
        m = re.search(r'id="' + el_id + r'"[^>]*>(.*?)</', src, re.S)
        if m and m.group(1).strip():
            bad.append(f"{label}({el_id}) 에 옛 내용이 박혀 있다: {m.group(1)[:40]!r}")

    scripts = re.findall(r"<script>(.*?)</script>", src, re.S)
    if len(scripts) != 1:
        bad.append(f"<script> 블록이 {len(scripts)}개다. 1개여야 한다")
    elif shutil.which("node"):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(scripts[0])
            tmp = f.name
        try:
            r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
            if r.returncode != 0:
                bad.append("JS 문법 오류: " + r.stderr.strip().splitlines()[0])
        finally:
            os.unlink(tmp)
    else:
        note.append("node 가 없어 JS 문법을 못 봤다")

    # 산문만 남긴다. 전역 검사기가 코드 블록과 코드 스팬을 빼는 것과 같은 이유다.
    # style 과 script 는 코드라 CSS 의 baseline·clamp 이 금지어로 걸린다 (실측).
    prose = re.sub(r"<style\b[^>]*>.*?</style>", " ", src, flags=re.S | re.I)
    prose = re.sub(r"<script\b[^>]*>.*?</script>", " ", prose, flags=re.S | re.I)
    prose = re.sub(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]+", "", prose)
    for allow in COMPOUND_ALLOW:
        prose = prose.replace(allow, " ")
    terms = global_banned()
    if terms is None:
        note.append(f"{RULES} 가 없어 전역 금지어를 못 봤다")
        terms = set()
    elif not terms:
        print(f"매핑 표에서 금지어를 추출하지 못했다: {RULES}", file=sys.stderr)
        return 2
    for w in sorted(terms) + DECK_BANNED:
        if w in prose:
            bad.append(f"금지어: {w}")

    for line in note:
        print(f"· {line}")
    if use_browser:
        bad += browser_overflow(path)
    if bad:
        print()
        for line in bad:
            print(f"✗ {line}")
        return 1
    print("통과")
    return 0


def browser_overflow(path):
    """세로 넘침을 잰다.

    드라이버가 아예 없는 것과 있는데 실패한 것을 가른다.
    없으면 건너뛰고, 실패는 위반으로 낸다. `--browser` 통과 여부가 판정 기준인데
    실패를 통과로 끝내면 종료 코드로 둘을 가를 수 없다.
    """
    driver = os.path.expanduser("~/.claude/scripts/browser-driver")
    if not os.path.exists(driver):
        print("· browser-driver 가 없어 넘침을 못 봤다")
        return []
    url = "file://" + os.path.abspath(path)
    handle = None
    try:
        page = subprocess.run([driver, "open", url, "20000"], capture_output=True, text=True, timeout=90)
        lines = page.stdout.strip().splitlines()
        if page.returncode != 0 or not lines:
            return ["브라우저 검사: 탭을 열지 못했다 " + (page.stderr.strip()[:80] or "")]
        handle = lines[-1]
        js = (
            'var r=[];var ss=document.querySelectorAll("section.slide");'
            "for(var k=0;k<ss.length;k++){var s=ss[k];var w=s.classList.contains(\"active\");"
            's.style.display="flex";var o=s.scrollHeight-s.clientHeight;'
            'if(o>2)r.push((k+1)+" "+s.dataset.title+" +"+o+"px");'
            'if(!w)s.style.display="";}r.join(" | ")'
        )
        out = subprocess.run([driver, "js", handle, js], capture_output=True, text=True, timeout=90)
        if out.returncode != 0:
            return ["브라우저 검사: 측정에 실패했다 " + (out.stderr.strip()[:80] or "")]
        found = out.stdout.strip()
        if found:
            return ["세로 넘침: " + found]
        print("· 세로 넘침 없음")
        return []
    except Exception as e:
        return [f"브라우저 검사가 돌지 못했다: {e}"]
    finally:
        # 예외로 빠져나가도 탭을 남기지 않는다.
        if handle:
            subprocess.run([driver, "close", handle], capture_output=True, text=True, timeout=30)


if __name__ == "__main__":
    sys.exit(main())
