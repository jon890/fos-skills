# Phase 02. 공통 틀과 세 구성

**Execution profile**: standard

## 목표

모든 보고서가 같은 모양을 갖도록 공통 CSS 와 부품을 담은 `report/assets/template.html` 과, 내용 종류별 절 순서를 정한 `report/references/layouts.md` 를 만든다(R4, R5, R6).

**범위 외**: 검사 스크립트(phase 01), SKILL.md 와 플러그인 등록(phase 03).

## 컨텍스트

- 스펙: `docs/features/report/spec.md` 의 R4, R5, R6, D4, D9, D10.
- 틀의 출발점은 `/Users/kbt/personal/fos-assistant/.omc/previews/agent-memory-report.html` 의 구성과 CSS 다. 저장소 밖 파일이라 구현자의 머신에만 있다. 그 파일의 내용(메모리 조사)은 옮기지 않고, 예시는 짧은 가짜 내용으로 쓴다.
- 본보기에서 가져올 것: 색 변수(`--accent` 등), 고정 목차(`nav.toc`), 머리(`header.top` 의 날짜, 제목, `.lead`), 결론 카드(`.concl`), 표 감싸개(`.tw`)와 상태 칩(`.chip.y/.p/.n/.x`)과 범례(`.legend`), 강조 상자(`.callout`), 용어 상자(`aside.gloss`), 접는 절(`details`), 모두 펼치기 버튼(`.bar`), 출처 표(`#srcbox`, `tr id="src-..."`), 좁은 화면 `@media`, 인쇄 `@media print`, 출처 링크를 누르면 출처 상자를 여는 스크립트.
- 본보기에 없는 단계 목록은 새로 만든다(`ol.steps`, 번호 원을 CSS counter 로 그린다).

**근거 문서**: `docs/features/report/spec.md` 의 「요구사항과 인수 조건」 R4, R5, R6 과 「결정」 D4, D9, D10

## 의도 메모

- 외부 글꼴을 쓰지 않는다. 시스템 글꼴 목록만 둔다(R2). presentation 의 Google Fonts 처럼 망이 없을 때 모양이 바뀌는 일을 피한다.
- 틀 하나에 모든 부품 예시를 넣고, 구성 문서는 절 순서와 어떤 부품을 쓰는지만 적는다. CSS 를 두 곳에 두지 않는다.
- 예시 내용은 「캐시 만료 정책」 같은 짧은 가짜 주제로 쓰고, 각주 두세 개만 둔다.

## 작업 항목

### 1. `report/assets/template.html`

- `<!DOCTYPE html>`, `lang="ko"`, `<meta charset>` 과 viewport, `<title>`.
- `<style>` 하나에 본보기의 CSS 를 옮기고, 본보기 전용 클래스(`table.cmp` 의 최소 폭 등)는 일반 이름으로 정리한다. 단계 목록 `ol.steps` 를 더한다.
- 부품 예시를 모두 한 번씩 둔다: 목차, 머리, 결론 카드, 비교표와 칩과 범례, 단계 목록, 강조 상자, 용어 상자, 접는 절과 모두 펼치기, 확인하지 못한 것 목록, 출처 각주 표, footer.
- 각 부품 앞에 `<!-- 부품: 이름. 쓰는 법 한 줄 -->` 주석을 단다.
- `<script>` 는 인라인 하나. 출처 링크(`a.ref`)를 누르면 `#srcbox` 를 열고, `.bar` 버튼이 있으면 같은 절의 `details` 를 모두 열고 닫는다. 버튼이 없어도 오류가 나지 않게 한다.

### 2. `report/references/layouts.md`

세 구성 각각에 「언제 고르나」, 「절 순서」 표(절, 쓰는 부품, 담는 것), 그리고 애매할 때 고르는 기준을 적는다.

- 조사 보고서: 핵심 결론 → 한눈 비교 → 항목별 상세(접는 절) → 확인하지 못한 것 → 출처.
- 개념 설명: 한 줄 결론(무엇이고 왜 쓰나) → 동작 단계 → 백엔드 비유(용어 상자) → 주의할 점 → 상세(접는 절) → 출처.
- 비교·결정 자료: 권장안 → 선택지 비교표 → 선택지별 장단점(접는 절) → 결정 기준 → 남은 질문 → 출처.
- 공통 규칙: 결론이 첫 화면에 있다. 단락은 2~3문장, 비교는 표다. 원문이 길면 본문은 줄인 글과 표로, 원문 상세는 접는 절에 빠짐없이 둔다. 원문의 사실, 수치, 날짜, 출처, 「추정」 표시는 그대로 둔다(R6).
- 애매하면 묻지 않고 가장 가까운 구성을 고른다(D7).

### 3. 틀을 검증하는 테스트를 `report/tests/test_check_report.py` 에 더한다

`report/assets/template.html` 을 임시 폴더에 `template-sample.html` 로 복사해 `check-report.py` 로 검사하면 종료 코드 0 이다. 틀이 R2, R7 을 스스로 지키는지 본다.
틀에 R4 의 부품 표지(`class="toc"`, `class="top"`, `class="lead"`, `class="concl"`, 칩 네 가지, `class="steps"`, `class="callout"`, `<details`, `id="srcbox"`, `class="ref"`)가 모두 있는지, `--korean` 으로 틀의 예시 글이 금지어 검사를 통과하는지도 본다.

## 검증

```bash
python3 -m unittest discover -s report/tests
python3 korean-check/scripts/korean-style-check.py report/references/layouts.md
```

기대값: 테스트 통과, 금지어 검사 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `report/assets/template.html` | 신규 |
| `report/references/layouts.md` | 신규 |
| `report/tests/test_check_report.py` | 수정 |
