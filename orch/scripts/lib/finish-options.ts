// finish-pr.ts 가 받는 옵션 목록이다. parseArgs 의 options 꼴이다.
// finish-pr.ts 와 merge-with-finish.ts 가 함께 import 한다. merge-with-finish 는 --finish-arg 로 넘길 인자를 이 목록으로
// 펼쳐(lib/args.ts 의 expandArgs) 줄여 쓴 --complete-cmd 도 알아본다. 바꾸면 두 명령의 옵션 판정이 함께 바뀐다.

export const FINISH_OPTIONS = {
  repo: { type: 'string' },
  config: { type: 'string' },
  'gh-host': { type: 'string' },
  run: { type: 'string' },
  'base-branch': { type: 'string' },
  'sweep-arg': { type: 'string', multiple: true },
  'specs-dir': { type: 'string' },
  'deploy-workflow': { type: 'string' },
  'deploy-branch': { type: 'string' },
  'task-pattern': { type: 'string' },
  complete: { type: 'boolean' },
  'complete-cmd': { type: 'string' },
  board: { type: 'string' },
  'board-id': { type: 'string' },
  'board-bin': { type: 'string' },
  'merge-timeout': { type: 'string' },
  'deploy-timeout': { type: 'string' },
  'poll-interval': { type: 'string' },
  'pid-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const
