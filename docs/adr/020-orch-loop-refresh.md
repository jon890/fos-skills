# ADR-020: 상주 루프가 뒤처진 PR 의 최신화를 머지 차례 전에 PR 마다 걸고, 머지는 머지 큐가 하나씩 한다

- **status**: `accepted`
- **결정**: `pipeline.refresh_slots` 가 1 이상인 저장소에서 상주 루프가 틱마다 base 에 뒤처진 내 PR 을 찾아, 머지 큐가 차례에 할 `update-branch` 를 미리 PR 마다 따로 건다.
  판정은 머지 큐와 같은 `queue` 키(`require_up_to_date`, `up_to_date_when`, `shared_paths`, `unit_groups`, `docs_glob`)로 한다. 머지 큐가 바로 머지할 PR 은 건드리지 않는다.
  대상은 draft 가 아니고, 지금 HEAD 의 CI 가 passed 이고, base 와 충돌하지 않는 PR 이다. 같은 (PR, base SHA) 에는 한 번만 건다.
  루프가 건 최신화 가운데 CI 가 아직 도는 것은 `refresh_slots` 개까지다.
  도는 머지 큐의 차례 PR 은 건드리지 않고, 큐에서 아직 머지되지 않은 앞 PR 과 겹치는 PR 은 그 머지 뒤로 미룬다. 머지 큐는 차례 기록(`state/queue-turn/<pid>.json`)에 남은 PR, 차례 PR, 단계를 적어 루프가 읽게 한다.
  `pipeline.refresh_worker_paths` 에 맞는 파일을 PR 과 base 가 모두 바꿨으면 `update-branch` 대신 살아 있는 worker 에게 「base 를 합쳐 검증하고 한 번 push」 를 보낸다. worker 가 없으면 로그에만 남긴다.
  머지는 지금처럼 머지 큐가 하나씩 한다. 차례가 온 PR 이 이미 최신이고 CI 를 통과했으면 기다리지 않는다. 체크가 이미 60초 넘게 전에 끝나 있었으면 새 체크를 기다리는 60초도 건너뛴다.
  큐가 돌아 자동 머지를 미룬 틱에는 큐가 무엇을 기다리는지 `AUTO-MERGE-HELD` 한 줄을 루프 로그에 남긴다.
  사용자 결정 2026-11-04: 머지가 한 줄로 기다리는 것은 괜찮다. 뒤처진 PR 을 고치고 CI 를 기다리는 일이 병렬로 돌아야 한다. runner 가 5대라 동시에 거는 수의 상한을 설정으로 둔다.
- **맥락**: 공용 경로(계약 yaml, 공용 모듈)를 건드린 PR 은 `--up-to-date-when overlap` 에서도 앞 PR 이 머지될 때마다 갱신이 필요하다.
  머지 큐는 PR 을 하나씩 처리하므로 그 PR 은 차례가 와서야 base 를 합치고 CI 를 다시 기다렸다. 2026-11-04 거의 모든 API PR 이 계약 yaml 을 건드려, 머지가 PR 마다 CI 한 번(7~10분)씩 줄을 서 10분 넘게 기다렸다.
  코디네이터가 따로 건 `merge-with-finish` 가 큐를 쥔 동안 루프의 자동 머지가 한 틱 동안 돌지 않았는데, 무엇을 기다리는지 로그에 없었다.
  worker 가 push 직전에 base 를 합쳐도 그 사이 다른 PR 이 머지되면 다시 뒤처진다. 누가 합치든 CI 한 번은 필요하므로 줄여야 하는 것은 그 CI 를 직렬로 기다리는 시간이다.
- **대안 기각**:
  - PR 이 머지될 때마다 겹치는 열린 PR 의 worker 모두에게 base 합치기를 보낸다. worker 가 없는 PR 은 남고, 충돌이 없는 합치기에 worker 의 턴과 검사 시간을 쓴다. 충돌이 없으면 루프가 `update-branch` 로 같은 일을 한다. worker 에게는 충돌과 판단이 필요한 파일만 보낸다.
  - 머지 큐가 CI 를 기다리는 PR 을 큐에서 빼고 겹치지 않는 뒤 PR 을 먼저 머지한다. 머지 순서가 바뀌어 `--chain` 과 마이그레이션 순서를 다시 판정해야 하고, 사용자가 줄 서기 자체는 괜찮다고 정했다.
  - 루프가 뒤처진 PR 을 모두 바로 최신화한다. 큐에서 곧 머지될 PR 과 겹치는 PR 은 그 머지 뒤 다시 뒤처져 방금 돌린 CI 가 쓸모없어진다. 큐의 앞 PR 과 겹치면 미룬다.
  - 도는 큐에 새 PR 을 덧붙인다. 도는 큐가 인자를 다시 읽어야 하고, 순서와 보류, 마무리를 다시 맞춰야 한다. 큐가 끝나면 다음 틱이 거는 것으로 충분해 로그 한 줄로 기다리는 것을 알린다.
  - 머지 큐의 차례 PR 도 최신화한다. 큐 밖에서 HEAD 가 바뀌면 그 PR 이 「체크 조회 중 HEAD 가 바뀌었다」 로 멈춘다.
  - CI 가 실패하거나 도는 PR 도 최신화한다. 실패를 덮거나 도는 CI 를 다시 돌려 runner 를 더 쓴다. worker 가 고쳐 push 할 때 base 를 함께 합친다.
  - 기본으로 켠다. ready PR 에 루프가 merge 커밋을 더하는 것은 지금까지 없던 쓰기라, runner 수와 공용 경로를 아는 저장소만 켠다.
- **결과**:
  - 얻는 것: 뒤처진 PR 들의 CI 가 함께 돈다. 차례가 온 PR 이 이미 최신이면 머지 큐가 CI 를 다시 기다리지 않고 머지한다.
  - 얻는 것: 충돌과 판단이 필요한 합치기가 머지 차례 전에 worker 에게 간다.
  - 얻는 것: 큐가 자동 머지를 막는 동안 무엇을 기다리는지 `state/loop.log` 의 `AUTO-MERGE-HELD` 로 보인다.
  - 감당할 것: 공용 경로처럼 PR 끼리도 늘 겹치면 앞 PR 이 머지된 뒤 다시 최신화해야 하므로 줄지 않는다. 큐의 앞 PR 과 겹치는 PR 은 미뤄 runner 를 아낀다.
  - 감당할 것: 루프가 merge 커밋을 원격 브랜치에 더하므로 worker 는 push 전에 원격 브랜치를 pull 한다(공통 지시서의 규칙). 자동 리뷰 판정은 base 를 합친 merge 커밋만 더한 HEAD 의 앞 리뷰를 인정한다([ADR-016](016-orch-auto-merge.md)).
  - 감당할 것(2026-11-04 보탬): `update-branch` 는 HEAD 를 새 merge 커밋으로 바꿔 기능 완료 근거의 「검증 커밋 = 지금 HEAD」 검사에 늘 걸렸다. 검증 커밋 뒤에 base 쪽 변경만 들여온 merge 커밋만 있으면(두 부모를 합친 tree 와 같고 둘째 부모가 base 에 든다) 통과로 보고 지금 HEAD 의 CI 통과로 갈음한다. 판정은 `skills/orch/scripts/lib/feature-evidence.ts` 의 `baseMergesOnly` 가 소유한다.
  - 바뀐 결정(2026-11-04 보탬, 사용자 결정): 맨 앞 PR 이 막혀 뒤의 머지할 수 있는 PR 셋이 머지되지 않은 일이 있어 두 가지를 더했다.
    머지 큐는 보류한 PR 만 빼고 다음 PR 로 가는 것이 기본이다(`--stop-on-hold` 로 옛 동작). 차례 PR 이 update-branch 뒤 CI 를 기다리는 동안에는 묶음 밖이고 체크가 통과했고 최신화가 필요 없고 차례 PR 과 겹치지 않는 뒤 PR 을 먼저 머지한다.
    위 「대안 기각」 의 큐 순서 바꾸기는 겹치지 않는 PR 에만, 기다리는 동안에만 하는 것으로 좁혀 받아들였다. 겹치는 PR 과 묶음은 순서를 지킨다.
  - 감당할 것: 차례 기록을 읽은 뒤 `update-branch` 를 부르기까지의 짧은 틈에 큐가 그 PR 차례로 넘어오면 그 PR 은 `STOP` 으로 멈춘다. 부르기 직전에 차례 기록을 다시 읽어 틈을 줄인다. 멈춘 PR 은 HEAD 가 바뀌었으므로 다음 틱의 자동 머지가 다시 건다.
- **적용 범위**: 판정과 설정은 `skills/orch/scripts/lib/refresh.ts`, 틱의 자리와 기록은 `skills/orch/scripts/orch-loop.ts` 머리 주석의 「최신화」, 차례 기록은 `skills/orch/scripts/lib/queue-turn.ts`, 설정 키와 상태 파일은 [`../data-schema.md`](../data-schema.md) 가 소유한다.
