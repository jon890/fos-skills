모델 사용 기록의 토큰을 worker 세션 기록에서 먼저 읽고, 못 읽으면 `tokens_source` 에 이유를 남긴다. Orca 사용량 파일은 dispatch 시작보다 새로울 때만 쓴다.
