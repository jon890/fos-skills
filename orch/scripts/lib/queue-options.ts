// 머지 큐가 값을 받는 옵션 목록이다. 이 옵션 바로 뒤의 인자는 값이라, 숫자여도 PR 번호로 읽지 않는다.
// merge_queue.ts 와 merge-with-finish.ts 가 함께 import 한다. 바꾸면 값이 숫자여도 PR 번호로 읽지 않는 판정이 함께 바뀐다.
//
// 아래 QUEUE_VALUES, QUEUE_FLAGS, QUEUE_REPEATED, QUEUE_GROUPS 는 config.json 의 queue 키를 머지 큐 옵션으로 바꾸는 표다.
// merge-with-finish.ts 가 쓴다. 표들의 키를 합치면 lib/config.ts 의 QUEUE_KEYS 와 같은 집합이다(lib-config.spec.ts 가 본다).
// merge-with-finish.ts 는 import 하면 명령이 돌아 테스트가 읽을 수 없으므로 표를 이 모듈에 둔다.

export const QUEUE_VALUE_OPTIONS: readonly string[] = [
  '--repo',
  '--before',
  '--method',
  '--threads-cmd',
  '--check-timeout',
  '--required',
  '--required-check',
  '--allow-fail',
  '--allow-fail-check',
  '--up-to-date-when',
  '--shared-paths',
  '--unit-prefix',
  '--unit-group',
  '--verify-merged',
  '--verify-merged-when',
  '--docs-glob',
  '--copy-dir',
  '--after-merged',
  '--sweep-arg',
  '--last-of-task',
  '--chain',
]

// queue 절의 값을 받는 키와 머지 큐 옵션
export const QUEUE_VALUES: Readonly<Record<string, string>> = {
  before: '--before',
  required: '--required',
  verify_merged: '--verify-merged',
  verify_merged_when: '--verify-merged-when',
  docs_glob: '--docs-glob',
  method: '--method',
  after_merged: '--after-merged',
  up_to_date_when: '--up-to-date-when',
  shared_paths: '--shared-paths',
  unit_prefix: '--unit-prefix',
}
// queue 절의 참거짓 키와 값 없는 머지 큐 옵션
export const QUEUE_FLAGS: Readonly<Record<string, string>> = {
  skipped_is_missing: '--skipped-is-missing',
  update_docs_on_overlap: '--update-docs-on-overlap',
  require_up_to_date: '--require-up-to-date',
}
// queue 절의 문자열 목록 키. 항목마다 같은 옵션을 한 번씩 붙인다
export const QUEUE_REPEATED: Readonly<Record<string, string>> = { sweep_args: '--sweep-arg' }
// queue 절의 묶음 목록 키. 안쪽 목록 하나가 `--unit-group a,b` 하나가 된다
export const QUEUE_GROUPS: Readonly<Record<string, string>> = { unit_groups: '--unit-group' }
