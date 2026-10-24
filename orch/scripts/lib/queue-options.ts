// 머지 큐가 값을 받는 옵션 목록이다. 이 옵션 바로 뒤의 인자는 값이라, 숫자여도 PR 번호로 읽지 않는다.
// merge_queue.ts 와 merge-with-finish 가 함께 import 한다. 바꾸면 값이 숫자여도 PR 번호로 읽지 않는 판정이 함께 바뀐다.
// 아직 Python 인 merge-with-finish.py 는 같은 목록을 따로 들고 있고, tests/test_merge_with_finish.py 가 이 목록과 맞는지 본다.

export const QUEUE_VALUE_OPTIONS: readonly string[] = [
  '--repo',
  '--before',
  '--method',
  '--threads-cmd',
  '--check-timeout',
  '--required',
  '--allow-fail',
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
]
