// 공통 동작의 정의 위치를 확인해 다시 사본이 생기지 않게 한다.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
const scripts = fileURLToPath(new URL('../scripts/', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])
}
const source = sources(scripts).map(file => ({ file: relative(scripts, file), text: readFileSync(file, 'utf8') }))
test('객체 검사와 공통 실행 함수의 정의는 정한 파일만 소유한다', () => {
  for (const [name, owner] of Object.entries({ isObject: 'core/json.ts', gitBin: 'lib/git.ts', closeTerminal: 'lib/orca.ts', workerRows: 'lib/workers.ts', orcaJson: 'lib/orca.ts' })) {
    const definitions = source.filter(({ text }) => new RegExp(`(?:export +)?function +${name}\\s*[(<]`).test(text)).map(({ file }) => file)
    assert.deepEqual(definitions, [owner], name)
  }
  assert.deepEqual(source.filter(({ text }) => /(?:function\s+obj\s*\(|(?:const|let)\s+obj\s*=)/.test(text)).map(({ file }) => file), [])
})
test('pid 생존 확인과 실행 응답 읽기는 공통 모듈을 부른다', () => {
  for (const file of ['lib/docker.ts', 'lib/queue-logs.ts', 'worker/resume-worker.ts']) {
    const text = source.find(row => row.file === file)!.text
    assert.match(text, /from ['"](?:\.\/|\.\.\/lib\/)process\.ts['"]/)
    assert.doesNotMatch(text, /process\.kill/)
  }
  const send = source.find(row => row.file === 'worker/send-to-worker.ts')!.text
  assert.match(send, /orcaJsonOrThrow/)
  assert.doesNotMatch(send, /JSON\.parse\(done\.stdout\)/)
})

test('개별 pid 생존 확인과 terminal close 명령은 공통 모듈만 소유한다', () => {
  const pidOwners = source.filter(({ text }) => /process\.kill\(\s*(?!-)[^,]+,\s*0\s*\)/.test(text)).map(({ file }) => file)
  assert.deepEqual(pidOwners, ['lib/process.ts'])
  const closeOwners = source.filter(({ text }) => /\[\s*['"]terminal['"]\s*,\s*['"]close['"]/.test(text)).map(({ file }) => file)
  assert.deepEqual(closeOwners, ['lib/orca.ts'])
})
