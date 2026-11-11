// 컨테이너 런타임 테스트의 공용 helper. 가짜 홈에 런타임별 데이터 디렉터리, 소켓 파일, 디스크 파일을 만들고 가짜 docker 와 du 를 둔다.
// 실제 런타임을 켜거나 끄지 않는다. 앱 번들 위치는 빈 임시 폴더로 돌려 이 머신의 /Applications 가 섞이지 않게 한다.

import { mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Sandbox, write } from './helpers.ts'

// 가짜 docker 가 아는 context 하나. responds 가 true 면 `docker --context 이름 info` 가 성공한다. df 는 `system df` 출력이다
export type FakeContext = { name: string; endpoint: string; responds?: boolean; df?: string }

type Home = { unix: (rel: string) => string; home: string }

export type RuntimeFixture = {
  dockerDesktop?: { kb?: number }
  orbstack?: { kb?: number }
  colima?: { profile: string; kb?: number }[]
  // 홈 아래 상대 경로의 파일. 알 수 없는 런타임의 소켓 같은 것이다
  files?: string[]
  // 홈 아래 `from` 이 `to` 를 가리키는 링크. `/var/run/docker.sock` 처럼 다른 소켓의 별칭이다
  links?: { from: string; to: string }[]
  // 홈 경로가 정해진 뒤에 context 목록을 만든다
  contexts?: (h: Home) => FakeContext[]
}

// 런타임 표의 경로(references/runtimes.md). 테스트가 구현의 상수를 가져다 쓰지 않도록 여기에 다시 적는다
export const PATHS = {
  dockerDesktopDisk: 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw',
  dockerDesktopSocket: '.docker/run/docker.sock',
  orbstackDisk: '.orbstack/data/data.img',
  orbstackSocket: '.orbstack/run/docker.sock',
  colimaDisk: (profile: string) => `.colima/_lima/_disks/${profile === 'default' ? 'colima' : `colima-${profile}`}/datadisk`,
  colimaSocket: (profile: string) => `.colima/${profile}/docker.sock`,
}

export function runtimeBox(fixture: RuntimeFixture = {}) {
  const box = new Sandbox('mc-', [])
  const home = box.home
  const unix = (rel: string) => `unix://${join(home, rel)}`
  const duRules: FakeRule[] = []
  const disk = (rel: string, kb: number | undefined) => {
    const path = write(join(home, rel))
    duRules.push({ args: ['-s', path], stdout: `${kb ?? 1024}\t${path}\n` })
  }
  if (fixture.dockerDesktop) {
    disk(PATHS.dockerDesktopDisk, fixture.dockerDesktop.kb)
    write(join(home, PATHS.dockerDesktopSocket))
  }
  if (fixture.orbstack) {
    disk(PATHS.orbstackDisk, fixture.orbstack.kb)
    write(join(home, PATHS.orbstackSocket))
  }
  for (const c of fixture.colima ?? []) {
    disk(PATHS.colimaDisk(c.profile), c.kb)
    write(join(home, PATHS.colimaSocket(c.profile)))
  }
  for (const rel of fixture.files ?? []) write(join(home, rel))
  for (const l of fixture.links ?? []) {
    mkdirSync(dirname(join(home, l.from)), { recursive: true })
    symlinkSync(join(home, l.to), join(home, l.from))
  }
  const dockerConfig = write(join(home, '.docker/config.json'), JSON.stringify({ currentContext: 'desktop-linux' }))
  box.fake('du', duRules)

  const contexts = fixture.contexts?.({ unix, home }) ?? []
  const rules: FakeRule[] = []
  for (const c of contexts) rules.push({ args: ['--context', c.name, 'info'], code: c.responds ? 0 : 1 })
  for (const c of contexts) if (c.df) rules.push({ args: ['--context', c.name, 'system', 'df'], stdout: c.df })
  for (const c of contexts) rules.push({ args: ['context', 'inspect', c.name], stdout: `${c.endpoint}\n` })
  rules.push({ args: ['context', 'ls'], stdout: contexts.map((c) => `${JSON.stringify({ Name: c.name, DockerEndpoint: c.endpoint, Current: false, Error: '' })}\n`).join('') })
  rules.push({ args: ['info'], code: 1 })
  const docker = box.fake('docker', rules)
  const appsDir = join(box.root, 'apps')
  mkdirSync(appsDir, { recursive: true })
  const env = (extra: Record<string, string | undefined> = {}) => box.env({ MAC_CLEANUP_APP_DIRS: appsDir, ...extra })
  return { box, docker, dockerConfig, appsDir, env, unix, home }
}

export type Row = { id: string; kind: string; label: string; state: string; local: boolean; context: string | null; contexts: string[]; disk_path: string | null; disk_bytes: number | null; start_command: string[] | null; reclaim: string; profile: string | null; endpoint: string | null }

// 조사 파일(`container_runtimes.ts --json-out`)의 런타임 한 줄을 손으로 만든다. 기본은 이 맥 안에서 켜진 런타임이다
export function makeRow(id: string, kind: string, label: string, extra: Partial<Row> = {}): Row {
  return { id, kind, label, state: 'running', local: true, context: id, contexts: [id], disk_path: null, disk_bytes: null, start_command: null, reclaim: 'none', profile: null, endpoint: null, ...extra }
}
