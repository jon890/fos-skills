# Task 생성 가이드

AI 에이전트가 구현 task 를 생성할 때 따르는 일반 규칙이다. `/planning` 후 또는 단순 task 생성 시 참조.
레포별 검증 명령·레이어 구조·common-pitfalls 경로는 레포 오버레이(`<repo>/.claude/planning-overlay.md`)가 채운다.

## 디렉터리 구조

```
tasks/
  plan{N}-{kebab-slug}/
    index.json        # task 메타데이터 + phase 목록
    phase-01.md       # phase 1 프롬프트 (executor 에게 전달되는 실행 지시)
    phase-02.md
    ...
```

`plan{N}` 의 N 은 다음 가용 번호 (SKILL.md "plan 네이밍 규칙" 의 번호 충돌 방지 참조).

## index.json 스키마

```jsonc
{
  "name": "plan{N}-{kebab-slug}",       // 디렉터리명과 일치
  "description": "한 줄 요약 — 무엇을 / 왜",
  "status": "pending",                    // pending | in_progress | completed | failed
  "created_at": "2026-01-01",             // YYYY-MM-DD
  "total_phases": 3,                      // phases 배열 길이와 일치
  "phases": [
    {
      "number": 1,
      "file": "phase-01.md",
      "title": "phase 제목 (간결)",
      "execution_profile": "standard",     // fast | standard | deep
      "status": "pending"
    }
  ]
}
```

### 검증 체크리스트

- [ ] `total_phases` == `phases` 배열 길이
- [ ] 모든 phase 에 `number` / `title` / `file` / `execution_profile` / `status` 존재
- [ ] `number` 가 1 부터 순차 증가
- [ ] 각 `file` 에 해당하는 `.md` 파일이 실제로 존재
- [ ] `name` 이 `tasks/{name}/` 디렉터리명과 일치
- [ ] 7단계에서 영향을 받는 필수 문서를 실제로 갱신했고 문서 diff를 검증함

---

## 실행 등급 라우팅

task는 특정 모델 공급자 이름을 저장하지 않는다.
실행 surface가 `execution_profile`을 설치된 모델·role에 매핑한다.

| 실행 등급 | 용도 |
|---|---|
| `fast` | 기계적 수정, 빌드 검증, 잔재 정리 |
| `standard` | 표준 구현, 다중 파일 수정, rename, 리팩토링, 신규 컴포넌트, migration |
| `deep` | 새 아키텍처 설계, 복잡 알고리즘, 장기 trade-off 판단 |

기계적 작업은 `deep`을 사용하지 않는다.
rename, 이동, 경로 수정은 파일 수와 무관하게 `standard`면 충분하다.

legacy task의 `model`은 read 시에만 다음처럼 해석한다.

- `haiku` → `fast`
- `sonnet` → `standard`
- `opus` → `deep`

신규 task와 수정 task는 legacy `model`을 새로 쓰지 않는다.
한 phase에 `execution_profile`과 `model`이 함께 있으면 해석하지 않고 schema 오류로 차단한다.

---

## phase 파일 작성 규칙

### 핵심 원칙

1. **자기완결적** — 각 phase 프롬프트는 이전 대화 컨텍스트 없이 독립 실행. 필요한 모든 맥락을 프롬프트 안에 포함.
2. **단일 책임** — 한 phase 는 명확히 하나의 작업 단위. 작업 항목 5개 이하.
3. **검증 가능** — phase 마지막에 실행 가능한 성공 기준 명시 (grep / test / build). 구체 명령은 레포 도구에 맞춘다.

### phase 파일 구조

```markdown
# Phase NN — {제목}

**Execution profile**: standard
**Status**: pending

---

## 목표

이 phase 에서 구현해야 할 것을 명확히 기술. 왜 필요한지 한 문장.

**범위 외**: 다른 phase 또는 다른 plan 의 책임을 명시 (혼동 방지).

---

## 작업 항목 (N)

### 1. {파일/모듈} — 변경 요약

구체적 변경 — 함수 시그니처, 타입, 셀렉터, 이름 등. 기존 패턴 참조 경로.

---

## Critical Files

| 파일 | 변경 |
|---|---|
| `...` | 신규 / 수정 / 삭제 |

## 검증

실행 가능한 성공 기준 — 레포의 lint/type/test/build 명령 + 구체 grep 기준.

## 의도 메모 (왜)

- 결정의 근거 — 다른 옵션을 기각한 이유
- 이 phase 가 다음 plan 의 어떤 부분을 막아주는가

## Blocked 조건 (선택)

- 외부 의존성 부재 → `PHASE_BLOCKED: {이유}` 출력 후 종료
```

### phase 작성 시 self-check

- [ ] 자기완결 — 이전 phase 대화 없이 읽어도 무엇을 해야 할지 명확
- [ ] 작업 항목 5개 이하
- [ ] 함수/컴포넌트의 이름·파라미터·반환 타입이 구체적
- [ ] 이전 phase 산출물 참조 시 경로 명시
- [ ] 성공 기준에 실행 가능한 명령과 기대값 명시
- [ ] 오버레이가 지정한 common-pitfalls 패턴 모두 사전 해소

---

## task 검증 (생성 직후)

task 파일 작성 직후, 사용자 보고와 git commit 전에 실행한다.
AI 가 임의로 자동 수정하지 않고, 위반은 질문 도구로 확인받는다 — 의도 보존 우선.

### 자동 검출 5 패턴

아래 스크립트를 실행한다. 위반 라인을 stdout 으로 출력하며, 출력이 0 줄이면 통과.

```bash
# cwd: <타깃 레포 root> — tasks/ 를 상대참조하므로 cwd 는 레포 루트여야 한다
~/.claude/skills/planning/scripts/verify-task.sh plan{N}-{slug}
```

스크립트는 타깃 레포가 아니라 **스킬 디렉터리**에 있다. 두 경로를 헷갈리면 실행되지 않는다.
스킬 설치 경로가 다르면 그 경로의 `scripts/verify-task.sh` 를 쓴다.

스크립트가 검출하는 5 패턴 (task 위생 공통 검사):

- **1-2** — '전체 수정/변경/적용/…' 표현 (파일 범위 부정확). 구체 파일 목록으로 대체.
- **1-4** — Bash 블록의 `# cwd:` 주석 누락.
- **1-5** — 인간 의존 검증 ('수동 검토'·'눈으로 확인'·'육안' 등). "수동 smoke" 는 동작 확인이라 제외.
- **1-8** — 마지막 phase 에 `index.json` completed 마킹 지시 누락.
- **1-9** — macOS BSD sed `\b` 미지원. 발견 시 `perl -i -pe 's/\bfoo\b/.../g'` 로 대체.

출력 1줄이라도 나오면 아래 흐름. (레포가 추가 패턴을 오버레이로 정의할 수 있다.)

### 위반 발견 시 처리 (사용자 confirm 우선)

위반된 패턴과 위치를 정리해 질문 도구 호출:

- 옵션 1: **수정** — 위반 라인을 패턴별 권장 대안으로 교체 후 `verify-task.sh` 재실행 (재귀, 최대 2회)
- 옵션 2: **skip** — 이번 위반은 의도된 표현. 실행/critic 단계에서 다시 판단
- 옵션 3: **면제** — 본 plan 한정 면제 사유를 phase 파일 "의도 메모 (왜)" 에 명시 후 통과

### 사람 판단 필요 4 패턴 (자동 검출 불가)

도메인 의존이라 grep 검출 불가. task 작성 시 사람 (AI) 이 직접 self-check.

- **1-1 수치 추측**: "약 30개" / "100줄" 같은 수치가 실측 명령 결과인지 확인. `git diff --stat` 등 실측 명령을 plan 에 인용.
- **1-3 이전 plan / main 커밋 상호작용**: `git log origin/main --oneline -20 -- <scope>/` 결과 중 plan 범위와 겹치는 변경이 있는지, 있다면 "어느 쪽이 final" 명시.
- **1-6 외부 상태 gate**: PR / 배포 / push 단계 앞에 상태 확인 명령이 있는지.
- **1-7 4면 가드**: load-bearing 불변식 도입 시 관련 계층(예: Migration/Repository/Mapper/UI) 모두 가드 명시.

### 자체 검토 (제출 전 새로운 눈으로)

위 자동검증·critic pitfalls 와 별개로, task 전체를 새로운 눈으로 한 번 훑는다.

1. **placeholder 스캔**: `TBD` / `TODO` / '나중에' / 빈 섹션이 남아 있나. 있으면 채운다.
2. **모순 스캔**: phase 간·docs 간 상충하는 서술이 없나.
3. **식별자 일관성**: 앞 phase 에서 정한 이름을 뒤 phase 가 똑같이 쓰나. `clearLayers()` vs `clearFullLayers()` 같은 불일치는 버그다.

발견 즉시 인라인 수정.

---

## 마지막 phase 표준 (권장)

소규모 plan (1~2 phase) 은 검증을 본 phase 에 흡수. 중규모 이상 (3+ phase) 은 마지막 phase 를 검증 전용으로 분리:

| Phase | 제목 | 모델 | 내용 |
|---|---|---|---|
| 마지막 | 통합 검증과 잔재 grep | `fast` | 레포의 lint/type/build/test, 잔재 grep, dead code 정리 |

마지막 phase 에 **`index.json` 의 status="completed" 마킹** 명시.

---

## Phase 묶기 vs 분리 기준

**묶기**: 동일 패턴 복제 / 동일 스키마 확장 / 동일 기능의 다른 영역 확장.

**별도 phase 로 분리**: 서로 다른 도메인 / 독립 실행 가능하고 의존 없음 / 검증 단위가 다름.

## 별도 plan 으로 분리 vs 같은 plan 의 phase 분리

같은 plan 의 phase: 하나의 원자적 목표를 완성하기 위한 순차 작업. PR 1개로 묶임.

별도 plan: 독립적인 완료·검토·검증 기준을 가짐. plan별 PR로 분리하고 실행 순서는 사용자 보고로 전달함.

다음 중 하나라도 해당하면 별도 plan 분할을 우선한다.

- 서로 다른 변경 이유나 도메인 경계를 가진다.
- DB·저장 계약, backend API, frontend 연결, skill·tooling처럼 독립된 검토 초점이 있다.
- 일부만 먼저 병합해도 기존 동작을 깨지 않고 가치를 제공한다.
- 예상 변경이 SKILL.md 규모 분할 점검의 경고선을 넘는다.

한 plan을 여러 PR로 나누거나 여러 plan을 한 PR에 합치지 않는다.

---

## 참조

- 레포 오버레이 `<repo>/.claude/planning-overlay.md` — common-pitfalls 경로, 레이어별 phase 가이드, 검증 명령
- SKILL.md — 8단계 워크플로와 plan 네이밍
