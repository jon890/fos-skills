# ADR-027: 코디네이터 깨우기는 Orca 메시지를 쓴다

- **status**: `accepted`
- **decision-type**: `architecture`
- **결정**: worker 질문·보고와 루프 알림은 Orca 메시지로 코디네이터를 깨운다. 자체 대기, 알림 파일, 터미널 직접 입력을 없앤다.
- **현재 원본**: [기능 스펙](../features/orch-lib-layers/spec.md), [기술 설계](../features/orch-lib-layers/design.md), [기다리기 절차](../../skills/orch/references/waiting.md).
- **맥락**: 자체 대기가 메일을 먼저 읽음 처리하면 Orca 가 깨울 메시지가 사라졌다. 사용자가 대화 중인지 따지는 규칙은 루프 알림만 미뤄 질문 처리도 늦췄다. 실제 Orca 메시지로 쉬는 코디네이터가 깨어나는 것을 설계 단계에서 확인했다.
- **기각한 대안**: peek 대기를 계속 두면 별도 프로세스 생존과 재시작을 관리해야 한다. 터미널 입력은 화면·입력란 상태에 기대고, 메시지와 깨우기 경로가 둘로 나뉜다.
- **감당할 비용**: 루프 감시 경고는 한 틱 늦을 수 있다. 보내지 못한 알림은 상태를 진행하지 않고 다음 틱이 다시 시도한다. 완료는 코디네이터가 MERGED 를 확인하고 루프 경고는 안전망으로 쓴다.
- **대체 관계**: [ADR-012](012-orch-loop-multi-run.md)의 Run 별 알림 파일·커서 부분과 [ADR-013](013-orch-worker-stalled.md)의 터미널 직접 입력 부분을 대체한다. 저장소별 루프·Run 등록과 worker-stalled 핸들러 계약은 유지한다.
