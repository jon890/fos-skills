// 설정 키별 표본. good 은 검사표(core/config-schema.ts)가 받는 값이고, bad 는 그 키 경로나 그 아래에 value 문제를 내야 하는 값이다.
// core-config-schema.spec.ts 가 검사표의 판정을, config-schema-readers.spec.ts 가 good 값을 읽는 쪽이 받는지를 본다.
// 키를 더하면 표본도 함께 더한다(검사표의 모든 키가 이 표에 있는지 core-config-schema.spec.ts 가 본다).

export type Sample = { good: unknown[]; bad: unknown[] }

const flag: Sample = { good: [true, false], bad: ['true', 'yes', 0, null] }
const textOrNull: Sample = { good: ['x', null], bad: [1, true, ['x']] }
const texts: Sample = { good: ['x', '.orch/specs'], bad: [null, 1, true] }
const timer: Sample = { good: [1, 0.5, 2147483], bad: [0, -1, '60', 2147484, null] }
const wholeSec: Sample = { good: [1, 60, 2147483], bad: [0, 1.5, '5', 2147484, -1] }
const days: Sample = { good: [null, 0, '3', 1.5], bad: [-1, '-1', 'x', '', true] }
const regexList: Sample = { good: [[], ['^make ']], bad: ['x', [1], ['(']] }
const inboxAdapter: Sample = { good: [{}, { channel: ['a', 1] }], bad: ['x', { a: 'x' }, { a: [true] }] }

export const SAMPLES: Record<string, Record<string, Sample>> = {
  hooks: {
    timeouts: { good: [{}, { 'after-queue': 600, tick: 1.5 }], bad: [{ 'after-queue': 0 }, { 'after-queue': 2147484 }, { tick: '5' }, 'x', []] },
  },
  queue: {
    required: { good: ['A,,B', 'ci/build', ['a', 'b,c']], bad: ['', ',', [], [''], 'a"b', ['a\\b'], 5] },
    verify_merged_when: { good: ['overlap', 'code', 'always'], bad: ['never', '', 1] },
    docs_glob: { good: ['docs/**', ['docs/**', '*.md']], bad: ['', [], [''], 1] },
    method: { good: ['merge', 'squash', 'rebase'], bad: ['fast', '', 1] },
    up_to_date_when: { good: ['always', 'overlap'], bad: ['sometimes', 1] },
    shared_paths: { good: ['^shared/', ['^a/', '^b/']], bad: ['(', '', [], 5] },
    unit_prefix: { good: ['modules/'], bad: ['', 1] },
    skipped_is_missing: flag,
    update_docs_on_overlap: flag,
    require_up_to_date: flag,
    auto_merge: flag,
    sweep_args: { good: [[], ['--a', 'b']], bad: [[''], 'x', [1]] },
    unit_groups: { good: [[['a', 'b']], [['a', 'b'], ['c', 'd', 'e']]], bad: [[], [['a']], [['a,b', 'c']], [['a', 'b'], ['b', 'c']], 'x'] },
    poll_min_sec: wholeSec,
    poll_max_sec: wholeSec,
    ci_expected_sec: wholeSec,
    auto_review: {
      good: [{ pass: 'LGTM', block: 'BLOCK' }, { pass: 'LGTM', block: 'BLOCK', require: ['verdict-on-head'], feature_head: false }],
      bad: ['x', { pass: 'a' }, { pass: '', block: 'b' }, { pass: '(', block: 'b' }, { pass: 'a', block: 'b', require: ['thread-resolved'] }, { pass: 'a', block: 'b', feature_head: 'no' }],
    },
  },
  pipeline: {
    enabled: flag,
    docs_merge: flag,
    update_behind_drafts: flag,
    idle_exited: flag,
    tick_sec: timer,
    digest_sec: timer,
    ready_slots: { good: [1, 3], bad: [0, 1.5, '2', -1] },
    after_queue_interval_sec: { good: [0, 1.5, 600], bad: [-1, '1'] },
    ci_missing_after_sec: { good: [0, 1.5, 600], bad: [-1, '1'] },
    authors: { good: [[], ['someone']], bad: [[''], 'a', [1]] },
    stall_ticks: { good: [{}, { error: 3, idle: 0 }], bad: [{ error: -1 }, 'x', { error: 1.5 }, { other: 1 }] },
    idle_min: { good: [0, 30.5], bad: [-1, '30'] },
    refresh_slots: { good: [0, 2], bad: [-1, 1.5, '1'] },
    refresh_worker_paths: { good: ['^a/', ['^a/', '^b/']], bad: ['(', '', 5, []] },
  },
  heavy: { exclusive: regexList, normal: regexList, light: regexList, wait_idle: regexList },
  migrations: {
    dirs: { good: [{}, { core: 'src/main/resources/db' }], bad: ['x', { core: '' }, { core: 1 }] },
    watch: { good: [{}, { core: ['a', 'b'] }], bad: [{ core: 'a' }, { core: [''] }, 'x'] },
    before: { good: [{ core: 'make check' }], bad: ['x', { core: '' }] },
    blocked_after_sec: { good: [1, 3600.5], bad: [0, -1, '1'] },
  },
  adr: { dirs: { good: [{}, { core: 'docs/adr/' }], bad: [{ core: '' }, 'x', { core: 1 }] } },
  contracts: {
    merge_command: { good: ['make merge'], bad: ['', ' ', 1] },
    paths: { good: ['a/.*\\.yaml', ['a/.*', 'b/.*']], bad: ['', ['('], 1, []] },
  },
  board: {
    steps: { good: [['[pr] PR', '[merge] 머지'], ['설계']], bad: [[], ['[x] a'], 'x', ['[pr] a', '[pr] b']] },
    done_after: { good: ['merge', 'deploy', 'release'], bad: ['pr', '', 1] },
    task_line: { good: ['(?<number>\\d+)'], bad: ['', 'abc', '(?<number>(', 1] },
    auto_advance: flag,
  },
  review: { prepare: { good: ['', 'make prepare'], bad: [1, null, ['x']] } },
  routing: {
    review_author: { good: ['review-bot'], bad: ['', 1] },
    review_pattern: { good: ['(\\d+)\\D+(\\d+)\\D+(\\d+)\\D+(\\d+)\\D+(\\d+)'], bad: ['(\\d+)', '(', '', 1] },
    size_pattern: { good: ['Size: (\\w+)'], bad: ['size', '(', '', 1] },
  },
  docker: {
    containers: { good: [[], [{ label: 'a=b' }, { name: 'job-(?<pid>\\d+)' }]], bad: ['x', [{}], [{ label: 'x', extra: 1 }], [{ name: '(' }]] },
    images: { good: [[], [{ repository: 'app/.*', keep: 2 }]], bad: [[{ repository: '(' }], [{ repository: 'a', keep: -1 }], 'x'] },
  },
  finish: {
    repo: textOrNull,
    gh_host: textOrNull,
    base_branch: textOrNull,
    board_id: textOrNull,
    board_bin: textOrNull,
    pid_file: textOrNull,
    run: textOrNull,
    deploy_workflow: textOrNull,
    deploy_branch: textOrNull,
    task_pattern: { good: [null, '', '#(\\d+)'], bad: ['abc', '(', 1] },
    spec_task_pattern: { good: [null, '', '#(\\d+)'], bad: ['abc', '(', 1] },
    specs_dir: texts,
    board: texts,
    sweep_arg: { good: [[], ['--x']], bad: ['x', [1]] },
    complete: flag,
    intermediate: flag,
    merge_timeout: { good: [null, 30, '30', 0.5], bad: [0, '0', '', ' ', 'abc', -1, true] },
    deploy_timeout: { good: [null, 30, '30', 0.5], bad: [0, '0', '', ' ', 'abc', -1, true] },
    poll_interval: { good: [null, 5, '5'], bad: [0, 2147484, 'x', true] },
    worker_done_timeout: { good: [null, 0, '0', 10], bad: [-1, 'x', '', true] },
  },
  cleanup: {
    repo: textOrNull,
    gh_host: textOrNull,
    run: textOrNull,
    orch_dir: textOrNull,
    previews: textOrNull,
    trash: textOrNull,
    board: textOrNull,
    data_ext: { good: ['csv,tsv', null], bad: [1, ['csv']] },
    queue_days: days,
    folder_days: days,
    data_days: days,
    apply: flag,
  },
  inbox: {
    enabled: { good: [true, false], bad: ['false', 0, null] },
    dooray: inboxAdapter,
    slack: inboxAdapter,
  },
}
