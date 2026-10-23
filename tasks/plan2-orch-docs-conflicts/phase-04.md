# Phase 04. 사용자 결정 질문의 형식을 정하고 보드가 결정과 권장안을 보이게 한다

**Execution profile**: standard

## 목표

worker 와 코디네이터가 사용자에게 묻는 결정을 한 형식으로 쓰게 한다. 보드의 결정 필요 항목이 질문 제목만이 아니라 무엇을 정하는지와 권장안을 보이게 한다.
코디네이터가 사용자가 정할 질문에 대신 답하지 않게 지침에 둔다.

**범위 외**: TypeScript 전환. 이 phase 는 지금의 Python `worker-ask.py` 와 JavaScript `register.js` 를 고친다. 전환 plan 이 그 동작을 그대로 옮긴다.

## 컨텍스트

시작 조건: 이 plan 의 phase 03 이 커밋됐다.

사용자 요청(2026-10-24): 보드의 「결정 필요」 항목에 질문 제목만 보여 사용자가 무엇을 고르는지 알 수 없었다.
질문 형식과 검사 규칙은 `docs/data-schema.md` 의 「사용자 결정 질문 형식」 이 소유한다. 그 값을 그대로 구현한다.

| 고칠 곳 | 지금 |
| --- | --- |
| `orch/scripts/worker-ask.py` | `--from`, `--question`, `--resume`, `--options`, `--run`, `--timeout-ms`, `--force` 를 받는다. 형식 검사가 없다 |
| `orch/templates/spec-common.md` 「판단이 필요할 때」 | 무엇을 ask 로 묻는지와 `worker-ask.py` 호출 블록이 있다. 질문 형식이 없다 |
| `orch/references/replying.md` 「코디네이터가 답할 질문과 사용자에게 올릴 결정」 | 누가 답하는지 표와 「배경과 권장안을 붙여 묻는다」 가 있다 |
| `orch/SKILL.md` 「원칙」 | 사용자 요청을 바로 넘기지 않는다, 정할 것은 배경과 권장안을 붙여 묻는다 |
| `work-board/hooks/register.js` | `parseQuestions` 가 본문을 `text` 로 넘기고, `questionView` 가 `questionText(q.text)` 로 앞 400자를 한 덩어리로 보인다 |

**근거 문서**: `docs/data-schema.md` 의 「사용자 결정 질문 형식」, `docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」 의 사용자 결정 질문 줄

## 의도 메모

- 형식 검사는 `--decision` 을 줄 때만 한다. 기술 질문과 막힘 보고는 형식 없이 지금처럼 묻는다. 모든 질문에 형식을 강제하면 막힘 보고가 늦어진다.
- 보드는 형식이 있으면 `결정:` 줄을 굵게, `권장:` 줄을 그 아래에 보이고, 없으면 지금처럼 본문 앞부분을 보인다. 형식이 어긋난 옛 질문 때문에 보드가 깨지지 않게 한다.
- 코디네이터 규칙: 사용자가 정할 질문은 코디네이터가 권장안으로 대신 답하지 않는다. 권장안을 보여 사용자가 고르게 하고, 고른 답을 worker 에게 보낸다. 코디네이터가 사용자에게 직접 묻는 결정도 같은 형식이다.

## 작업 항목

### 1. `orch/scripts/worker-ask.py` 의 `--decision`

`--decision` 을 주면 `--question` 본문을 `docs/data-schema.md` 「사용자 결정 질문 형식」 의 규칙 표로 본다. 검사하는 것은 그 표의 세 줄뿐이다: 첫 줄이 `결정:` 으로 시작한다, `- ` 로 시작하는 줄이 둘 이상이다, `권장:` 으로 시작하는 줄이 정확히 하나다. `배경:` 과 `선택지:` 머리 줄은 형식 예시에 있지만 검사하지 않는다. 어긋나면 묻지 않고 어긋난 규칙마다 한 줄(빠진 `결정:` 첫 줄, 선택지 수, `권장:` 줄 수)을 stderr 에 내고 종료 코드 2 다. 머리 주석의 사용법과 종료 코드에 더한다.

### 2. 지시서 틀과 코디네이터 지침

- `orch/templates/spec-common.md` 「판단이 필요할 때」: 사용자 결정은 형식대로 쓰고 `--decision` 을 붙인다. 형식 예시 한 벌을 ```text 블록에 둔다. `<...>` 자리 표시가 든 여러 줄 예시를 ```bash 블록에 넣으면 `orch/tests/test_template_script_path.py` 의 자리 표시 리다이렉트 검사가 실패한다
- `orch/references/replying.md`: 위 「의도 메모」 의 코디네이터 규칙과, 사용자에게 보일 때 `결정:` 줄과 `권장:` 줄을 그대로 옮긴다는 것
- `orch/SKILL.md` 「원칙」: 「사용자가 정할 질문은 코디네이터가 대신 답하지 않는다」 한 줄

### 3. `work-board/hooks/register.js`

`decisionOf(text): { title: string; recommend: string | null } | null` 을 export 한다. 첫 줄이 `결정:` 이면 그 뒤를 `title`, `권장:` 줄의 뒤를 `recommend` 로 낸다. 아니면 null 이다.
`questionView` 는 `decisionOf` 가 있으면 제목 줄을 굵게, 권장 줄을 그 아래에 보인다. 없으면 지금처럼 `questionText` 다.

### 4. 테스트

- `orch/tests/test_scripts.py` 의 `WorkerAskTest` 에 사례를 더한다: 형식을 갖춘 `--decision` 질문이 가짜 orca 의 ask 로 간다. `권장:` 이 빠진 질문은 ask 를 부르지 않고 종료 코드 2. `--decision` 없는 짧은 질문은 지금처럼 간다
- `work-board/tests/live.test.ts` 에 사례를 더한다. 저장소 루트의 `claude plugin test .` 가 이 파일을 돌린다: `decisionOf` 가 제목과 권장을 낸다. 형식이 없으면 null. 권장 줄이 없으면 `recommend` 가 null
- `work-board/tests/pane.test.ts` 에 사례 둘을 더한다. 기존 「질문 조회 실패를 결정 필요 0 대신 확인 불가로 표시한다」 처럼 가짜 `orca` 응답으로 미답변 질문 하나를 주고 창을 mount 한다: 형식을 갖춘 질문이면 `결정:` 뒤 제목이 `bold` 인 Text 로, `권장:` 줄이 그 아래 Text 로 나온다. 형식이 없는 질문이면 지금처럼 본문 앞부분이 Text 로 나온다. `questionView` 는 `register()` 안의 클로저라 파서 테스트만으로는 렌더링 변경을 되돌려도 실패하지 않는다

### 5. `orch/CHANGELOG.md`

phase 03 이 쓴 이 plan 의 항목에 이 변경을 더한다.

## 검증

```bash
python3 -m unittest orch/tests/test_scripts.py
python3 scripts/run-orch-tests.py --jobs 4
claude plugin test .
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/references/replying.md orch/templates/spec-common.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/worker-ask.py` | 수정 |
| `orch/templates/spec-common.md` | 수정 |
| `orch/references/replying.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `work-board/hooks/register.js` | 수정 |
| `work-board/tests/live.test.ts` | 수정 |
| `work-board/tests/pane.test.ts` | 수정 |
| `orch/tests/test_scripts.py` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
