---
name: inbox
description: |
  업무 도구(첫 adapter 는 두레이)에서 나를 태그한 업무 댓글, 담당·참조로 온 새 업무, 메신저 멘션을 모아 보고, 답장·리액션·넘김을 권한다. 답장과 리액션은 사용자가 확인한 뒤 등록한다.
  "알림 확인", "태그된 거 답해 줘", "멘션 온 거", "두레이 알림", "알림 답변", "알림함", "inbox" 요청과 /board 의 알림 답변 요청문에 쓴다.
  업무 문서 작성과 진행 기록 댓글은 dooray-task 가, 등록 전 렌더링은 content-preview 가 맡는다.
metadata:
  version: "0.2.0"
---

# inbox

새 알림마다 권장 동작과 이유를 보고 사용자가 어떻게 처리할지 고른다.

- **확인 없이 등록하지 않는다.** `reply` 와 `react` 에는 사용자가 이번 미리보기를 확인한 뒤에만 `--yes` 를 붙인다.
- **사람은 이름으로 쓴다.** `context` 가 풀지 못한 id 가 있으면 초안을 쓰지 않는다. id 를 이름으로 짐작하면 받는 사람이 틀린다.

`$INBOX` 는 이 스킬 번들의 `scripts/inbox.ts` 다. 명령과 종료 코드는 `node --disable-warning=ExperimentalWarning "$INBOX" --help` 와 그 파일의 머리 주석이 소유한다.
설정, 상태, 저장소 필터 파일의 형식은 [config.md](references/config.md) 가 소유한다.

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 알림 읽기 | `board` 출력의 `enabled` 가 true 이고, 새 알림마다 권장 동작과 이유를 대화에 보였다 | [config.md](references/config.md) |
| 2 | 맥락 읽기 | 필요한 항목의 `context` 종료 코드가 0 이다 | |
| 3 | 답장 초안 | 답장할 때만 본문 파일을 만들고 멘션과 AI 작성 표기는 CLI 가 붙이게 둔다 | [reply.md](references/reply.md) |
| 4 | 미리보기와 확인 | `reply` 나 `react` 가 `--yes` 없이 종료 코드 3 으로 미리보기를 냈고, 사용자가 확인했다 | [reply.md](references/reply.md) |
| 5 | 등록이나 넘김 | 사용자가 고른 `reply --yes`, `react --yes`, `dismiss` 의 종료 코드가 0 이다 | |

`/board` 의 숫자 단축키가 채운 요청문은 그 항목만 살핀다. 2단계에서 내용을 읽고 같은 기준으로 권장 동작과 이유를 보인다.

## 1. 알림 읽기

이 저장소의 보드 기준으로 읽는다. 저장소 필터와 미분류 판정이 주 checkout 경로로 정해지기 때문이다.

```bash
REPO=$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')
node --disable-warning=ExperimentalWarning "$INBOX" board --repo "$REPO" --json
```

- `enabled` 가 false 면 설정이 없다. [config.md](references/config.md) 대로 설정을 만들지 사용자에게 묻고 멈춘다.
- `errors` 의 `dooray:messenger` 같은 키는 그 출처만 받지 못했다는 뜻이다. 사용자에게 한 줄로 알리고 나머지 항목으로 계속한다.
- `fetchedAt` 이 null 이면 첫 받기가 따로 도는 중이다. 1분쯤 뒤에 다시 읽는다.
- `state` 가 `new` 인 항목마다 제목, 권장 동작, 이유 한 줄을 대화에 보여 준다. 발췌만으로 질문이나 요청이 있는지 알기 어려우면 먼저 2단계의 맥락을 읽는다.

| 알림 내용 | 권장 동작 |
| --- | --- |
| 내 일과 무관하다 | 넘김 |
| 내 답이나 조치가 필요한 질문 또는 요청이 있다 | 답장 |
| 감사 인사나 처리 완료 확인처럼 질문이나 요청 없이 가볍게 응답할 내용이다 | 업무 댓글 멘션이나 메신저 멘션이면 리액션 |
| 가볍게 응답할 내용이지만 담당·참조 업무, 댓글이나 메시지를 특정할 수 없는 항목이다 | 넘김. 설명을 남겨야 하면 답장 |

리액션은 새 알림 가운데 두 종류에만 권한다. `target` 에 업무와 댓글 id 가 있는 두레이 업무 댓글 멘션과, 대화방과 메시지 id 가 있는 메신저 멘션이다.
메신저 리액션은 dooray-cli 0.36.0 이상이 필요하다. 미리보기가 버전 때문에 거절되면 넘김을 권한다. 권장과 이유를 보여 준 뒤 사용자가 고른 동작으로 진행한다.

## 2. 맥락 읽기

`$ID` 는 알림 목록에서 골랐거나 보드 요청문에 들어 있는 항목 id 다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" context "$ID"
```

종료 코드 1 이면 stderr 에 풀지 못한 사람 id 가 있다. `dooray member get <id>` 로 이름을 확인하고, 그래도 모르면 사용자에게 묻는다.

## 3. 답장 초안

본문만 세션 임시 폴더의 파일에 쓴다. 받는 사람 멘션과 AI 작성 표기는 `reply` 가 붙인다.
문체와 내용 규칙은 [reply.md](references/reply.md) 를 따른다.

## 4. 미리보기와 확인

`$BODY` 는 3단계의 본문 파일이다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" reply "$ID" --body-file "$BODY"
```

종료 코드 3 과 함께 stdout 에 등록될 본문 전체가 나온다. 이 본문을 미리보기로 보이고 확인을 받는다. 미리보기 방법은 [reply.md](references/reply.md) 가 정한다.
사용자가 고치라고 하면 본문 파일을 고치고 이 단계를 다시 한다.

리액션은 본문 파일 없이 대상 댓글이나 메시지와 이모지를 미리 본다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" react "$ID"
```

다른 이모지를 고르면 `--emoji heart` 처럼 이름을 넘긴다. 종료 코드 3 이면 출력에 나온 댓글이나 메시지와 이모지를 대화에 보여 주고 확인을 받는다.

## 5. 등록이나 넘김

확인을 받으면 `--yes` 를 붙인다. 답장이나 리액션을 등록한 항목은 다음 받기를 기다리지 않고 「답함」 이 된다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" reply "$ID" --body-file "$BODY" --yes
```

```bash
node --disable-warning=ExperimentalWarning "$INBOX" react "$ID" --emoji "$EMOJI" --yes
```

`$EMOJI` 는 사용자가 미리보기에서 확인한 이모지 이름이다. 리액션에서 웹 세션 오류가 나면 등록되지 않았음을 알리고 넘김을 권한다. 세션을 다시 넣는 방법은 명령 출력에 나온다.

답할 필요가 없다고 사용자가 정한 항목은 넘긴다. 넘김은 사람 단위로 남아 모든 저장소의 보드에서 사라진다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" dismiss "$ID"
```

사용자는 보드의 알림 상자에서 `x` 다음 번호로 직접 넘길 수도 있다. 보드도 이 명령을 부른다. 잘못 넘긴 항목은 같은 명령에 `--undo` 를 붙여 되돌린다.

답장을 등록한 주소, 리액션을 단 댓글이나 메시지와 이모지, 또는 넘긴 항목을 한 줄로 보고한다.

## 이 보드에서 프로젝트나 대화방 숨기기

`mute` 는 알림의 프로젝트나 대화방 이름을 보여 주고 종료 코드 3을 낸다. 사용자가 이름을 확인하면 같은 명령에 `--yes` 를 붙인다. 그 저장소의 보드에서 같은 프로젝트나 대화방의 알림과 건수가 빠진다.

```bash
node --disable-warning=ExperimentalWarning "$INBOX" mute "$ID" --repo "$REPO"
node --disable-warning=ExperimentalWarning "$INBOX" mute-list --repo "$REPO"
node --disable-warning=ExperimentalWarning "$INBOX" unmute project "$VALUE" --repo "$REPO"
```

되돌릴 때는 `mute-list` 에 나온 종류(`project` 또는 `channel`)와 값(`$VALUE`)을 `unmute` 에 넘긴다.
