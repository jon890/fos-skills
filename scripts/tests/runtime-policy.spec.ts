// 저장소에 새 Python·셸 파일과 허용하지 않은 JS 진입이 생기면 파일 이름과 함께 실패하는지 본다.
// 판정은 가짜 파일 목록을 넣은 순수 함수로 보고, 저장소 전체는 명령을 한 번만 돌린다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkDocs, checkImports, checkMinNode, checkPackages, checkPolicy, classify, isSourceFile, parsePolicy, type Policy } from '../runtime-policy.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function policy(extra: Partial<Policy> = {}): Policy {
  return {
    pending: [{ area: 'plan', prefix: 'skills/plan/' }],
    bare_imports: [],
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
    ['githooks/a', '#!/usr/bin/env PYTHONUNBUFFERED=1 python3', 'python'],
    ['githooks/b', '#!/usr/bin/env -u FOO node', 'js-entry'],
    ['githooks/c', '#!/bin/dash', 'shell'],
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

  test('export 와 타입 표기, 다른 공백 꼴도 값을 읽는다', () => {
    const text = 'export const MIN_NODE: [number, number] = [22,0]\n'
    assert.deepEqual(checkMinNode([24, 0], [{ path: 'a.ts', text }]), ['MIN-NODE a.ts:1 [22, 0]'])
  })

  test('값을 읽지 못한 선언은 ? 로 낸다', () => {
    assert.deepEqual(checkMinNode([24, 0], [{ path: 'a.ts', text: 'const MIN_NODE = MIN\n' }]), ['MIN-NODE a.ts:1 ?'])
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

  test('명령 치환 안의 python3 호출도 낸다', () => {
    const text = 'gh api --hostname "$(python3 "$SKILL_DIR/scripts/gh_host.py")"\n'
    assert.equal(checkDocs(prefixes, [{ path: 'skills/plan/SKILL.md', text }]).length, 1)
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

describe('checkPackages', () => {
  test('루트 밖 package.json 이 type 만 담으면 통과한다', () => {
    assert.deepEqual(checkPackages([{ path: 'bin/package.json', text: '{"type": "commonjs"}' }]), [])
  })

  test('루트 밖 package.json 의 dependencies 를 PACKAGE 로 낸다', () => {
    const lines = checkPackages([{ path: 'skills/x/package.json', text: '{"type":"module","dependencies":{"zod":"4.6.7"}}' }])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^PACKAGE skills\/x\/package\.json .*dependencies/)
  })

  test('루트 package.json 은 dependencies 를 가질 수 있다', () => {
    assert.deepEqual(checkPackages([{ path: 'package.json', text: '{"type":"module","dependencies":{"zod":"4.6.7"}}' }]), [])
  })

  test('루트 dependencies 의 범위 기호를 낸다', () => {
    const lines = checkPackages([{ path: 'package.json', text: '{"dependencies":{"zod":"^4.6.7"}}' }])
    assert.match(lines[0] ?? '', /^PACKAGE package\.json dependencies\.zod 는 정확한 버전/)
  })

  test('JSON 이 아니면 PACKAGE 로 낸다', () => {
    assert.deepEqual(checkPackages([{ path: 'bin/package.json', text: '{' }]), ['PACKAGE bin/package.json JSON 이 아니다'])
  })

  test('package.json 이 아닌 파일은 보지 않는다', () => {
    assert.deepEqual(checkPackages([{ path: 'bin/other.json', text: '{"dependencies":{}}' }]), [])
  })
})

describe('checkImports', () => {
  const allowed = [{ path: 'skills/orch/scripts/core/config-schema.ts', name: 'zod' }]

  test('허용 목록 밖의 bare import 를 IMPORT 줄로 낸다', () => {
    const text = "import fs from 'node:fs'\nimport { z } from 'zod'\n"
    assert.deepEqual(checkImports([], [{ path: 'a/b.ts', text }]), ['IMPORT a/b.ts:2 zod'])
  })

  test('허용 목록의 짝은 통과하고 다른 파일의 같은 import 는 낸다', () => {
    const text = "import * as z from 'zod'\n"
    const sources = [
      { path: 'skills/orch/scripts/core/config-schema.ts', text },
      { path: 'skills/orch/scripts/core/other.ts', text },
    ]
    assert.deepEqual(checkImports(allowed, sources), ['IMPORT skills/orch/scripts/core/other.ts:1 zod'])
  })

  test('glob 의 * 는 / 를 넘지 않는다', () => {
    const glob = [{ path: 'ext/tests/*.test.ts', name: 'claude-code/testing' }]
    const text = "import { x } from 'claude-code/testing'\n"
    assert.deepEqual(checkImports(glob, [{ path: 'ext/tests/a.test.ts', text }]), [])
    assert.deepEqual(checkImports(glob, [{ path: 'ext/tests/sub/a.test.ts', text }]), ['IMPORT ext/tests/sub/a.test.ts:1 claude-code/testing'])
  })

  test('여러 줄 import, export from, 부수 효과 import, 동적 import, require 를 읽는다', () => {
    const text = [
      'import {',
      '  a,',
      "} from 'm1'",
      "export * from 'm2'",
      "import 'm3'",
      `const x = await ${'import'}('m4')`,
      `const y = ${'require'}('m5')`,
    ].join('\n')
    assert.deepEqual(
      checkImports([], [{ path: 'a.ts', text }]).map((line) => line.split(' ')[2]),
      ['m1', 'm2', 'm3', 'm4', 'm5'],
    )
  })

  test('상대 경로와 node: 는 보지 않는다', () => {
    const text = "import a from './a.ts'\nimport b from '../b.ts'\nimport c from 'node:path'\nimport d from '/abs'\n"
    assert.deepEqual(checkImports([], [{ path: 'a.ts', text }]), [])
  })

  test('문자열 안의 from 이나 require 표본은 걸리지 않는다', () => {
    const text = ["const s = \"import x from 'zod'\"", "const t = 'require(\"zod\")'", "// import y from 'zod'", ' * import z from "zod"'].join('\n')
    assert.deepEqual(checkImports([], [{ path: 'a.ts', text }]), [])
  })

  test('확장자와 entry_js 로 소스 파일을 고른다', () => {
    assert.equal(isSourceFile('a/b.mts', []), true)
    assert.equal(isSourceFile('docs/a.md', []), false)
    assert.equal(isSourceFile('bin/orch', ['bin/orch']), true)
    assert.equal(isSourceFile('bin/orch', []), false)
  })
})

describe('parsePolicy', () => {
  test('bare_imports 의 이름이 루트 의존에도 claude-code/ 에도 없으면 거부한다', () => {
    const bad = { ...policy(), bare_imports: [{ path: 'a.ts', name: 'left-pad' }] }
    assert.throws(() => parsePolicy(JSON.stringify(bad), ['zod']), /left-pad/)
    assert.doesNotThrow(() => parsePolicy(JSON.stringify({ ...policy(), bare_imports: [{ path: 'a.ts', name: 'zod' }] }), ['zod']))
    assert.doesNotThrow(() => parsePolicy(JSON.stringify({ ...policy(), bare_imports: [{ path: 'a.ts', name: 'claude-code/testing' }] })))
  })

  test('bare_imports 가 없으면 거부한다', () => {
    const { bare_imports: _omit, ...rest } = policy()
    assert.throws(() => parsePolicy(JSON.stringify(rest)), /bare_imports/)
  })

  test('min_node 가 정수 둘이 아니면 거부한다', () => {
    assert.throws(() => parsePolicy(JSON.stringify({ ...policy(), min_node: [24] })), /min_node/)
  })

  test('한 pending 접두가 다른 접두를 덮으면 거부한다', () => {
    const pending = [{ area: 'a', prefix: 'skills/' }, { area: 'plan', prefix: 'skills/plan/' }]
    assert.throws(() => parsePolicy(JSON.stringify({ ...policy(), pending })), /skills\/ 가 skills\/plan\//)
  })

  test('entry_js 에 같은 경로가 두 번 있으면 거부한다', () => {
    assert.throws(() => parsePolicy(JSON.stringify({ ...policy(), entry_js: ['bin/orch', 'bin/orch'] })), /entry_js/)
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
