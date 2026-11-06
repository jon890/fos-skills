// cleanup-sweep.ts 의 Docker 자원 정리(머리 주석의 「Docker 자원」)를 본다. 판정의 세부는 lib-docker.spec.ts 가 본다.
// 가짜 실행 파일, 상태와 공통 도우미는 fixtures/cleanup-sweep.ts 가 소유한다. 여기서는 docker 만 상태를 가진 가짜로 바꾼다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { fx, has, runSweep, runSweepFull } from './fixtures/cleanup-sweep.ts'

let dockerState: string

// 띄운 프로세스가 없는 PID. 2^22 보다 큰 PID 는 macOS 와 Linux 기본 설정에서 나오지 않는다
const DEAD_PID = 4_999_999

function config(body: unknown): void {
  mkdirSync(join(fx.repo, '.orch'), { recursive: true })
  writeFileSync(join(fx.repo, '.orch', 'config.json'), JSON.stringify(body))
}

function dockerCalls(): string[] {
  return existsSync(dockerState) ? ((JSON.parse(readFileSync(dockerState, 'utf8')) as { calls?: string[] }).calls ?? []) : []
}

beforeEach(() => {
  dockerState = join(fx.tmp, 'docker.json')
  const containers = [
    { Id: 'stale', Name: `/mysql-migration-check-${DEAD_PID}`, Image: 'sha256:m', State: { Running: true }, Config: { Labels: { 'fos-assistant.temp': 'true' } } },
    { Id: 'live', Name: `/mysql-migration-check-${process.pid}`, Image: 'sha256:m', State: { Running: true }, Config: { Labels: { 'fos-assistant.temp': 'true' } } },
    { Id: 'company', Name: '/mysql-migration-check-1', Image: 'sha256:m', State: { Running: true }, Config: { Labels: {} } },
  ]
  writeFileSync(dockerState, JSON.stringify({ containers, calls: [] }))
  const bin = linkBin(
    fx.tmp,
    'docker',
    `
const fs = require('node:fs')
const file = process.env.DOCKER_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const argv = process.argv.slice(2)
st.calls.push(argv.join(' '))
fs.writeFileSync(file, JSON.stringify(st))
if (argv[0] === 'ps') console.log(st.containers.map((c) => c.Id).join('\\n'))
else if (argv[0] === 'container' && argv[1] === 'inspect') console.log(JSON.stringify(st.containers))
`,
  )
  fx.env.DOCKER_STATE = dockerState
  fx.env.DOCKER = bin
})

const RULES = { docker: { containers: [{ label: 'fos-assistant.temp', name: 'mysql-migration-check-(?<pid>\\d+)' }] } }

describe('Docker 자원', () => {
  test('dry-run 은 띄운 프로세스가 없는 선언 컨테이너를 지울 것으로만 낸다', () => {
    config(RULES)
    const out = runSweep()
    has(out, `Docker 컨테이너 지울 것 mysql-migration-check-${DEAD_PID} (stale)`)
    has(out, `Docker 컨테이너 남김 mysql-migration-check-${process.pid} (live): `)
    assert.ok(!out.includes('(company)'), out)
    assert.ok(!dockerCalls().some((c) => c.startsWith('rm')), dockerCalls().join('\n'))
  })

  test('--apply 는 그 컨테이너만 익명 볼륨과 함께 지운다', () => {
    config(RULES)
    const out = runSweep(['--apply'])
    has(out, `Docker 컨테이너 삭제 mysql-migration-check-${DEAD_PID} (stale)`)
    assert.deepEqual(
      dockerCalls().filter((c) => c.startsWith('rm')),
      ['rm -f -v stale'],
    )
  })

  test('docker 절이 없으면 docker 를 부르지 않는다', () => {
    runSweep(['--apply'])
    assert.deepEqual(dockerCalls(), [])
  })

  test('docker 절이 틀리면 다른 정리는 하고 2 로 끝난다', () => {
    config({ docker: { containers: [{ volume: true }] } })
    const { stdout, stderr } = runSweepFull(['--apply'], { code: 2 })
    has(stdout, 'cleanup-sweep apply')
    has(stderr, 'Docker 정리를 하지 않는다')
    assert.deepEqual(dockerCalls(), [])
  })
})
