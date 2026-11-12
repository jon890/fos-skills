# 의존 설치와 설정 검사표 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ6 | `node_modules` 가 없는 PR 브랜치의 새 clone 을 git 저장소로 둔 로컬 마켓플레이스 | 빈 임시 `CLAUDE_CONFIG_DIR` 로 `claude plugin marketplace add <체크아웃>` 과 `claude plugin install fos-skills@<마켓>` 을 돌리고, 캐시 버전 폴더에서 `node_modules/zod/package.json` 의 version 을 읽은 뒤 그 폴더의 `skills/orch/bin/orch.ts doctor --repo <임시 저장소> --skip-version` 을 돈다 | 캐시에 zod 4.6.7 이 있고, doctor 출력에 `CLI-DEPS-MISSING` 이 없다 | 임시 설정 폴더의 로컬 Claude Code CLI | worker | 없음 | PR 전 |
| REQ6 | `node_modules` 를 지운 PR 체크아웃 사본 | 사본에서 `node skills/orch/bin/orch.ts doctor --repo <임시 저장소> --skip-version` 과 `node skills/orch/bin/orch.ts loop status --repo <임시 저장소>` 를 돈다 | doctor 는 `CLI-DEPS-MISSING` 한 줄을 내고 나머지 검사를 돈다. loop status 는 zod 없이 지금처럼 돈다 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ6 | 이 PR 의 테스트 | `node scripts/run-tests.ts skills/orch/tests/core-config-schema.spec.ts skills/orch/tests/config-schema-readers.spec.ts` | 키 목록 대조, 키별 good·bad 표본, 짝 규칙 독립성, `knownPath`, 한국어 이유, 읽는 곳 대조가 모두 통과한다 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ6 | 글자 `"30"` 인 `finish.merge_timeout` 이 든 임시 저장소 | `skills/orch/tests/config-schema-readers.spec.ts` 의 해당 사례 | 마무리 명령이 설정 오류·사용법 오류 없이 지금처럼 돈다(읽는 쪽 동작 보존) | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ6 | 이 PR 브랜치 | `node scripts/runtime-policy.ts` 와 `node scripts/run-tests.ts skills/orch/tests/core-boundary.spec.ts scripts/tests/runtime-policy.spec.ts` | 루트 밖 `package.json` 은 `type` 만, bare import 는 `bare_imports` 짝만 통과하고 저장소 검사가 종료 코드 0 이다 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ6 | 이 PR 브랜치 | `./bin/orch --help` 와 `node scripts/run-tests.ts skills/orch/tests/orch-launcher.spec.ts skills/orch/tests/lib-guard.spec.ts` | 루트 `"type": "module"` 아래에서도 CommonJS 진입이 돈다 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ7 | 틀린 값(`pipeline.tick_sec: "60"`), 오타 키, 모르는 절 `queu`, 깨진 JSON 을 하나씩 넣은 임시 저장소 넷과 문제 없는 저장소 하나 | 저장소마다 진입점으로 `node skills/orch/bin/orch.ts doctor --repo <저장소> --skip-version --skip-questions` 를 돈다 | 문제 저장소마다 그 경로의 `INVALID-CONFIG <경로> <이유>` 줄과 종료 코드 1, 문제 없는 저장소에는 그 줄이 없고 종료 코드 0 | 로컬 임시 폴더 | worker | 없음 | PR 전 |
| REQ7 | 틀린 값, 오타 키, 모르는 절, 깨진 JSON, 짝 규칙 위반, 옛 칸을 하나씩 넣은 임시 저장소 | `node scripts/run-tests.ts skills/orch/tests/orch-doctor.spec.ts` | 저장소마다 그 경로의 `INVALID-CONFIG <경로> <이유>` 줄과 종료 코드 1, 문제가 없는 설정에는 그 줄이 없다 | 로컬 작업 공간 | worker | 없음 | PR 전 |
| REQ6 | PR 의 CI | PR 을 연 뒤 `Tests` job 결과를 본다 | `npm ci --ignore-scripts` 단계와 테스트 실행기, `claude plugin test .` 가 통과한다 | GitHub Actions | worker | push | PR 뒤 |
| REQ7 | PR 의 CI | PR 을 연 뒤 `Tests` job 의 `orch-doctor.spec.ts` 결과를 본다 | doctor 테스트가 CI 에서도 통과한다 | GitHub Actions | worker | push | PR 뒤 |

REQ6 의 인수 조건 가운데 「틀린 값은 `set` 이 거절한다」 와 「`docs/data-schema.md` 와 `overlay.md` 의 같은 키 타입이 같다」 는 `orch config set` 이 생기는 다음 PR 의 인수 검증에서 확인한다(index 의 `deferred`). 이 PR 은 같은 검사표가 그 값을 문제로 내는 것(`core-config-schema.spec.ts` 의 bad 표본)까지 확인한다.
