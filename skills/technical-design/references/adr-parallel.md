# 예시: 병렬 PR 용 ADR 파일과 색인

ADR 을 만들 때, 여러 에이전트나 사람이 같은 저장소에 동시에 PR 을 여는 저장소라면 이 형식을 쓴다.
기본 규칙은 [`adr-rules.md`](adr-rules.md) 이고, 이 예시는 파일 이름과 색인만 다르게 한다.
작업 PR 이 한 번에 하나뿐인 저장소는 기본의 `NNN-<슬러그>.md` 로 충분하다.

## 왜 번호를 쓰지 않는가

`NNN` 은 다음 번호를 각 브랜치가 main 을 보고 미리 고른다.
브랜치 둘이 같은 번호를 고르면 머지 순간에 충돌하고, 한쪽이 번호를 바꾸면 그 ADR 을 가리킨 링크도 함께 고쳐야 한다.

날짜는 브랜치가 혼자 정할 수 있고 합쳐도 바뀌지 않는다.
같은 날의 ADR 은 슬러그가 다르면 구분된다.

## 파일 이름과 머리

```
docs/adr/
  INDEX.md
  ADR-20261007-cache-key-scheme.md
  ADR-20261009-queue-per-tenant.md
  superseded/
    ADR-20261001-shared-queue.md
```

- 파일 이름은 `ADR-YYYYMMDD-slug.md` 다. 날짜는 결정한 날이고 파일 안의 `Date` 와 같다.
- 슬러그는 내용을 나타내는 짧은 소문자 영문, 숫자, 하이픈이다.
- `superseded` 가 되면 [`adr-rules.md`](adr-rules.md) 의 이동 규약에 따라 옮기고 링크를 고친다. 파일 이름과 식별자는 유지한다.
- 머리는 [ADR 양식](../templates/adr.md)과 같은 불릿형이다. 결정, 맥락, 대안 기각, 결과가 한 화면에 들어와야 한다.

```markdown
## ADR-20261007 / cache-key-scheme: 캐시 키에 테넌트 id 를 접두사로 둔다

- **status**: `accepted`
- **Date**: 2026-10-07
- **결정**: 모든 캐시 키를 `{tenantId}:{resource}:{id}` 로 만든다. 키 조립은 `CacheKeys` 한 곳에서만 한다.
- **맥락**: 테넌트 둘이 같은 `resource:id` 를 쓰면 한쪽 캐시가 다른 쪽에 보였다.
- **대안 기각**: 테넌트마다 캐시 인스턴스를 나누면 운영 비용이 테넌트 수에 비례해 기각한다.
- **결과**:
  - 얻는 것: 키 충돌이 구조로 막힌다.
  - 감당할 것: 기존 키는 배포 때 한 번 비워진다.
```

식별자를 가리킬 때는 `ADR-20261007 / cache-key-scheme` 를 링크 글로 쓰고 그 ADR 파일로 링크를 건다.

## INDEX.md

색인 생성을 켠 저장소는 `adr-docs.ts write-index` 가 만든 형식이 원본이다(형식은 검사기 머리 주석). 행을 직접 고치지 않고, 충돌하면 `write-index` 를 다시 돌린다.
아래는 생성을 켜지 않은 저장소의 형식이다.

색인은 ADR 마다 한 행이다. 열은 식별자, 한 줄 요약, status 다. 식별자 칸은 그 ADR 파일로 가는 링크로 쓴다.

```markdown
# ADR 목록

## 현행

| ADR | 요약 | status |
| --- | --- | --- |
| [ADR-20261007 / cache-key-scheme](ADR-20261007-cache-key-scheme.md) | 캐시 키에 테넌트 id 를 접두사로 둔다 | accepted |
| [ADR-20261009 / queue-per-tenant](ADR-20261009-queue-per-tenant.md) | 큐를 테넌트마다 나눈다 | accepted |

## 대체됨

| ADR | 요약 | status |
| --- | --- | --- |
| [ADR-20261001 / shared-queue](superseded/ADR-20261001-shared-queue.md) | 공유 큐를 쓴다 | superseded |
```

- 각 절 안의 정렬은 날짜 오름차순, 같은 날짜는 슬러그 사전순이다. 정렬을 정해 두면 두 PR 이 서로 다른 행을 더해도 같은 줄을 고치지 않는다.
- 색인은 여러 PR 이 함께 고치는 파일이므로 새 행은 정렬 순서의 자리에 한 줄만 더한다. 대체할 때는 해당 행을 옮기고 링크와 status 를 고친다. 그 밖의 기존 행 정리는 같은 PR 에 섞지 않는다.
- 이 파일이 있어도 두 PR 이 같은 위치에 행을 더하면 충돌할 수 있다. 충돌이 나면 실제 ADR 파일과 대조해 합친다.

## 색인 일치 검사

색인과 파일이 어긋나면 링크가 깨지거나 ADR 이 목록에서 빠진다. 저장소마다 테스트를 따로 두지 않고 plan 번들의 `adr-docs.ts check` 가 잡는다.
생성을 켜지 않은 저장소(`--index ids`)에서는 식별자 집합과 링크만 본다. status 일치, 「현행」·「대체됨」 구분, 정렬까지 보증하려면 색인 생성을 켠다.
spec, technical-design, review-fix, docs-audit 가 작성 단계에서 부르므로 CI 에 사본을 두지 않는다.
인자와 판정(날짜 식별자 포함)은 [plan 의 monorepo.md 「ADR 문서 검사」](../../plan/references/monorepo.md#adr-문서-검사)와 검사기 머리 주석이 소유한다.

## 사용자 결정 로그와의 관계

사용자가 정한 취향과 범위를 한 줄씩 남기는 결정 로그(`DECISIONS.md` 같은 표)를 따로 두는 저장소가 있다.
짧은 기록은 그 표에 두고, 이유와 기각한 대안이 필요한 장기 결정만 ADR 로 옮긴 뒤 표의 행에서 ADR 을 가리킨다.
같은 결정을 두 곳에 풀어 쓰지 않는다.
ADR 을 남길지는 [`adr-rules.md`](adr-rules.md#남길-조건) 의 「남길 조건」 으로 판단한다.
