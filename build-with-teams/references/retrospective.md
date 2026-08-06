# 실행 회고 계약

## 저장 구조

오버레이가 지정하지 않으면 ADR처럼 회고 하나당 파일 하나를 사용한다.

```text
docs/retrospectives/
  INDEX.md
  0001-<slug>.md
  0002-<slug>.md
```

`tasks/`에는 계획·phase·상태만 두고 회고를 저장하지 않는다.
새 번호는 `INDEX.md`와 기존 파일의 최댓값 다음 번호를 사용한다.

## 기록 시점

- phase에서 재발 가능한 실패·경고·미검증·범위 외 발견이 나온 직후
- critic `REVISE`, code-reviewer `FIX_NEEDED`, docs-verifier `UPDATE_NEEDED`·`VIOLATION` 직후
- 작업이 오래 정체되거나 잘못된 도구·명령, 격리 위반 위험을 발견하고 복구한 직후.
  임의 시간 임계로 판정하지 않는다 — 그런 기준은 없다. 복구가 필요했다는 사실이 기록 조건이다.
- 통합 검증에서 새 실행 교훈이 확인된 직후

회고할 사건이 없는 phase는 파일을 만들지 않고 phase 보고에 `신규 회고 없음`을 명시한다.

## 파일 형식

```markdown
---
id: RETRO-0001
plan: plan-name
date: YYYY-MM-DD
phase: phase-or-gate
status: 진행 중 | 해결 | 위험 수용
category: 프로세스 | 결함 | 환경 | 미검증 | 범위 외
promotion: 검토 중 | 승격 안 함 | docs/pitfalls/<file> | SKILL.md | AGENTS.md | ADR
---

# 제목

## 관찰
## 원인
## 영향
## 대응
## 검증
## 배운 점
## 후속
```

같은 사건의 해결 결과는 같은 파일 끝에 추가하고 `status`를 갱신한다.
관찰·원인·영향의 과거 기록은 삭제하거나 성공 결과로 덮어쓰지 않는다.

## INDEX 형식

`INDEX.md`는 `ID | 날짜 | plan | 제목 | 상태 | 승격` 표로 관리한다.
새 회고 생성과 상태 변경은 같은 commit에서 INDEX에도 반영한다.

## 승격 규칙

- 회고는 재발 횟수와 무관하게 사건 기록으로 보존한다.
- 반복 가능하고 일반화되는 프로세스 결함은 `SKILL.md` 가드로 승격한다.
- 레포의 축적 기준을 통과한 코드·운영 함정만 `docs/pitfalls`로 승격한다.
- 기술 의사결정의 최종 상태만 ADR로 승격한다.
- 승격 후에도 원본 회고 파일은 삭제하지 않는다.

## 종료 확인

PR body의 `특이사항 및 후속`은 `docs/retrospectives/INDEX.md`와 이번 plan의 회고 파일에서 요약한다.
발생한 reviewer 실패나 복구 사건에 대응하는 회고 파일이 없으면 workflow를 완료로 판정하지 않는다.
