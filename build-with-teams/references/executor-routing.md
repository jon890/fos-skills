# executor 적합성 점검

`SKILL.md` "executor 실행 형태 점검"과 5·6단계가 가리키는 참조 문서다.
저비용 실행 경로는 작업이 명확하다는 것이 증명된 경우에만 사용한다.
적합성을 증명하지 못하면 더 엄격한 실행 형태를 선택한다.
이를 통해 비용 절감이 품질 하락으로 이어지지 않게 한다.

## 실행 형태

| 실행 형태 | 의미 |
|---|---|
| `BOUNDED` | 실행 명세가 닫혀 있어 새로운 판단 없이 구현·검증할 수 있다. |
| `JUDGMENT_REQUIRED` | 일반적인 기술 판단이 필요하지만 설계나 데이터 위험은 높지 않다. |
| `HIGH_RISK` | 새 설계, 보안, 데이터, 호환성 등 실패 비용이 큰 판단이 필요하다. |

더 엄격한 판정이 항상 우선한다.

- `BOUNDED`와 `JUDGMENT_REQUIRED`가 충돌하면 `JUDGMENT_REQUIRED`를 선택한다.
- `JUDGMENT_REQUIRED`와 `HIGH_RISK`가 충돌하면 `HIGH_RISK`를 선택한다.
- 판정이 누락되거나 근거가 부족하면 `JUDGMENT_REQUIRED` 이상을 선택한다.
- `execution_profile: deep`이면 `HIGH_RISK`를 선택한다.

`fast`와 `standard`는 아래 적합성 점검을 모두 통과해야 `BOUNDED`가 될 수 있다.

## `BOUNDED` 적합성 점검

다음 조건을 모두 만족해야 한다.

- critic이 전체 계획을 `APPROVE`했다.
- phase에 목표, 범위 외, 작업 항목, `Critical Files`, 실행 가능한 검증이 있다.
- 변경할 파일·모듈과 완료 조건이 특정되었다.
- 기존 설계·유틸리티·코드 형태를 따라 구현할 수 있다.
- executor가 제품, 설계, 공개 인터페이스 결정을 새로 내릴 필요가 없다.
- 잘못된 구현을 국소적으로 되돌릴 수 있다.
- 검증이 요청 동작과 주요 회귀를 실제로 감지한다.
- 아래 `HIGH_RISK` 차단 조건에 해당하지 않는다.

한 조건이라도 누락되거나 확인할 수 없으면 `BOUNDED`를 선택하지 않는다.

## `HIGH_RISK` 차단 조건

다음 중 하나라도 실제 변경 범위에 포함되면 `HIGH_RISK`로 판정한다.

- 새 아키텍처·도메인 모델·공용 추상화 설계
- 공개 API·외부 이벤트·저장 형식·하위 호환성 변경
- 데이터 스키마·마이그레이션·영구 데이터 변환
- 인증·권한·비밀값·보안 경계 변경
- 동시성·트랜잭션·분산 처리·장애 복구 정책 변경
- 데이터 손실·중단·비용 폭증 가능성이 있는 작업
- 원인이 확정되지 않은 복합 장애·성능 퇴행
- 여러 서비스·저장소·배포 경계를 넘는 변경

여러 구현안 중 하나를 선택해야 하지만 위 차단 조건에는 해당하지 않으면 `JUDGMENT_REQUIRED`로 판정한다.

## 판정 절차

판정은 의미 평가와 결정적 점검을 결합한다.

1. critic이 코드·문서·phase를 읽고 phase별 실행 형태와 근거를 회신한다.
2. team-lead가 phase 필수 섹션·검증 명령·`execution_profile`을 직접 확인한다.
3. 오버레이의 반복 함정·고위험 경로·금지 패턴과 대조한다.
4. critic과 team-lead 판정 중 더 엄격한 결과를 최종 실행 형태로 삼는다.
5. surface adapter가 최종 실행 형태를 사용 가능한 role·모델에 매핑한다.

공용 skill과 task에는 실제 모델 ID를 저장하지 않는다.
실행 형태도 `index.json` 스키마에 추가하지 않고 critic 회신과 phase 실행 보고에만 기록한다.

## 결정적 점검 실행

team-lead는 각 executor 스폰 직전에 critic 회신과 직접 점검 결과를 assessment JSON으로 만든다.
`scripts/executor_routing_gate.py`가 이 입력을 검증하고 더 엄격한 최종 실행 형태를 계산한다.

```json
{
  "phase_file": "/absolute/path/to/phase-01.md",
  "execution_profile": "standard",
  "critic_verdict": "APPROVE",
  "critic_shape": "BOUNDED",
  "team_lead_shape": "BOUNDED",
  "bounded_checks": {
    "bounded_scope": true,
    "existing_pattern": true,
    "no_new_decision": true,
    "no_high_risk_conditions": true,
    "reversible": true,
    "regression_covered": true
  },
  "uncertainties": [],
  "high_risk_reasons": []
}
```

assessment는 상태 저장소나 안전한 임시 경로에 만들고 task 스키마에는 추가하지 않는다.

```bash
# cwd: <skill-root>
python3 scripts/executor_routing_gate.py <assessment.json>
```

- 종료 코드 `0`이면 출력 JSON의 `effective_shape`를 사용한다.
- `bounded_eligible: true`일 때만 surface adapter가 저비용 실행 경로를 선택할 수 있다.
- 종료 코드가 `0`이 아니면 executor 스폰을 차단한다.
- critic이나 team-lead가 `BOUNDED`로 판정했어도 필수 조건이 누락되면
  스크립트가 `JUDGMENT_REQUIRED` 이상으로 올린다.
- 스크립트 결과를 수동으로 낮추지 않는다. 더 엄격하게 올리는 것만 허용한다.

## critic 출력 계약

critic은 계획 판정과 실행 형태를 분리해 회신한다.

```text
계획 판정: APPROVE | REVISE

phase별 실행 형태:
- phase 01: BOUNDED | JUDGMENT_REQUIRED | HIGH_RISK
  근거: ...
  BOUNDED 차단 조건: 없음 | ...

발견 목록:
- 없음 | ...
```

`APPROVE`라도 phase별 실행 형태가 누락되면 executor를 스폰하지 않고 critic에게 재요청한다.

## executor 실행 중 승격

`BOUNDED`로 시작한 executor는 다음 상황에서 수정을 더 이상 확장하지 않는다.

- plan 범위 밖 파일·동작을 변경해야 한다.
- 요구사항이나 구현 방법을 두 가지 이상으로 해석할 수 있다.
- 새 추상화·인터페이스·데이터 형식 결정이 필요하다.
- 검증 실패 원인이 plan과 다르거나 범위 밖에 있다.
- 수정 후에도 동일한 핵심 실패가 재현된다.
- `HIGH_RISK` 차단 조건을 새로 발견했다.

executor는 다음 형식으로 team-lead에게 회신한다.

```text
EXECUTOR_ESCALATE: <사유>
완료한 변경: <없음 | 범위>
미완료 조건: <남은 결정·검증>
권장 실행 형태: JUDGMENT_REQUIRED | HIGH_RISK
```

team-lead는 승격 사유가 plan을 바꾸면 critic 재평가로 돌아간다.
단순 실행 누락이면 `BOUNDED` executor를 한 번만 재투입할 수 있다.
새로운 판단이 필요하면 더 엄격한 실행 형태로 승격한다.

## 독립 검토와 기록

`BOUNDED` executor가 구현·검증을 완료해도 code-reviewer와 docs-verifier 절차를 줄이지 않는다.
검토가 설계·명세 결함을 발견하면 `BOUNDED` executor에 반복 재투입하지 않고 실행 형태를 승격한다.

phase 보고에 다음을 남긴다.

- `execution_profile`
- 최종 실행 형태와 근거
- 실제 role·모델과 폴백 여부
- 승격 여부와 사유
- 최종 reviewer 판정
- 점검 출력 JSON 또는 그 저장 경로
