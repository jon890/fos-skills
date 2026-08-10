# Task 생성 가이드

AI 에이전트가 구현 task 를 생성할 때 따르는 일반 규칙이다. `/planning` 후 또는 단순 task 생성 시 참조.
레포별 검증 명령, 레이어 구조, 반복 함정 목록의 경로는 레포 오버레이(`<repo>/.claude/planning-overlay.md`)가 채운다.

## 디렉터리 구조

```
tasks/
  plan{N}-{kebab-slug}/
    index.json        # task 메타데이터 + phase 목록
    phase-01.md       # phase 1 프롬프트 (executor 에게 전달되는 실행 지시)
    phase-02.md
    ...
```

`plan{N}` 의 N 은 다음 가용 번호 (SKILL.md "동시성 안전" 의 번호 선점 참조).

## index.json 스키마

```jsonc
{
  "name": "plan{N}-{kebab-slug}",       // 디렉터리명과 일치
  "description": "한 줄 요약 — 무엇을 / 왜",
  "status": "pending",                    // pending | in_progress | completed | failed
  "created_at": "2026-01-01",             // YYYY-MM-DD
  "total_phases": 3,                      // phases 배열 길이와 일치
  "current_phases": 1,
  "phases": [
    {
      "number": 1,
      "file": "phase-01.md",
      "execution_profile": "standard"     // fast | standard | deep
    }
  ]
}
```

**phase 파일과 `phases` 배열은 같은 commit 으로 함께 바꾼다.**
task 를 만들 때만이 아니라 실행 중 phase 를 추가·제거·재작성할 때도 적용한다
(build-with-teams 가 critic REVISE 를 받아 계획을 고치는 경우가 여기 해당한다).
phase 파일만 늘리면 파이프라인이 `phases` 를 읽어 순회하므로 새 phase 를 인식하지 못하고 그 작업이 통째로 빠진다.

### 검증 체크리스트

- [ ] `total_phases` == `phases` 배열 길이
- [ ] 모든 phase 에 `number` / `title` / `file` / `execution_profile` 존재
- [ ] `number` 가 1 부터 순차 증가
- [ ] 각 `file` 에 해당하는 `.md` 파일이 실제로 존재
- [ ] `name` 이 `tasks/{name}/` 디렉터리명과 일치
- [ ] 7단계에서 영향을 받는 필수 문서를 실제로 갱신했고 문서 diff를 검증함

---

## ADR 구조 템플릿

기술 결정을 ADR 로 남길 때 쓴다. 이 뼈대가 단일 소스이고, 레포 오버레이는 **채워진 예시가 될 실제 ADR 을 지목**한다 — 뼈대를 오버레이마다 복제하면 어긋난다.

```markdown
## ADR-XXX: {제목 — 결정의 한 줄 요약}

- **결정**: {무엇을 — 1~3문장}
- **맥락**: {왜 이 결정이 필요했는가 — 제약·데이터·관찰}
- (조건부) **대체된 부분**: {이 ADR 의 어느 결정이 어느 ADR 에 뒤집혔는가 — 링크 포함}
- **대안 기각**: {다른 옵션을 왜 선택하지 않았는가 — 각 대안 1~2줄}
- (선택) **트레이드오프**, **적용 범위**
```

- `대체된 부분` 은 기존 ADR 의 일부만 뒤집혔을 때 그 ADR 에 추가하고 **결정 바로 아래**에 둔다. 결정만 읽고 지나가는 독자가 낡은 결론을 얻는 것을 막는 것이 목적이라, 문서 끝이나 대안 기각 안에 넣으면 의미가 없다.
- 대체한 쪽 ADR 에서도 원본을 링크해 양방향으로 찾을 수 있게 한다.
- 결정 **전체**가 번복될 때만 과거 ADR 을 지운다. 일부만 뒤집혔는데 지우면 살아 있는 근거까지 사라진다.
- 넣지 않는 것: 10줄 넘는 코드 블록(1~3줄 식별자 예시만), 파일 경로 3개 이상 나열, 구현 호출 방법, 작업 내역, 스택 규칙 반복.

자명성 판단과 문서 갱신 절차는 `references/step-7-docs.md` 를 따른다.

## 실행 등급 라우팅

task는 특정 모델 공급자 이름을 저장하지 않는다.
실행 surface가 `execution_profile`을 설치된 모델·role에 매핑한다.


| 실행 등급      | 용도                                                |
| ---------- | ------------------------------------------------- |
| `fast`     | 기계적 수정, 빌드 검증, 잔재 정리                              |
| `standard` | 표준 구현, 다중 파일 수정, rename, 리팩토링, 신규 컴포넌트, migration |
| `deep`     | 새 아키텍처 설계, 복잡 알고리즘, 장기 trade-off 판단               |


---

## phase 파일 작성 규칙

### 핵심 원칙

1. **자기완결적** — 각 phase 프롬프트는 이전 대화 컨텍스트 없이 독립 실행. 필요한 모든 맥락을 프롬프트 안에 포함.
2. **단일 책임** — 한 phase 는 명확히 하나의 작업 단위. 
3. **검증 가능** — phase 마지막에 실행 가능한 성공 기준 명시 (grep / test / build). 구체 명령은 레포 도구에 맞춘다.

### phase 파일 구조

```markdown
# Phase NN — {제목}

**Execution profile**: standard

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
- [ ] 오버레이가 지정한 반복 함정 목록의 패턴을 모두 사전 확인
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

스킬 설치 경로가 다르면 그 경로의 `scripts/verify-task.sh` 를 쓴다.

스크립트가 검출하는 5 패턴 (task 위생 공통 검사):

- **범위 불명확** — '전체 수정/변경/적용/…' 표현. 구체 파일 목록으로 대체한다.
- **cwd 주석 누락** — Bash 블록 앞에 `# cwd:` 가 없다.
- **사람 의존 검증** — '수동 검토'·'눈으로 확인'·'육안' 등. 
- **완료 마킹 누락** — 마지막 phase 에 `index.json` 완료 마킹 지시가 없다.
- **BSD sed `\b` 미지원** — macOS 에서 조용히 실패한다. `perl -i -pe 's/\bfoo\b/.../g'` 로 대체한다.
