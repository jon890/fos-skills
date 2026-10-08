# mac-cleanup

macOS 개발 머신의 디스크, 메모리, 스왑을 조사해 정리하고, 오래된 에이전트 세션과 머지된 브랜치, 끝난 워크트리까지 정리한다.

## 산출물

| 산출물 | 내용 |
| --- | --- |
| 조사 결과 | 디스크, 메모리, 스왑, 큰 디렉터리, Docker, 도구 캐시, 세션, 브랜치, 워크트리, Gradle 버전 |
| 후보 표 | 후보마다 크기와 등급(안전 / 확인 필요 / 유지) |
| 정리 전후 표 | 디스크 여유, 스왑 사용량, 메모리 여유 비율과 사용자가 직접 할 일 |

## 구성

- `scripts/survey_*.sh`, `scripts/survey_*.py`, `scripts/docker_images.py`: 읽기 전용 조사. 지우거나 종료하지 않는다.
- `references/targets.md`: 정리 후보의 등급과 명령
- `references/git-and-sessions.md`: 세션, 브랜치, 워크트리 정리 절차
- `tests/`: 파싱과 분류 함수의 단위 테스트

```bash
python3 -m unittest discover -s mac-cleanup/tests
```

하네스 지침 정리는 `harness-cleanup` 이 맡는다.
