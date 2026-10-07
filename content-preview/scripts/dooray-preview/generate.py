#!/usr/bin/env python3
"""Dooray 본문 미리보기 HTML 생성기.

Dooray 업무·댓글은 TOAST UI Editor 로 렌더링하므로, 같은 viewer CSS/JS (uicdn.toast.com)
를 쓰는 템플릿에 markdown 을 흘려 넣으면 실제 등록 화면과 거의 동일한 미리보기가 된다.

업무·댓글·메신저는 --mode 로 고른다. 메신저는 확인된 멘션과 HTTPS 주소만 렌더한다.

사용 예 (업무 본문):
    python3 scripts/dooray-preview/generate.py \
        --project "<프로젝트명>" \
        --title "<업무 제목>" \
        --tag "<태그>" --tag "<태그>" \
        --meta "담당자:<이름>" --meta "참조:<그룹>" \
        --md-file "$PREVIEW_DIR/body.md" \
        --out "$PREVIEW_DIR/preview.html"
    scripts/show-preview.sh "$PREVIEW_DIR/preview.html"

사용 예 (댓글):
    python3 scripts/dooray-preview/generate.py \
        --mode comment --author "<작성자>" \
        --title "<미리보기 제목>" \
        --md-file "$PREVIEW_DIR/body.md" \
        --out "$PREVIEW_DIR/preview.html"

주의:
- markdown 본문에 '</script>' 문자열이 있으면 안 된다 (text/plain 블록이 깨짐).
- CDN 로드라 오프라인에서는 스타일이 빠진 채 보인다.
"""

import argparse
import html
import re
import sys
from pathlib import Path

TEMPLATE = Path(__file__).parent / "template.html"

LINK_WARNING = "경고: Dooray 메신저의 업무·위키 dooray:// 마크다운 링크는 https 주소로 바꾸세요."
UNSUPPORTED_LINK = re.compile(r'dooray://[^\s)>]*/(?:tasks|pages)/', re.IGNORECASE)
MENTION = r'\[@[^\]\n]+\]\(dooray://[^\s)]+/members/[^\s)]+\s+"member"\)'
MESSENGER_TOKEN = re.compile(
    MENTION +
    r'|\[[^\]\n]*\]\([^\n)]*\)'
    r'|https://[^\s<>\[\]"\x27]+'
)


def render_messenger(md: str) -> str:
    """확인된 멘션과 HTTPS 주소만 렌더하고 나머지는 원문으로 둔다."""
    parts = []
    end = 0
    for match in MESSENGER_TOKEN.finditer(md):
        parts.append(html.escape(md[end:match.start()]))
        token = match.group()
        if re.fullmatch(MENTION, token):
            label, target = token[1:].split("](", 1)
            url = target.split()[0]
            parts.append(f'<a class="dooray-mention" href="{html.escape(url, quote=True)}">{html.escape(label)}</a>')
        elif token.startswith("https://"):
            # 문장 끝의 구두점은 링크에 넣지 않는다. URL 내부 괄호는 보존한다.
            url = token.rstrip(".,!?;:，。")
            while url.endswith(")") and url.count(")") > url.count("("):
                url = url[:-1]
            escaped = html.escape(url, quote=True)
            parts.append(f'<a href="{escaped}">{escaped}</a>')
            parts.append(html.escape(token[len(url):]))
        else:
            parts.append(html.escape(token))
        end = match.end()
    parts.append(html.escape(md[end:]))
    return '<div class="dooray-messenger-text">' + "".join(parts) + "</div>"


def main() -> int:
    ap = argparse.ArgumentParser(description="Dooray 본문 미리보기 HTML 생성")
    ap.add_argument("--title", required=True, help="업무 제목, 댓글 미리보기 제목 또는 메신저 대화방 이름")
    ap.add_argument("--mode", choices=("task", "comment", "messenger"), default="task",
                    help="task 는 업무, comment 는 댓글, messenger 는 대화방 메시지")
    ap.add_argument("--author", default="작성자", help="댓글 작성자 또는 메신저 보내는 사람")
    ap.add_argument("--strict", action="store_true", help="messenger 모드에서만 적용: 링크 경고가 있으면 HTML 생성 후 종료 코드 1")
    ap.add_argument("--project", default="", help="프로젝트명 (헤더 표시용). 없으면 그 줄을 그린다")
    ap.add_argument("--tag", action="append", default=[], help="태그 (반복 지정)")
    ap.add_argument("--meta", action="append", default=[],
                    help="메타 정보 '라벨:값' (반복 지정, 예: 담당자:<이름>)")
    ap.add_argument("--md-file", required=True, help="본문 markdown 파일 경로 ('-' 는 stdin)")
    ap.add_argument("--out", required=True, help="출력 HTML 경로")
    args = ap.parse_args()

    if args.md_file == "-":
        md = sys.stdin.read()
    else:
        md = Path(args.md_file).read_text(encoding="utf-8")

    if args.mode != "messenger" and "</script>" in md:
        print("오류: 본문에 '</script>' 가 포함되어 미리보기가 깨진다. 본문을 수정하라.", file=sys.stderr)
        return 1

    warning = args.mode == "messenger" and bool(UNSUPPORTED_LINK.search(md))
    warning_html = ""
    if warning:
        print(LINK_WARNING, file=sys.stderr)
        warning_html = f'<div class="dooray-warning" role="alert">{html.escape(LINK_WARNING)}</div>'

    if args.mode == "messenger":
        head_html = (
            '<div class="dooray-head">'
            f'<div class="dooray-title">{html.escape(args.title)}</div>'
            f'<div class="dooray-author">{html.escape(args.author)}</div>'
            '</div>'
        )
    elif args.mode == "comment":
        author = html.escape(args.author)
        head_html = (
            '<div class="dooray-comment-head">'
            f'<div class="dooray-avatar">{author[:1]}</div>'
            f'<div><div class="dooray-author">{author}</div>'
            f'<div class="dooray-on">{html.escape(args.title)}</div></div>'
            "</div>"
        )
    else:
        tags_html = "".join(f'<span class="tag">{html.escape(t)}</span>' for t in args.tag)
        meta_parts = []
        for m in args.meta:
            label, _, value = m.partition(":")
            meta_parts.append(f"<span>{html.escape(label)} <b>{html.escape(value)}</b></span>")
        proj_html = (
            f'<div class="dooray-proj">{html.escape(args.project)}</div>'
            if args.project else ""
        )
        head_html = (
            '<div class="dooray-head">'
            f'{proj_html}'
            f'<div class="dooray-title">{html.escape(args.title)}</div>'
            f'<div class="dooray-meta">{"".join(meta_parts)}</div>'
            f'<div class="tags">{tags_html}</div>'
            "</div>"
        )

    values = {
        "TITLE": html.escape(args.title),
        "HEAD_HTML": head_html,
        "MODE": args.mode,
        "WARNING_HTML": warning_html,
        "MESSENGER_BODY": render_messenger(md) if args.mode == "messenger" else "",
        "MD_BODY": "" if args.mode == "messenger" else md,
    }
    # 본문의 템플릿 표기를 다시 치환하지 않도록 한 번만 삽입한다.
    out = re.sub(r"\{\{(\w+)\}\}", lambda match: values[match[1]],
                 TEMPLATE.read_text(encoding="utf-8"))
    Path(args.out).write_text(out, encoding="utf-8")
    print(f"생성 완료: {args.out}")
    return 1 if warning and args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
