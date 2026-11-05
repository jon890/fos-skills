# Phase 02. 공통 지시서 틀에 확인 질문과 escalation 규칙을 더한다

**Execution profile**: standard

## 목표

모든 worker 가 지시서와 스펙이 닫은 결정을 실행 전에 다시 묻지 않고, 머지 대기와 준비됨을 escalation 이 아니라 status 로 보내게 한다.

**범위 외**: 13개 저장소의 공통 지시서 사본(스펙 범위 밖, `공통` 경고로 코디네이터가 옮긴다). `spec-lint` 코드(표지를 틀에서 읽으므로 고치지 않는다).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/orch-routing/spec.md`(DECISION3, DECISION10), `docs/features/orch-routing/design.md`, `docs/features/orch-routing/evidence.md` 표 2

- 표지 규칙: 틀(`skills/orch/templates/spec-common.md`)의 `<!-- orch-rule: <이름> -->` 가 붙은 목록 항목을 `spec-lint` 가 저장소 사본과 비교한다(`skills/orch/scripts/spec-lint.ts` 머리 주석 「공통」). 표지 항목의 본문은 항목 머리 줄부터 들여쓴 줄까지다.
- 기존 항목의 본문을 바꾸면 모든 저장소에 `공통` 경고가 난다. 이번에는 기존 항목(`ready-status`, `status-only`)을 바꾸지 않고 새 표지 항목 둘을 더해, 사본은 새 항목만 옮기면 되게 한다.

## 의도 메모

- 「모든 worker」(DECISION3)라 제공자별 문장을 쓰지 않는다.
- 새 escalation 항목을 `ready-status`(「끝내기」 번호 목록 5) 옆이 아니라 `status-only` 뒤에 두는 이유: 번호 목록 사이에 넣으면 6·7 번호가 밀려 `done-after-merged` 본문 경고가 모든 저장소 사본에 난다. 스펙 DECISION10 과 설계 REQ3 행도 같은 자리로 고쳤다.
- 「확인 질문」 과 「판단이 필요할 때」 의 ask 대상(외부 계약, 데이터 삭제 같은 것)을 섞지 않는다. 새 규칙은 「이미 닫힌 결정의 재확인」 만 다룬다.

## 작업 항목

### 1. `skills/orch/templates/spec-common.md` 「판단이 필요할 때」 의 첫 항목 뒤

새 항목: 「**지시서와 스펙이 이미 정한 결정은 실행 전에 다시 확인하지 않고 진행한다.** 「이대로 진행할까요」, 「이 값이 맞나요」 처럼 답이 지시서에 있는 질문을 ask 로 보내지 않는다. 지시서와 실제 코드가 어긋나 정한 결정을 지킬 수 없을 때만 묻는다. 확인 질문 하나가 코디네이터와 사용자를 기다리게 해 worker 가 멈춘다.」 끝에 `<!-- orch-rule: no-reconfirm -->`.

### 2. 같은 파일 「공통 규칙」 절의 `status-only` 항목 바로 뒤

새 항목: 「머지를 기다린다는 알림은 따로 보내지 않는다. 「끝내기」 의 `준비됨` status 가 그 알림이다. escalation 은 코디네이터가 움직여야 이 worker 가 계속할 수 있을 때(권한 거부, 막힌 검증, 범위 밖 변경)만 쓴다. 머지 대기를 escalation 으로 보내면 막힌 worker 와 구분되지 않는다.」 새 메시지를 만들지 않고 통로만 정해, 앞 `status-only` 항목(기다리는 중 진행 보고 금지)과 부딪히지 않게 한다. 끝에 `<!-- orch-rule: status-not-escalation -->`.

### 3. 근거 링크

두 항목 모두 틀 안에 링크를 넣지 않는다(틀은 다른 저장소로 복사된다). 근거는 이 PR 본문과 `evidence.md` 가 갖는다.

### 4. 변경 이력 조각

phase 01 의 `skills/orch/changes/routing-guide.minor.md` 에 「공통 지시서 틀에 no-reconfirm, status-not-escalation 규칙」 줄을 더한다.

## 검증

```bash
python3 export-only-skills/korean-check/scripts/korean-style-check.py skills/orch/templates/spec-common.md
python3 scripts/check-skill-docs.py orch
grep -c 'orch-rule: no-reconfirm\|orch-rule: status-not-escalation' skills/orch/templates/spec-common.md
node scripts/run-node-tests.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/template-script-path.spec.ts
T=$(mktemp -d) && git show origin/main:skills/orch/templates/spec-common.md > $T/spec-common.md && printf '# 표본\n\n브랜치: `feat/sample`\n허락: 없음.\nworker 선택: `claude` `claude-sonnet-5-5` effort `medium`. 비교: sol. 이유: 표본.\n\n## 할 일\n\n루프 없이: 표본이다.\n' > $T/spec-sample.md && node --disable-warning=ExperimentalWarning skills/orch/scripts/spec-lint.ts --repo . $T/spec-sample.md > $T/out.txt 2>&1; grep '틀의 규칙 표지' $T/out.txt | grep 'no-reconfirm' | grep -c 'status-not-escalation'; grep -c '가 붙은 규칙이 틀과 다르다' $T/out.txt
```

기대값: 첫 두 명령 0. 표지 수 2. 테스트 통과(실행기 종료 코드 0). 마지막 줄은 임시 폴더에 옛 틀(`origin/main` 의 틀)을 공통 지시서 사본으로 두고 새 틀과 비교한다. 첫 grep 은 1 이다. `spec-lint` 는 빠진 표지를 한 줄(`공통: 틀의 규칙 표지 ... 가 없다`)로 모아 내므로(`spec-lint.ts` 의 `staleCommon`), 그 한 줄에 두 이름이 모두 있어야 한다. 둘째 grep 은 0 이다(기존 표지의 본문이 바뀌지 않았다). 임시 폴더는 `$TMPDIR` 아래라 저장소에 남지 않는다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ2 | phase 01 을 마친 작업 공간 | phase 01 「검증」 의 grep 명령들을 돌린다 | 각 기대값과 같다. 링크 대상 `evidence.md` 가 있다. `skills/orch/scripts` 와 `tests` 변경이 없다 | 로컬 작업 공간 | 없음 | PR 전 |
| REQ8 | phase 01 을 마친 작업 공간 | phase 01 「검증」 의 「모델」 절 id 수·중복 grep 과 `spec-writing.md` 의 `행:` grep 을 돌린다 | id 8개, 중복 0, `행:` 2 이상. 검사(막기)는 뒤 PR 몫이라 이 PR 에서는 문서만 본다 | 로컬 작업 공간 | 없음 | PR 전 |
| REQ3 | phase 02 를 마친 작업 공간. 새 표지 둘이 없는 공통 지시서 사본(`origin/main` 의 틀) | 옛 틀을 사본으로 둔 임시 지시서 폴더에서 `spec-lint` 를 돌린다(위 검증의 마지막 명령) | `공통` 경고 한 줄이 `no-reconfirm`, `status-not-escalation` 을 빠진 표지로 함께 알린다. 「규칙이 틀과 다르다」 경고는 0건이다 | 로컬 작업 공간 | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/templates/spec-common.md` | 수정 |
| `skills/orch/changes/routing-guide.minor.md` | 수정 |
