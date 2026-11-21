// 홈서버 스크립트 테스트의 공용 helper. 가상 오버레이 값, 가짜 /proc, Hermes 세션 DB 를 만든다.
// 값은 모두 가상이다(`/srv/backup`, `example-user`). 실제 홈서버 값을 넣지 않는다.

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { write } from './helpers.ts'

type Json = Record<string, any>

// hs_overlay.ts 를 통과하는 가상 값. root 아래 경로를 쓴다
export function sampleConfig(root: string, extra: Json = {}): Json {
  return {
    host: 'example-host',
    lock: join(root, 'ops.lock'),
    checkout: join(root, 'checkout'),
    daily_prune: '03:00',
    backup: { root: join(root, 'srv/backup'), rules: 'docs/rules.md', section: '백업' },
    owned_images: [{ pattern: 'recovery/app-*', owner: '매일 정리', keep: 2 }],
    owned_paths: [{ path: '~/ci/logs', owner: 'CI 실행 스크립트' }],
    configured_images: { compose: ['services/*/compose.yaml'], dockerfile: ['services/*/Dockerfile'], settings: ['services/*/settings.json'], content_tags: [] },
    repos: [{ path: join(root, 'checkout') }],
    hermes: { container: 'agent', data: join(root, 'hermes-data'), delete: ['hermes-delete', '{profile}', '{session}'], linked: ['linked-sessions'] },
    ...extra,
  }
}

export const overlayMarkdown = (config: Json): string => `# 가상 홈서버 오버레이\n\n설명.\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`\n`

// 가짜 /proc. 프로세스마다 status(Uid, Name, VmSwap)와 cwd 링크를 둔다. cwd 가 null 이면 읽지 못하는 자리(일반 파일)를 둔다
export type FakeProc = { pid: number; uid: number; name?: string; swapKb?: number; cwd?: string | null }

export function fakeProc(root: string, procs: FakeProc[], meminfo = 'MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3000000 kB\n'): void {
  const proc = join(root, 'proc')
  write(join(proc, 'meminfo'), meminfo)
  for (const p of procs) {
    const dir = join(proc, String(p.pid))
    write(join(dir, 'status'), `Name:\t${p.name ?? 'proc'}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\nVmSwap:\t${p.swapKb ?? 0} kB\n`)
    if (p.cwd === null) writeFileSync(join(dir, 'cwd'), '')
    else if (p.cwd !== undefined) symlinkSync(p.cwd, join(dir, 'cwd'))
  }
}

// Hermes 세션 DB. rows 는 [id, parent, source, activity(초)]
export function hermesDb(path: string, rows: [string, string | null, string, number][]): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, last_activity_at REAL)')
  const insert = db.prepare('INSERT INTO sessions (id, source, parent_session_id, started_at, ended_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)')
  for (const [id, parent, source, activity] of rows) insert.run(id, source, parent, activity - 60, null, activity)
  db.close()
}

export const DAY = 86400
export const nowSec = (): number => Date.now() / 1000
