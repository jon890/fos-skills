// 저장소에 새 Python·셸 파일과 허용하지 않은 JS 진입이 생기면 파일 이름과 함께 실패하는지 본다.
// 판정은 가짜 파일 목록을 넣은 순수 함수로 보고, 저장소 전체는 명령을 한 번만 돌린다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkDocs, checkMinNode, checkPolicy, classify, parsePolicy, type Policy } from '../runtime-policy.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function policy(extra: Partial<Policy> = {}): Policy {
  return {
    pending: [{ area: 'plan', prefix: 'skills/plan/' }],
    legacy: [],
    entry_js: [],
    migrated_docs: [],
    min_node: [24, 0],
    ...extra,
  }
}

describe('classify', () => {
  const cases: [string, string, string | null][] = [
    ['skills/plan/scripts/a.py', '"""문서 문자열"""', 'python'],
    ['githooks/commit-msg', '#!/usr/bin/env python3', 'python'],
    ['githooks/post-commit', '#!/usr/bin/env -S bash -e', 'shell'],
    ['scripts/install-hooks.sh', 'set -eu', 'shell'],
    ['skills/orch/scripts/lib/guard/gh', '#!/usr/bin/env -S node --x', 'js-entry'],
    ['export-only-skills/korean-check/scripts/korean-style-check.py', '#!/usr/bin/env node', 'js-entry'],
    ['scripts/run-tests.ts', '#!/usr/bin/env node', null],
    ['README.md', '#!/usr/bin/env bash', 'shell'],
    ['docs/guide.md', '# 제목', null],
  ]
  for (const [path, firstLine, expected] of cases) {
    test(`${path} (${firstLine}) → ${expected}`, () => assert.equal(classify(path, firstLine), expected))
  }
})

describe('checkPolicy', () => {
  test('pending 접두 밖의 새 .py 를 NEW 로 낸다', () => {
    const files = [
      { path: 'skills/plan/scripts/a.py', firstLine: '' },
      { path: 'docs/probe.py', firstLine: '' },
    ]
    assert.deepEqual(checkPolicy(policy(), files), ['NEW docs/probe.py python'])
  })

  test('pending 접두 안의 .py 는 위반이 아니다', () => {
    assert.deepEqual(checkPolicy(policy(), [{ path: 'skills/plan/scripts/a.py', firstLine: '' }]), [])
  })

  test('위반 파일이 없는 pending 접두를 STALE 로 낸다', () => {
    const files = [{ path: 'skills/plan/scripts/a.ts', firstLine: '#!/usr/bin/env node' }]
    assert.deepEqual(checkPolicy(policy(), files), ['STALE pending plan skills/plan/'])
  })

  test('entry_js 에 없는 .mjs 를 NEW js-entry 로 낸다', () => {
    const files = [
      { path: 'skills/plan/scripts/a.py', firstLine: '' },
      { path: 'docs/probe.mjs', firstLine: '' },
    ]
    assert.deepEqual(checkPolicy(policy(), files), ['NEW docs/probe.mjs js-entry'])
  })

  test('legacy 에 적은 node shebang .py 는 위반이 아니다', () => {
    const files = [
      { path: 'skills/plan/scripts/a.py', firstLine: '' },
      { path: 'tools/x/old.py', firstLine: '#!/usr/bin/env node' },
    ]
    assert.deepEqual(checkPolicy(policy({ legacy: ['tools/x/old.py'] }), files), [])
  })

  test('legacy 에 적은 python3 shebang .py 는 NEW 와 STALE legacy 로 낸다', () => {
    const files = [
      { path: 'skills/plan/scripts/a.py', firstLine: '' },
      { path: 'tools/x/old.py', firstLine: '#!/usr/bin/env python3' },
    ]
    assert.deepEqual(checkPolicy(policy({ legacy: ['tools/x/old.py'] }), files), [
      'NEW tools/x/old.py python',
      'STALE legacy tools/x/old.py',
    ])
  })

  test('파일 목록에 없는 entry_js 항목을 STALE 로 낸다', () => {
    const files = [{ path: 'skills/plan/scripts/a.py', firstLine: '' }]
    assert.deepEqual(checkPolicy(policy({ entry_js: ['bin/gone'] }), files), ['STALE entry_js bin/gone'])
  })
})

describe('checkMinNode', () => {
  test('min_node 와 같은 값은 위반이 아니다', () => {
    assert.deepEqual(checkMinNode([24, 0], [{ path: 'bin/orch', text: 'x\nconst MIN_NODE = [24, 0]\n' }]), [])
  })

  test('다른 값을 경로와 줄과 함께 낸다', () => {
    assert.deepEqual(checkMinNode([24, 0], [{ path: 'bin/orch', text: '#!/usr/bin/env node\n\nconst MIN_NODE = [22, 0]\n' }]), [
      'MIN-NODE bin/orch:3 [22, 0]',
    ])
  })

  test('줄 머리가 아닌 같은 글자는 보지 않는다', () => {
    assert.deepEqual(checkMinNode([24, 0], [{ path: 'a.ts', text: '// 예: const MIN_NODE = [22, 0]\n' }]), [])
  })
})

describe('checkDocs', () => {
  const prefixes = ['skills/plan/']

  test('접두 안 문서의 python3 호출과 백틱 안 bash 호출을 낸다', () => {
    const docs = [
      { path: 'skills/plan/SKILL.md', text: '# plan\npython3 "$SKILL_DIR/scripts/x.py"\n설명\n' },
      { path: 'skills/plan/references/a.md', text: '실행: `bash "$SKILL_DIR/scripts/x.sh" --y`\n' },
    ]
    assert.deepEqual(checkDocs(prefixes, docs), [
      'DOC skills/plan/SKILL.md:2 python3 "$SKILL_DIR/scripts/x.py"',
      'DOC skills/plan/references/a.md:1 실행: `bash "$SKILL_DIR/scripts/x.sh" --y`',
    ])
  })

  test('CHANGELOG.md, changes/ 아래, 접두 밖 문서는 보지 않는다', () => {
    const text = 'python3 "$SKILL_DIR/scripts/x.py"\n'
    const docs = [
      { path: 'skills/plan/CHANGELOG.md', text },
      { path: 'skills/plan/changes/a.patch.md', text },
      { path: 'skills/report/SKILL.md', text },
    ]
    assert.deepEqual(checkDocs(prefixes, docs), [])
  })
})

describe('parsePolicy', () => {
  test('min_node 가 정수 둘이 아니면 거부한다', () => {
    assert.throws(() => parsePolicy(JSON.stringify({ ...policy(), min_node: [24] })), /min_node/)
  })

  test('pending 항목에 prefix 가 없으면 거부한다', () => {
    assert.throws(() => parsePolicy(JSON.stringify({ ...policy(), pending: [{ area: 'plan' }] })), /pending/)
  })
})

describe('저장소 전체', () => {
  test('추적 파일이 정책 파일과 맞는다', () => {
    const run = spawnSync(process.execPath, ['scripts/runtime-policy.ts'], { cwd: ROOT, encoding: 'utf8' })
    const output = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`
    assert.equal(run.status, 0, output)
    assert.match(run.stdout, /^OK pending \d+$/m, output)
  })
})
