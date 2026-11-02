---
name: inbox
description: |
  업무 도구(첫 adapter 는 두레이)에서 나를 태그한 업무 댓글, 담당·참조로 온 새 업무, 메신저 멘션을 모아 보고, 맥락을 읽은 답변 초안을 사용자 확인 뒤 등록한다.
  "알림 확인", "태그된 거 답해 줘", "멘션 온 거", "두레이 알림", "알림 답변", "알림함", "inbox" 요청과 /board 의 알림 답변 요청문에 쓴다.
  업무 문서 작성과 진행 기록 댓글은 dooray-task 가, 등록 전 렌더링은 content-preview 가 맡는다.
metadata:
  version: "1.0.0"
---

# inbox

**목표: 사용자가 확인한 답변만 알림을 보낸 사람에게 등록되고, 답할 필요가 없는 알림은 넘김으로 남아 모든 보드에서 사라진다.**

- **확인 없이 등록하지 않는다.** `inbox.ts reply` 에 `--yes` 를 붙이는 것은 사용자가 합성한 본문을 읽고 확인한 뒤뿐이다.
- **사람은 이름으로 쓴다.** `context` 가 풀지 못한 id 가 있으면 초안을 쓰지 않는다. id 를 이름으로 짐작하면 받는 사람이 틀린다.

`$INBOX` 는 이 스킬 번들의 `scripts/inbox.ts` 다. 명령과 종료 코드는 `node --disable-warning=ExperimentalWarning "$INBOX" --help` 와 그 파일의 머리 주석이 소유한다.
설정, 상태, 저장소 필터 파일의 형식은 [config.md](references/config.md) 가 소유한다.

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 알림 읽기 | `board` 출력의 `enabled` 가 true 이고, 답할 항목 id 를 골랐다 | [config.md](references/config.md) |
| 2 | 맥락 읽기 | `context` 종료 코드가 0 이다 | |
| 3 | 초안 | 본문 파일이 있고 받는 사람 멘션과 AI 작성 표기가 본문에 없다 | [reply.md](references/reply.md) |
| 4 | 미리보기와 확인 | `reply` 가 `--yes` 없이 종료 코드 3 으로 합성 본문을 냈고, 사용자가 그 본문을 확인했다 | [reply.md](references/reply.md) |
| 5 | 등록이나 넘김 | `reply --yes` 나 `dismiss` 종료 코드가 0 이다 | |

`/board` 의 숫자 단축키가 채운 요청문은 1단계의 항목 id 를 이미 담고 있다. 2단계부터 시작한다.

## 1. 알림 읽기

이 저장소의 보드 기준으로 읽는다. 저장소 필터와 미분류 판정이 주 checkout 경로로 정해지기 때문이다.

```bash
REPO=$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')
node --disable-warning=ExperimentalWarning "$INBOX" board --repo "$REPO" --json
```

- `enabled` 가 false 면 설정이 없다. [config.md](references/config.md) 대로 설정을 만들지 사용자에게 묻고 멈춘다.
- `errors` 의 `dooray:messenger` 같은 키는 그 출처만 받지 못했다는 뜻이다. 사용자에게 한 줄로 알리고 나머지 항목으로 계속한다.
- `fetchedAt` 이 null 이면 첫 받기가 따로 도는 중이다. 1분쯤 뒤에 다시 읽는다.
- 새 항목이 여럿이면 묻는 것을 항목마다 한 줄로 정리하고, 답할 것과 넘길 것을 나눠 사용자에게 보인다.

## 2. 맥락 읽기

`$ID` 는 1단계에서 고른 항목 id 다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" context "$ID"
```

종료 코드 1 이면 stderr 에 풀지 못한 사람 id 가 있다. `dooray member get <id>` 로 이름을 확인하고, 그래도 모르면 사용자에게 묻는다.

## 3. 초안

본문만 세션 임시 폴더의 파일에 쓴다. 받는 사람 멘션과 AI 작성 표기는 `reply` 가 붙인다.
문체와 내용 규칙은 [reply.md](references/reply.md) 를 따른다.

## 4. 미리보기와 확인

`$BODY` 는 3단계의 본문 파일이다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" reply "$ID" --body-file "$BODY"
```

종료 코드 3 과 함께 stdout 에 등록될 본문 전체가 나온다. 이 본문을 미리보기로 보이고 확인을 받는다. 미리보기 방법은 [reply.md](references/reply.md) 가 정한다.
사용자가 고치라고 하면 본문 파일을 고치고 이 단계를 다시 한다.

## 5. 등록이나 넘김

확인을 받았으면 같은 명령에 `--yes` 를 붙인다. 등록한 항목은 다음 받기를 기다리지 않고 「답함」 이 된다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" reply "$ID" --body-file "$BODY" --yes
```

답할 필요가 없다고 사용자가 정한 항목은 넘긴다. 넘김은 사람 단위로 남아 모든 저장소의 보드에서 사라진다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" dismiss "$ID"
```

등록한 주소나 넘긴 항목을 한 줄로 보고한다.
