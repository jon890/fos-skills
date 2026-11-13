# ADR-031: 업무 도구 어댑터는 orch 가 갖고, 보드는 업무 번호와 주소만 저장한다

- **status**: `accepted`
- **decision-type**: `architecture`
- **현재 규칙의 원본**: [업무 링크 기술 설계의 「책임과 경계」](../features/board-task-link/design.md#책임과-경계), [업무 링크 스펙 DECISION7](../features/board-task-link/spec.md#결정), `skills/orch/scripts/core/task-adapters.ts`.
- **결정**: 업무 번호를 맞추고 주소로 바꾸는 판정은 `skills/orch/scripts/core/task-adapters.ts`, 설정 읽기와 업무 도구 CLI 호출은 `skills/orch/scripts/lib/task-adapters.ts` 가 맡는다. 어댑터는 저장소 설정 `board.task` 하나로 고른다. work-board 의 보드 명령은 번호(`task-ref`)와 주소(`task`) 두 칸을 받은 그대로 저장하고, 창은 도구 이름을 work-board 의 bin 명령(orch 의 어댑터를 부른다) 출력으로만 받는다.
- **맥락**: 두레이 주소는 업무 번호만으로 만들 수 없고 `dooray` CLI 로 postId 를 얻어야 한다. 사내 주소 앞부분은 공개 저장소의 코드에 둘 수 없다. Jira, Notion 같은 도구도 붙일 수 있어야 하고(스펙 DECISION7), 보드는 orch 없이도 쓰는 확장 기능이다([ADR-006](006-work-board-in-plugin.md), [ADR-022](022-extension-directory-layout.md)).
- **대안 기각**:
  - 보드 명령(`board.ts`)이 번호를 주소로 바꾼다: 보드 명령이 orch 설정과 업무 도구 CLI 를 알아야 하고, 쓰기 잠금 안에서 외부 호출을 기다리게 된다.
  - inbox 스킬의 dooray 어댑터를 import 한다: 스킬은 폴더째 따로 내보내므로 orch 만 가져간 저장소에서 깨진다. 겹치는 것은 주소 꼴 하나뿐이다.
  - 띄울 때 주소를 만든다: 업무 도구가 막히면 worker 띄우기가 늦어진다(스펙 DECISION5).
  - 항목마다 도구 이름을 저장한다: 설정을 바꿔도 옛 이름이 남고, 같은 사실을 두 곳에 둔다.
- **결과**:
  - 얻는 것: 새 도구는 core 표의 줄 하나와 lib 의 주소 만들기 하나로 붙는다. 보드 명령과 창은 바뀌지 않는다. 업무 도구가 막혀도 보드 쓰기와 띄우기가 멈추지 않는다.
  - 감당할 것: 주소는 루프가 다음 틱에 채워 띄운 직후에는 칩이 흐린 글자다. 창이 도구 이름을 얻으려고 명령을 한 번 더 부른다. 옛 번들은 `board.task` 를 모르는 키로 거절해 새 번들 설치 뒤에만 설정을 넣는다.
- **확인 방법**: core 단위 테스트(`skills/orch/tests/core-task-adapters.spec.ts`)와 core 경계 검사(`skills/orch/tests/core-boundary.spec.ts`), 보드 명령 테스트가 도구 이름 없이 두 칸만 다루는지 본다.
