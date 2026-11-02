# Phase 02. /board 알림 상자

**Execution profile**: standard

## 목표

`/board` 창에 알림 상자, 상태 줄의 새 알림 수, 답변 요청문 단축키를 더한다. 보드는 `inbox.ts board` 의 출력을 그리기만 한다.

**범위 외**: inbox 코어(phase 01), 스킬 문서(phase 03)

## 컨텍스트

`work-board/hooks/register.js` 의 `loadLive`, `fillPrompt`, `statusLine`, 단축키 상자 패턴을 따른다. 훅은 Node 가 없고 `$.process.run`, `$.plugin.root`, `$.clock.every` 로만 밖에 닿는다. 화면 테스트는 `work-board/tests/pane.test.ts` 의 `start` 도우미 패턴을 따른다.

**근거 문서**: `docs/features/work-inbox/spec.md` 의 「설계」 와 「요구사항과 인수 조건」

## 작업 항목

### 1. 구현

- `INBOX_MS = 60000` 마다 `node --disable-warning=ExperimentalWarning <$.plugin.root>/inbox/scripts/inbox.ts board --repo <boardRoot> --json` 을 `run` 으로 부른다. timeout 은 `COMMAND_TIMEOUT_MS` 보다 긴 60초. `boardRoot` 가 비면 session cwd
- 결과 `enabled: false` 면 알림 상자, `i`, `1`~`9` 가 없다 (R6)
- 상자 「알림 n」(새 항목 수) 와 흐린 「· HH:MM 확인」. 오류는 출처마다 빨간 한 줄(「메신저 확인 불가: …」) (R7). 미분류 수가 있고 이 보드가 기본 보드가 아니면 흐린 「미분류 알림 n · 기본 보드에서 본다」 (R9)
- 항목 줄: 번호(1~9), 새 항목 「●」 답함 「✓」, 링크 머리말 「두레이」(url 이 있으면 링크), 제목, 흐린 「보낸 사람 · 종류 · 시각(ago)」. 멘션은 다음 줄에 흐린 excerpt. 답함은 줄 전체 흐림
- 단축키 상자에 `i` 「알림 답변」. 숫자 키 1~9 는 항목 줄의 버튼 hotkey 로 둔다. 둘 다 `fillPrompt`
- 요청문: `INBOX_PROMPT`(전체 훑기)와 `replyPrompt(item)`(항목 하나). 모두 inbox 스킬을 쓰라고 하고, 맥락, 초안, 미리보기, 확인 뒤 `--yes` 순서를 담는다
- 상태 줄 `statusLine` 앞에 「알림 n」 을 붙인다(새 항목이 있을 때만)
- 순수 함수(`inboxSummary`, `replyPrompt`, `inboxLine`)는 export 해 `work-board/tests/inbox.spec.ts` 에서 테스트한다. 화면은 work-board 의 pane 화면 테스트에 알림 상자 테스트를 더한다(가짜 process.run 이 inbox 출력을 돌려준다). 이 파일은 `claude plugin test .` 가 돌고 `verify_task.py` 가 그 실행기를 모르므로 변경 파일 표에서 뺐다. 커밋 전 대조에서 이 파일은 계획한 변경으로 본다

### 2. 이 phase 를 검증하는 `work-board/tests/inbox.spec.ts` 와 화면 테스트

순수 함수는 새 항목 둘·답함 하나 입력에서 새 수 2, 답함 줄이 뒤, 미분류 문구가 기본 보드가 아닐 때만 나오는지 본다. `enabled: false` 입력에서 상자가 없는지 본다. 화면 테스트(work-board 의 pane 테스트 파일, `claude plugin test .` 가 돈다)는 가짜 process.run 이 inbox 출력을 줄 때 「알림 2」 와 메신저 오류 줄이 그려지는지 본다.

## 검증

```bash
node --test --test-concurrency=4 "work-board/tests/*.spec.ts"
test -f work-board/tests/pane.test.ts && claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `work-board/hooks/register.js` | 수정 |
| `work-board/tests/inbox.spec.ts` | 신규 |
