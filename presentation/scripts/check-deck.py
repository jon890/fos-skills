#!/usr/bin/env python3
"""덱 HTML 한 파일의 구조를 검사한다.

눈으로 훑어서는 놓치는 것만 본다. 장 수와 주석 번호, 활성 장 개수,
JS 문법, 이전 판에서 남은 하드코딩 값, 노트 누락, 금지어다.
세로 넘침은 렌더링해야 알 수 있으므로 --browser 로 따로 잰다.

종료 코드: 0 통과, 1 위반, 2 검사기가 돌지 못함
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

BANNED = [
    "매트릭스", "트리아지", "베이스라인", "스파이크", "게이트",
    "silent failure", "카나리", "클램프", "폭주", "오살", "외과적",
    "단일 진실원", "정점", "되돌이", "굳혔다", "굳혀",
    "띄울 곳", "확인할 방법이 없", "당연히 된다", "정직하게", "솔직히 말하면",
]


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

    sections = re.findall(r'<section class="slide[^"]*" data-title="([^"]*)"', src)
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
        note.append(f"노트 {n_note}개 — 장 {len(sections)}개와 다르다")

    # 이전 판에서 남은 하드코딩 값. JS 가 매번 채우므로 파일에 값이 남으면 낡은 것이다.
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

    prose = re.sub(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]+", "", src)
    for w in BANNED:
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
    driver = os.path.expanduser("~/.claude/scripts/browser-driver")
    if not os.path.exists(driver):
        print("· browser-driver 가 없어 넘침을 못 봤다")
        return []
    url = "file://" + os.path.abspath(path)
    try:
        page = subprocess.run([driver, "open", url, "20000"], capture_output=True, text=True, timeout=90)
        handle = page.stdout.strip().splitlines()[-1]
        js = (
            'var r=[];var ss=document.querySelectorAll("section.slide");'
            "for(var k=0;k<ss.length;k++){var s=ss[k];var w=s.classList.contains(\"active\");"
            's.style.display="flex";var o=s.scrollHeight-s.clientHeight;'
            'if(o>2)r.push((k+1)+" "+s.dataset.title+" +"+o+"px");'
            'if(!w)s.style.display="";}r.join(" | ")'
        )
        out = subprocess.run([driver, "js", handle, js], capture_output=True, text=True, timeout=90)
        subprocess.run([driver, "close", handle], capture_output=True, text=True, timeout=30)
        found = out.stdout.strip()
        if found:
            return ["세로 넘침: " + found]
        print("· 세로 넘침 없음")
    except Exception as e:
        print(f"· 브라우저 검사가 돌지 못했다: {e}")
    return []


if __name__ == "__main__":
    sys.exit(main())
