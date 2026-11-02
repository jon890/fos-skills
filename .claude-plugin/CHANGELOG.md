# CHANGELOG: fos-skills 플러그인

버전은 `plugin.json` 의 `version` 과 같다. main 에 머지될 때마다 `.github/workflows/plugin-version.yml` 이 올리고 한 줄을 더한다. 사람이 고치지 않는다.
등급은 그 머지에서 바뀐 스킬 CHANGELOG 로 정한다. `호환성:` 항목이 있으면 major, 새 버전 절이 있으면 minor, 그 밖은 patch 다.
규칙과 근거는 [ADR-019](../docs/adr/019-plugin-version-auto-bump.md) 가 소유한다.

## 1.6.0 (2026-11-02)

- work-board 1.7.1 (#294)

## 1.5.0 (2026-11-02)

- orch 5.17.0 (#292)

## 1.4.0 (2026-11-02)

- work-board 1.7.0 (#291)

## 1.3.0 (2026-11-02)

- inbox 1.1.0 (#290)

## 1.2.0 (2026-11-02)

- inbox 1.0.1, work-board 1.6.0 (#289)

## 1.1.0 (2026-11-02)

- orch 5.16.0 (#288)

## 1.0.0 (2026-11-02)

- 플러그인 version 을 두기 시작했다. 이전 설치본은 커밋 SHA 12자리로 구분했다
