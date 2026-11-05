import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runCommand } from '../command.ts'
import { copyRepo, git } from '../git.ts'
import { tempDir } from '../temp.ts'

const MEASURE = join(import.meta.dirname, '..', 'measure.ts')
const SPAWNING = `import { spawnSync } from 'node:child_process'
import { it } from 'node:test'
it('child', () => {
  spawnSync(process.execPath, ['-e', '0'])
})
`

describe('measure.ts', () => {
  it('자식 프로세스를 띄우는 파일의 전후 기동 수를 센다', () => {
    const { dir } = copyRepo(join(tempDir(), 'r'))
    mkdirSync(join(dir, 't'))
    writeFileSync(join(dir, 't/spawn.spec.ts'), SPAWNING)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'add'])
    const done = runCommand([process.execPath, MEASURE, '--before', 'HEAD', '--after', 'HEAD', '--runs', '1', 't/spawn.spec.ts'], { cwd: dir })
    assert.equal(done.code, 0, done.stdout + done.stderr)
    const row = done.stdout.split('\n').find((line) => line.startsWith('| t/spawn.spec.ts'))
    assert.ok(row, done.stdout)
    const cells = row.split('|').map((c) => c.trim())
    const [before, after] = [Number(cells[4]), Number(cells[5])]
    assert.ok(before > 0, row)
    assert.equal(before, after)
    assert.equal(cells[6], '0')
  })

  it('모르는 옵션이면 2 다', () => {
    const done = runCommand([process.execPath, MEASURE, '--bogus'])
    assert.equal(done.code, 2)
  })
})
