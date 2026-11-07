launch-worker의 비동기 실행과 wait-important의 동기 조회를 호출별로 주입할 수 있게 해 판정 테스트의 반복 기동을 줄인다. spec 명령은 함수로 불러도 CLI를 실행하지 않는다.
launch-worker와 wait-important 테스트에서 기존 상태·출력 단언을 유지하며 동기 가짜 조회와 spec 판정 함수를 호출한다. 비동기 대기·신호·hook·shell 대체 명령과 대표 CLI 대응은 실제 프로세스로 검증한다.
