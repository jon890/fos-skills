# fos-skills

여러 레포가 공유하는 공용 Claude Code 스킬의 단일 소스.

워크플로 개선은 여기 한 곳만 고치면 심링크로 연결된 전 프로젝트에 반영된다.
레포마다 다른 부분은 각 프로젝트의 오버레이 파일로 주입한다.

## 구조

```
fos-skills/
  planning/                 # 구현 전 8단계 설계 워크플로 (공용 코어)
    SKILL.md
    task-create.md
    scripts/verify-task.sh
```

## 설치 (글로벌 심링크)

각 코어 스킬을 글로벌 스킬 디렉터리에 심링크한다. 그러면 모든 프로젝트에서 사용 가능하다.

```bash
ln -sfn ~/personal/fos-skills/planning ~/.claude/skills/planning
```

## 코어 vs 오버레이

- **코어** (이 레포): 도메인 중립 워크플로 — 단계 뼈대, 핵심 원칙, 검증기.
- **오버레이** (각 프로젝트의 `.claude/planning-overlay.md`): 레포 특화 — 도메인 단계 변형, docs 컨벤션, 검증 경로, 실행 핸드오프 명령.

코어 SKILL 이 시작 시 현재 레포의 오버레이를 읽어 채운다. 오버레이가 없으면 코어 기본값으로 동작한다.

## 스킬 목록

| 스킬 | 역할 |
|---|---|
| `planning` | 새 기능·변경 구현 전 8단계 설계 → docs 정비 → task 생성 |

## 주의: 글로벌 override 와 work 레포 공존 (landmine)

Claude Code 는 같은 이름의 스킬이 겹치면 **personal(글로벌 `~/.claude/skills`)이 project(`<repo>/.claude/skills`)를 override** 한다 (공식 문서 skills.md line 112: "personal overrides project").

즉 이 글로벌 `planning` 코어는 **자체 in-repo `planning` 스킬을 가진 다른 레포를 내 로컬 머신에서 가린다.** 현재 그런 레포:

- 회사 work 레포 — `OCR.API`, `ai-playground-docu-parser`, `cv.ocr.general_inf`, `webtoon-maker-v1` 등. 각자 특화 planning 을 in-repo 로 유지한다.

영향 범위:

- **내 로컬 머신 한정.** 팀원은 이 글로벌 스킬이 없으니 work 레포의 in-repo planning 을 정상 사용한다.
- 내가 그 work 레포에서 `/planning` 을 부르면 그 레포 특화 대신 이 개인 코어가 뜬다 (오버레이도 없어 도메인 중립으로 동작).

해결 (그 work 레포에서 실제로 `/planning` 이 필요해질 때):

- 그 레포 in-repo planning 을 namespace 로 rename (예: `planning-ocr`) 해 충돌을 없앤다. 단 팀 공용이면 팀원 혼란 주의.
- `skillOverrides: {"planning": "off"}` 는 그 이름을 통째로 숨길 뿐 project 것을 드러내지 못하므로(fallthrough 없음) 차폐용으로 쓰지 않는다.

현재는 work 레포가 planning 을 당장 안 쓰므로 방치(accept)하고, 실사용 시점에 위 방법으로 정리한다.
