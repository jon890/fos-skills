// lib/temp-path.ts 의 세션 임시 폴더 경로 판정.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionTempPaths } from '../scripts/lib/temp-path.ts'

test('세션 임시 폴더 경로만 낸다', () => {
  const text = [
    '평가 본문은 /var/folders/ab/cd/T/a.json 과 `/private/tmp/claude-501/b.md`, (/tmp/claude-1/c.txt).',
    '일반 /tmp/shared/d.txt 는 세션 임시 폴더가 아니다',
    '저장소 /Users/me/repo/.orch/handoff/e.json',
  ].join('\n')
  assert.deepEqual(sessionTempPaths(text, undefined), ['/var/folders/ab/cd/T/a.json', '/private/tmp/claude-501/b.md', '/tmp/claude-1/c.txt'])
})

test('TMPDIR 값 아래는 /private 접두와 끝 점을 무시하고 잡는다', () => {
  assert.deepEqual(sessionTempPaths('파일 /private/tmp/sess/x.json.', '/tmp/sess/'), ['/private/tmp/sess/x.json'])
  assert.deepEqual(sessionTempPaths('파일 /tmp/other/x.json', '/tmp/sess'), [])
  assert.deepEqual(sessionTempPaths('파일 /tmp/other/x.json', '/'), [])
})

test('글자 그대로의 $TMPDIR 경로를 잡는다', () => {
  assert.deepEqual(sessionTempPaths('cat $TMPDIR/x.json 와 ${TMPDIR}/y.json', undefined), ['$TMPDIR/x.json', '${TMPDIR}/y.json'])
})
