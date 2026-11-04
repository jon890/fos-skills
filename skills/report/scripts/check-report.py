#!/usr/bin/env python3
r"""report 스킬이 만든 HTML 보고서 한 파일이 깨지지 않았는지 검사한다.

브라우저는 깨진 HTML 도 말없이 그려 주므로 눈으로 봐서는 놓치는 것만 본다.

사용법:
    check-report.py <파일.html>          검사한다
    check-report.py --text <파일.html>   보이는 글만 한 덩어리에 한 줄씩 낸다
    check-report.py --korean <파일.html> 보이는 글을 korean-check 의 check.sh 로 검사한다

korean-check 의 검사기는 .md 만 받고, HTML 을 그대로 넘기면 태그로 시작하는 줄을 건너뛰어 금지어를 놓친다.
그래서 --korean 은 보이는 글을 임시 .md 로 써서 넘긴다. 줄 머리의 <, |, # 는 \ 를 붙여
표 행이나 제목으로 읽혀 검사에서 빠지지 않게 한다.
korean-check 는 KOREAN_CHECK 환경 변수, 이 스킬의 형제 디렉터리, ~/.claude/skills/korean-check 순서로 찾는다.
플러그인 설치본은 저장소 전체를 복사하므로 형제 디렉터리에 있다.

검사 항목 (위반 줄 형식: <파일>:<줄>: <종류>: <설명>)
    tag       닫히지 않은 태그, 짝이 맞지 않는 끝 태그, <html> 이 없는 파일. 끝 태그를 생략할 수 있는 요소도 닫아야 한다
    external  밖에서 불러오는 script, CSS, 글꼴, 이미지 같은 자원. data: 와 # 만 허용한다.
              CSS 주석 안의 url() 은 보지 않는다. 상대 경로도 다른 파일에 기대므로 막는다. 본문의 <a href="https://..."> 는 허용한다
    ref       href="#x" 링크가 가리키는 id 가 없다
    source    id 가 src- 로 시작하는 출처 항목을 가리키는 링크가 없다
    id        같은 id 가 두 번 나온다
    name      파일 이름이 영문 소문자, 숫자와 - 로 된 슬러그가 아니다

종료 코드: 0 통과, 1 위반, 2 검사기가 돌지 못함 (인자가 틀렸거나 파일이 없음, --korean 에서 korean-check 를 못 찾음)
"""
import html.parser
import os
import pathlib
import re
import subprocess
import sys
import tempfile

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
}
# 태그별로 불러오는 자원을 가리키는 속성
RESOURCE_ATTRS = {
    "script": ("src",),
    "link": ("href",),
    "img": ("src", "srcset"),
    "iframe": ("src",),
    "source": ("src", "srcset"),
    "video": ("src", "poster"),
    "audio": ("src",),
    "embed": ("src",),
    "object": ("data",),
    "track": ("src",),
    "image": ("href", "xlink:href"),
    "use": ("href", "xlink:href"),
    "base": ("href",),
    "body": ("background",),
    "table": ("background",),
    "td": ("background",),
    "th": ("background",),
}
CSS_URL = re.compile(r"""url\(\s*['"]?([^'")\s]*)""", re.I)
CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?['"]?([^'")\s;]*)""", re.I)
CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*\.html$")
# --text 에서 줄을 나누는 요소
BLOCK = {
    "address", "article", "aside", "blockquote", "caption", "dd", "details", "div",
    "dl", "dt", "figcaption", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "li", "main", "nav", "ol", "p", "section", "summary", "table", "td", "th", "tr",
    "ul", "br",
}
HIDDEN = {"script", "style", "code", "pre", "template"}


def allowed(url):
    url = url.strip()
    return url == "" or url.startswith(("data:", "#"))


class Checker(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.problems = []
        self.ids = {}
        self.links = []
        self.in_style = False

    def add(self, kind, msg, line=None):
        self.problems.append((line or self.getpos()[0], kind, msg))

    def check_css(self, css, line):
        css = CSS_COMMENT.sub("", css)
        for pattern in (CSS_URL, CSS_IMPORT):
            for m in pattern.finditer(css):
                if not allowed(m.group(1)):
                    self.add("external", f"CSS 가 밖의 자원을 불러온다: {m.group(1)}", line)

    def handle_starttag(self, tag, attrs):
        self._attrs(tag, attrs)
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))
        if tag == "style":
            self.in_style = True

    def handle_startendtag(self, tag, attrs):
        self._attrs(tag, attrs)

    def _attrs(self, tag, attrs):
        line = self.getpos()[0]
        a = {k: (v or "") for k, v in attrs}
        names = RESOURCE_ATTRS.get(tag, ())
        if tag == "input" and a.get("type", "").lower() == "image":
            names = ("src",)
        if tag == "meta" and a.get("http-equiv", "").lower() == "refresh" and "url=" in a.get("content", "").lower():
            self.add("external", "<meta http-equiv=refresh> 가 다른 주소로 넘긴다", line)
        for name in names:
            if name not in a:
                continue
            urls = [part.strip().split(" ")[0] for part in a[name].split(",")] if name == "srcset" else [a[name]]
            for url in urls:
                if not allowed(url):
                    self.add("external", f"<{tag} {name}> 가 밖의 자원을 불러온다: {url}", line)
        if "style" in a:
            self.check_css(a["style"], line)
        if "id" in a:
            if a["id"] in self.ids:
                self.add("id", f"id \"{a['id']}\" 가 {self.ids[a['id']]}줄에도 있다", line)
            else:
                self.ids[a["id"]] = line
        if tag == "a" and a.get("href", "").startswith("#") and len(a["href"]) > 1:
            self.links.append((a["href"][1:], line))

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        if tag == "style":
            self.in_style = False
        if tag in VOID:
            return
        if not self.stack:
            self.add("tag", f"여는 태그 없이 </{tag}> 가 나온다", line)
            return
        if self.stack[-1][0] == tag:
            self.stack.pop()
            return
        if any(t == tag for t, _ in self.stack):
            # 사이에 닫히지 않은 태그를 모두 보고하고 짝을 맞춘다
            while self.stack[-1][0] != tag:
                t, opened = self.stack.pop()
                self.add("tag", f"<{t}> 가 닫히지 않고 </{tag}> 를 만났다", opened)
            self.stack.pop()
        else:
            self.add("tag", f"여는 태그 없이 </{tag}> 가 나온다", line)

    def handle_data(self, data):
        if self.in_style:
            self.check_css(data, self.getpos()[0])

    def finish(self):
        for t, opened in self.stack:
            self.add("tag", f"<{t}> 가 닫히지 않았다", opened)
        targets = {target for target, _ in self.links}
        for target, line in self.links:
            if target not in self.ids:
                self.add("ref", f"#{target} 를 가리키지만 그 id 가 없다", line)
        for ident, line in self.ids.items():
            if ident.startswith("src-") and ident not in targets:
                self.add("source", f"출처 {ident} 를 가리키는 본문 링크가 없다", line)
        return sorted(self.problems)


class TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.lines = []
        self.buf = []

    def flush(self):
        text = " ".join("".join(self.buf).split())
        if text:
            self.lines.append(text)
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in HIDDEN:
            self.hidden += 1
        elif tag in BLOCK:
            self.flush()

    def handle_endtag(self, tag):
        if tag in HIDDEN:
            self.hidden = max(0, self.hidden - 1)
        elif tag in BLOCK:
            self.flush()

    def handle_data(self, data):
        if not self.hidden:
            self.buf.append(data)


def check(path):
    checker = Checker()
    body = path.read_text(encoding="utf-8")
    checker.feed(body)
    checker.close()
    problems = checker.finish()
    if "<html" not in body.lower():
        problems.insert(0, (1, "tag", "<html> 요소가 없다. 틀을 복사해 채운 보고서가 아니다"))
    if not SLUG.match(path.name):
        problems.insert(0, (1, "name", f"파일 이름 {path.name} 이 슬러그(영문 소문자, 숫자, -)가 아니다"))
    return problems


def extract_text(path):
    ex = TextExtractor()
    ex.feed(path.read_text(encoding="utf-8"))
    ex.close()
    ex.flush()
    return ex.lines


def md_safe(line):
    """줄 머리가 마크다운의 표 행, 제목, HTML 로 읽혀 korean-check 가 건너뛰지 않게 한다."""
    return "\\" + line if line[:1] in "<|#" else line


def find_korean_check():
    here = pathlib.Path(__file__).resolve().parent.parent
    for base in (os.environ.get("KOREAN_CHECK", ""), str(here.parent / "korean-check"),
                 str(here.parent.parent / "export-only-skills" / "korean-check"),
                 os.path.expanduser("~/.claude/skills/korean-check")):
        if base and (pathlib.Path(base) / "scripts" / "check.sh").is_file():
            return pathlib.Path(base) / "scripts" / "check.sh"
    return None


def korean(path):
    check_sh = find_korean_check()
    if not check_sh:
        print("check-report: korean-check 를 찾지 못했다. KOREAN_CHECK 로 그 스킬 경로를 준다", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        md = pathlib.Path(tmp) / (path.stem + ".md")
        md.write_text("\n".join(md_safe(line) for line in extract_text(path)) + "\n", encoding="utf-8")
        result = subprocess.run(["bash", str(check_sh), str(md)], capture_output=True, text=True, check=False)
    # 임시 파일 이름 대신 보고서 이름으로 알린다. 줄 번호는 --text 출력의 줄이다
    sys.stdout.write(result.stdout.replace(str(md), f"{path} (--text 줄)"))
    sys.stderr.write(result.stderr)
    return result.returncode


def main(argv):
    mode = argv[0] if argv and argv[0] in ("--text", "--korean") else ""
    args = argv[1:] if mode else argv
    if len(args) != 1 or args[0].startswith("-"):
        print(next(b for b in __doc__.split("\n\n") if b.startswith("사용법")), file=sys.stderr)
        return 2
    path = pathlib.Path(args[0])
    if not path.is_file():
        print(f"check-report: 파일이 없다: {path}", file=sys.stderr)
        return 2
    if mode == "--text":
        for line in extract_text(path):
            print(md_safe(line))
        return 0
    if mode == "--korean":
        return korean(path)
    problems = check(path)
    for line, kind, msg in problems:
        print(f"{path}:{line}: {kind}: {msg}")
    if problems:
        print(f"위반 {len(problems)}건")
        return 1
    print(f"통과: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
