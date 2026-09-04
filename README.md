# fos-skills

여러 레포가 공유하는 공용 Claude Code 스킬의 단일 소스다.

워크플로 개선은 여기 한 곳만 고치면 심링크로 연결된 전 프로젝트에 반영된다.
레포마다 다른 부분은 각 프로젝트의 오버레이 파일로 주입한다.

## 스킬 목록

**여기에 두는 것은 반복해서 쓰는 스킬이다.**
쓰임이 굳지 않은 스킬은 `~/.claude/skills/` 에만 두고, 여러 번 써서 절차가 자리를 잡은 뒤에 옮긴다.

| 스킬 | 목표 |
| --- | --- |
| [`build-with-teams`](build-with-teams/README.md) | planning 이 만든 task 를 읽어 plan 하나를 구현까지 끝낸다 |
| [`content-preview`](content-preview/README.md) | 외부에 게시하거나 등록할 본문을 등록 전에 렌더링해 사용자에게 보여준다 |
| [`docs-check`](docs-check/README.md) | 저장소 문서가 코드와 맞는지 감사하고, 사용자 승인을 받아 고친다 |
| [`harness-cleanup`](harness-cleanup/README.md) | 하네스 지침이 현재 설정과 실행 결과에 맞는지 감사하고, 사용자 승인을 받아 고친다 |
| [`planning`](planning/README.md) | 사용자와 합의한 것을 `docs/` 에 남기고, 그것만 읽고 구현할 수 있는 `tasks/` 를 만든다 |
| [`review-fix`](review-fix/README.md) | PR 에 이미 달린 리뷰를 읽고 코드에 반영한다 |

## 공용 도구

`tools/` 에는 스킬이 아닌 공용 도구를 둔다.
스킬 하나가 소유하기에는 다른 스킬도 쓰고, 전역에 두기에는 이 저장소가 관리해야 하는 것이다.

| 도구 | 하는 일 | 쓰는 스킬 |
| --- | --- | --- |
| `tools/browser-driver` | 브라우저 백엔드가 달라도 같은 명령으로 조작한다. 실패를 종료 코드로 드러낸다 | `content-preview` |

스킬은 이 도구를 저장소 안에서 찾고, 없으면 개인이 걸어 둔 것으로 내려간다.

## 설치

각 코어 스킬을 글로벌 스킬 디렉터리에 심링크한다. 그러면 모든 프로젝트에서 사용할 수 있다.

```bash
ln -sfn ~/personal/fos-skills/planning ~/.claude/skills/planning
```

공용 도구를 전역에서도 부르려면 함께 건다.

```bash
ln -sfn ~/personal/fos-skills/tools/browser-driver/browser_driver.py ~/.claude/scripts/browser-driver
```

## 코어와 오버레이

- **코어** (이 레포): 도메인 중립 워크플로다. 단계 뼈대, 핵심 원칙, 검증기가 여기 있다.
- **오버레이** (각 프로젝트의 `.claude/planning-overlay.md`): 레포 특화다. 도메인 단계 변형, docs 컨벤션, 검증 경로, 실행 핸드오프 명령이 여기 있다.

코어 SKILL 이 시작할 때 현재 레포의 오버레이를 읽어 채운다.
오버레이가 없으면 코어 기본값으로 동작한다.

## 버전과 변경 이력

각 스킬은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 디렉터리의 `CHANGELOG.md` 로 이력을 남긴다.

**이 버전은 배포 핀이 아니다.** 소비 방식이 심링크라 모든 프로젝트가 항상 최신을 쓴다.
특정 버전에 고정할 수단이 없으므로, 버전의 목적은 무엇이 언제 왜 바뀌었는지 추적하는 것뿐이다.
이 점을 잊으면 태그와 릴리스까지 붙는 과설계로 간다.

올리는 기준은 셋이다.

| 등급 | 언제 | 예 |
| --- | --- | --- |
| major | 워크플로 단계가 바뀌어 기존 오버레이나 task 형식과 안 맞는다 | 단계 수를 8에서 6으로 줄인다 |
| minor | 지시를 추가하거나 제거한다 | 스폰 폴백 단계화를 넣는다 |
| patch | 문구만 다듬는다 | 표현을 고치고 오타를 바로잡는다 |

규칙 두 가지를 지킨다.

- 저장소 루트에는 CHANGELOG 를 두지 않는다. 갱신 지점이 갈려 한쪽이 먼저 낡는다.
- git 태그는 만들지 않는다. 심링크 소비에서는 태그가 아무것도 고정하지 못한다.
