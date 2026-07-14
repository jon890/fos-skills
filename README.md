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
