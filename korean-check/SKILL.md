---
name: korean-check
metadata:
  version: "1.1.0"
description: |
  한국어로 내보내는 산출물을 내보내기 직전에 점검한다.
  어휘와 문장 구성, 분량과 구조, 렌더링 함정의 판정 기준과 검사기를 이 스킬이 소유한다.
  파일, PR 본문, 커밋 메시지, 업무와 위키, 게시글, 아티팩트, 채팅 답변이 모두 대상이다.
  판정 기준을 이 스킬이 소유하므로 다른 스킬은 여기를 가리킨다.
---

# korean-check

**목표: 한국어 산출물이 나가기 전에 기계가 판정할 축은 검사기로 걸러내고, 남은 축은 쓰지 않은 쪽이 읽는다.**

두 층으로 나뉜다.

| 층 | 무엇 | 판정 수단 | 축의 소유자 |
| --- | --- | --- | --- |
| 검사기 | 매핑 표의 금지어와 렌더링 함정 | 종료 코드 | `references/markdown-readability.md` 의 「자동 검사」 |
| 검토 | 검사기가 판정하지 못하는 것 | 발견 목록 | `references/review-axes.md` 의 「축」 |

**판정 기준과 검사기를 한 자리에 둔다.** `scripts/korean-style-check.py` 가
`references/korean-style.md` 의 매핑 표를 런타임에 읽는다.
둘을 갈라 두면 표를 찾지 못해 검사기가 종료 코드 2 로 끝난다.

## 어느 파일을 언제 읽나

| 판단할 것 | 읽을 파일 |
| --- | --- |
| 어떤 낱말을 쓸지, 문장을 어떻게 맺을지 | `references/korean-style.md` |
| 헤더와 표를 쓸지, 밖으로 나가는 글인지 | `references/writing-structure.md` |
| 이 매체에서 어떻게 렌더될지 | `references/markdown-readability.md` |
| 검토자에게 무엇을 주고 받은 것을 어떻게 처리할지 | `references/review-axes.md` |

## 검사기를 돌린다

```bash
scripts/check.sh <파일.md> [<파일.md>...]
scripts/check.sh --text "<제목이나 커밋 메시지>"
```

`check.sh` 가 검사기 둘을 함께 돌리고 종료 코드 중 큰 값을 낸다.
종료 코드 규약과 인자는 그 스크립트의 머리말이 소유한다.

**만든 방법과 무관하게 파일 경로로 직접 돌린다.**
편집 훅은 편집 도구로 만든 파일만 검사한다.
Bash 의 heredoc 이나 `sed` 로 만든 파일은 훅이 돌지 않아 위반이 그대로 나간다 (실측).

**검사와 등록을 한 명령에 묶지 않는다.** 앞의 검사가 실패해도 뒤의 등록이 그대로 돌아,
이미 올라간 뒤에 위반을 알게 된다. 실측으로 그렇게 등록된 PR 이 있다.

파일이 아닌 것은 `--text` 로 검사한다. 업무와 위키 제목, PR 과 이슈 제목, 커밋 메시지가 그 경로로 들어온다.

## 검사기가 잡지 못하는 축을 본다

**검사기의 종료 코드 0 은 본문이 통과했다는 뜻이 아니다.**
축, 실측 근거, 통과 조건은 `references/review-axes.md` 가 소유한다.

**긴 문서와 정형 양식은 쓰지 않은 쪽이 읽는다.**
읽기 전용 검토 역할이 있으면 그것에 맡기고, 없으면 사용자에게 검토를 청한다.
짧은 댓글 한 줄은 이 층을 건너뛰고 검사기 통과로 끝낸다.
분량 구간의 판정 기준은 `references/writing-structure.md` 가 소유한다.

검사기에 넣을 파일이 없고 제목처럼 한 줄도 아닌 산출물은 이 층만 적용한다.
채팅 답변이 그렇다.

## 훅에 걸기

편집 직후 자동 검사는 하네스 설정이 소유한다.
Claude Code 는 `~/.claude/settings.json` 의 `hooks` 에 아래를 넣는다.

```json
"PostToolUse": [{
  "matcher": "Edit|Write|MultiEdit",
  "hooks": [
    { "type": "command", "command": "~/.claude/scripts/korean-style-check.py --hook", "timeout": 15 },
    { "type": "command", "command": "~/.claude/scripts/check-readability.py --hook", "timeout": 15 }
  ]
}]
```

두 검사기를 그 경로에 심링크로 걸어 두면 스킬을 고칠 때 훅 설정을 다시 손대지 않는다.
설치 방법은 `README.md` 가 소유한다.

훅 모드는 위반이 있어도 0 으로 끝난다. 편집을 막지 않고 결과만 알린다.
