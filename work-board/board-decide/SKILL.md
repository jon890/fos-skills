---
name: board-decide
description: |
  지금 사용자가 정할 것을 모아 정리하고 AskUserQuestion 으로 묻는다.
  보드의 결정 필요 항목, 답하지 않은 worker 질문, 미뤄 둔 결정을 모은다.
  "/board-decide", "정할 것 물어봐", "결정 사항 모아줘" 같은 요청이면 이 스킬을 쓴다.
metadata:
  version: "1.1.0"
---

# board-decide

**목표: 지금 정할 수 있는 것이 모두 사용자에게 물어졌고, 받은 답이 보드와 worker 에게 반영돼 있다.**

지금 정할 것을 모아 정리하고 물어봐 줘.

1. 보드의 결정 필요(decide) 항목, 「나중에 정할 것」 같은 모음 항목의 줄, 답하지 않은 worker 질문, 이번 대화에서 정하기로 미뤄 둔 것을 모은다.
2. 이미 정해졌거나 지금 정할 수 없는 것(외부 답 대기)은 빼고, 뺀 이유를 한 줄씩 적는다.
3. 항목마다 배경, 선택지, 권장안과 그 이유, 고르면 바뀌는 것을 짧게 정리해 먼저 보여 준다.
4. 그다음 AskUserQuestion 으로 한 번에 4개까지 묻고, 남으면 이어서 묻는다. 권장안을 첫 선택지로 두고 「(Recommended)」 를 붙인다.
5. 답을 받으면 보드 항목을 갱신하고, 답을 기다리는 worker 가 있으면 전달한다.
   - 답한 보드 줄은 `board.ts mark <id> <n>` 으로 끝낸다. 줄 번호는 `board.ts list` 가 항목 아래 줄마다 보인다. 줄이 모두 끝난 decide 항목은 저절로 done 이 된다.
   - worker 질문은 코디네이터 터미널에서 `orca orchestration reply --id <질문 id> --body ...` 로 답한다.
