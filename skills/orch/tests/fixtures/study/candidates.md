# 공부 후보

업무 중 사용자가 모르던 개념을 하루 끝에 모아 둔다. 블로그(fos-study)에 쓸지 리뷰한 뒤 `blog-post-writer` 스킬로 쓴다.

- 적는 시점: 사용자가 「오늘 나온 개념 정리하자」 처럼 하루 끝에 요청할 때. 그날 대화에서 사용자가 뜻을 물은 개념을 후보로 보여 주고, 사용자가 고른 것만 적는다(사용자 결정 2026-11-01).
- 적는 방식: 회사 이름, 서비스 이름, 내부 식별자, 대상자 정보는 쓰지 않는다. 일반 기술 개념과 질문으로만 쓴다. 「생긴 곳」 은 내부 맥락 없이 한 줄로 쓴다.
- 상태: `후보` → `리뷰함`(공부할 가치가 있다고 정함, 이유를 적는다) 또는 `뺌`(이유를 적는다) → `글 씀`(블로그 경로를 적는다).
- 리뷰 기준: 다음 일에서 같은 질문이 다시 나올 만한가, 공식 문서로 근거를 댈 수 있는가, fos-study 에 이미 같은 글이 없는가.

| 주제 | 질문 | 생긴 곳 | 참고 | 상태 |
| --- | --- | --- | --- | --- |
| S3 호환 저장소의 키 구조와 MinIO 의 파일 이름 길이 한도 | 객체 키의 `/` 한 칸이 왜 255바이트를 넘으면 안 되는가, MinIO 는 ext4 에 객체를 어떻게 저장하는가 | 관측 기록이 저장소 업로드에서 버려진 문제 | MinIO 문서(Object naming), ext4 NAME_MAX | 후보 |
| 관측 플랫폼의 수집 구조(이벤트를 객체 저장소에 먼저 쓰고 worker 가 분석 DB 에 넣기) | 왜 바로 DB 에 쓰지 않고 저장소를 거치는가, web 과 worker 가 같은 설정을 써야 하는 이유 | 같은 문제 | Langfuse self-hosting 문서 | 후보 |
| ClickHouse 쿼리 메모리 한도 | 큰 칼럼을 읽는 조회가 왜 메모리 초과로 실패하고, 목록 API 와 상세 API 의 차이는 무엇인가 | 비용 조회 422 | ClickHouse 문서(max_memory_usage) | 후보 |
| HikariCP 지표로 연결 풀 크기 정하기 | active, pending, acquire, usage 지표를 어떻게 읽고 동시 실행 수와 풀 크기를 어떻게 맞추는가 | 원시 DB 연결 풀 측정 | HikariCP 위키(About Pool Sizing), Micrometer 지표 | 후보 |
| TimescaleDB 연속 집계와 백분위 근사 | continuous aggregate 와 toolkit `approx_percentile`(sketch)의 오차가 표본 수에 따라 왜 달라지는가 | 시계열 view 로 집계 옮기기 설계 | TimescaleDB 문서(continuous aggregates, hyperfunctions) | 후보 |
| shadow 비교 배포 | 새 경로를 옆에서 같이 돌려 결과만 대조하는 방식은 언제 쓰고 언제 끝내는가 | 설정 원천을 파일에서 DB 로 옮긴 일 | 「dark launch」, 「parallel run」 사례 글 | 후보 |
| 여러 서버에서 한 번만 실행하기 | ShedLock 같은 분산 잠금과 선점 테이블은 각각 무엇을 막는가 | 회차 알림 중복 방지 | ShedLock README | 후보 |
| 무중단 배포의 DB 변경 두 단계(expand/contract) | 서버를 한 대씩 바꿀 때 칼럼 삭제를 다음 배포로 미루는 이유 | 설정 칸 삭제 순서 규칙 | 「parallel change」(Martin Fowler) | 후보 |
