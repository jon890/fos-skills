#!/usr/bin/env python3
"""gh-review-list.sh 가 받은 리뷰 댓글 JSON 을 사람이 읽을 형태로 출력한다.

usage: render-comments.py <json파일> <thread id 또는 빈문자열> <0|1 내 것만> <내 로그인>
"""
import json
import sys

path, thread, mine, me = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
rows = json.load(open(path, encoding="utf-8"))

if thread:
    rows = [r for r in rows
            if str(r["id"]) == thread or str(r.get("in_reply_to_id")) == thread]
if mine:
    rows = [r for r in rows if r["user"]["login"] == me]

print(f"댓글 {len(rows)}건")
print("주의: line 이 null 인 댓글은 이 목록에서 빠질 수 있다. 개수로 등록 성공을 판정하지 않는다.")
print()

for r in rows:
    kind = "답글" if r.get("in_reply_to_id") else "루트"
    head = r["body"].split("\n")[0][:50]
    name = r["path"].split("/")[-1]
    print(f'{kind} {r["id"]}  {r["user"]["login"]:<16} {name}:{r.get("line")}')
    print(f'     {head}')
