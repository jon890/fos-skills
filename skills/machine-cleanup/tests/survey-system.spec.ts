// survey_system 의 명령 경계 테스트. 시스템 명령은 모두 가짜 실행 파일이고 홈은 임시 폴더다.
// PATH 에는 가짜 폴더만 두므로 이 머신의 docker, mise, brew 가 섞이지 않는다.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Sandbox, write } from './helpers.ts'

// du 가짜의 규칙. 인자로 고르므로 호출 순서와 무관하다
const duDirs = (root: string, rows: [number, string][]): FakeRule => ({ args: ['-d1', root], stdout: `${rows.map(([kb, p]) => `${kb}\t${p}`).join('\n')}\n` })
const duSize = (path: string, kb: number): FakeRule => ({ args: ['-s', path], stdout: `${kb}\t${path}\n` })

type Setup = { ps?: string; psRss?: string; du?: FakeRule[]; extra?: (box: Sandbox) => void }

function setup(opts: Setup = {}) {
  const box = new Sandbox('mc-', [])
  box.fake('df', [{ stdout: 'Filesystem   Size Used Avail Capacity\n/dev/disk3s5 460Gi 300Gi 120Gi 72% /System/Volumes/Data\n' }])
  box.fake('sysctl', [{ args: ['hw.memsize'], stdout: '17179869184\n' }, { args: ['vm.swapusage'], stdout: 'vm.swapusage: total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n' }])
  box.fake('memory_pressure', [{ stdout: 'The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 42%\n' }])
  box.fake('vm_stat', [{ stdout: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\nPages occupied by compressor:   123456.\n' }])
  box.fake('uptime', [{ stdout: ' 9:41  up 3 days, 2:10, 4 users, load averages: 1.00 2.00 3.00\n' }])
  box.fake('tmutil', [{ stdout: 'Snapshots for disk /:\ncom.apple.TimeMachine.2026-11-08-094100.local\n' }])
  box.fake('ps', [{ args: ['rss=,command='], stdout: opts.psRss ?? '' }, { args: ['command='], stdout: opts.ps ?? '' }, { args: ['pid='], stdout: '' }])
  box.fake('du', opts.du ?? [])
  opts.extra?.(box)
  const run = (env: Record<string, string | undefined> = {}) => box.run('survey_system', [], { env: box.env(env) })
  return { box, home: box.home, run }
}

// 절 하나의 본문. 제목 줄 다음부터 다음 절 앞까지다
function section(out: string, title: string): string {
  const start = out.indexOf(`\n## ${title}\n`)
  assert.ok(start >= 0, `${title} 절이 없다`)
  const bodyStart = start + `\n## ${title}\n`.length
  const next = out.indexOf('\n## ', bodyStart)
  return out.slice(bodyStart, next < 0 ? undefined : next)
}

const TITLES = [
  '디스크 (APFS 데이터 볼륨)',
  '메모리와 스왑',
  '앱별 RSS 합계 상위 15',
  '큰 디렉터리',
  '도구 캐시',
  '업데이트 캐시 (*-updater, *.ShipIt)',
  '~/.cache 하위 (큰 것)',
  'Codex 이전 버전',
  'Cursor snapshots',
  'mise prune --dry-run',
  '로컬 스냅샷과 휴지통',
]

describe('절 순서와 앞 절', () => {
  test('절을 정해진 순서로 낸다', () => {
    const { run } = setup()
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    const titles = done.stdout.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3))
    assert.deepEqual(titles, TITLES)
    assert.ok(done.stdout.startsWith('\n## 디스크'))
  })

  test('디스크, 메모리와 스왑, 앱별 RSS', () => {
    const { run } = setup({ psRss: ['2097152 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --x', '1048576 /Applications/Google Chrome.app/Contents/Helper', ' 524288 /usr/bin/python3 script.py', '12', 'x /bin/ls', '300 /bin/sh'].join('\n') + '\n' })
    const out = run().stdout
    assert.equal(section(out, '디스크 (APFS 데이터 볼륨)'), 'Filesystem   Size Used Avail Capacity\n/dev/disk3s5 460Gi 300Gi 120Gi 72% /System/Volumes/Data\n')
    assert.equal(section(out, '메모리와 스왑'), '실제 메모리: 16GB\nvm.swapusage: total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\nSystem-wide memory free percentage: 42%\n압축 메모리: 1929MB\n 9:41  up 3 days, 2:10, 4 users, load averages: 1.00 2.00 3.00\n')
    assert.equal(section(out, '앱별 RSS 합계 상위 15'), '   3.00GB  Google Chrome\n   0.50GB  python3\n   0.00GB  sh\n')
  })

  test('앱별 RSS 는 15개까지 보이고 .app 이 없으면 실행 파일 이름이다', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `${1048576 * (i + 1)} /opt/app${String(i).padStart(2, '0')}/bin/tool${i}`).join('\n')
    const { run } = setup({ psRss: `${rows}\n` })
    const lines = section(run().stdout, '앱별 RSS 합계 상위 15').split('\n').filter(Boolean)
    assert.equal(lines.length, 15)
    assert.equal(lines[0], '  20.00GB  tool19')
    assert.equal(lines[14], '   6.00GB  tool5')
  })

  test('메모리 명령이 없거나 실패하면 그 줄만 빠진다', () => {
    const { box, run } = setup()
    box.fake('sysctl', [{ code: 1 }])
    box.fake('memory_pressure', [{ stdout: '\n' }])
    box.fake('vm_stat', [{ stdout: 'garbage\n' }])
    box.fake('uptime', [{ code: 1 }])
    assert.equal(section(run().stdout, '메모리와 스왑'), '')
  })

  test('df 가 실패하면 읽지 못했다고 낸다', () => {
    const { box, run } = setup()
    box.fake('df', [{ code: 1 }])
    assert.equal(section(run().stdout, '디스크 (APFS 데이터 볼륨)'), 'df 를 읽지 못했다\n')
  })

  test('실제 메모리는 GiB 로 내림한다', () => {
    const { box, run } = setup()
    box.fake('sysctl', [{ args: ['hw.memsize'], stdout: '8589934591\n' }])
    assert.ok(section(run().stdout, '메모리와 스왑').startsWith('실제 메모리: 7GB\n'))
  })
})

describe('큰 디렉터리와 도구 캐시', () => {
  test('홈과 Library 아래의 큰 항목을 크기 순으로 보이고 자신은 포함한다', () => {
    const { home, run } = setup({
      du: [],
      extra: (b) => {
        mkdirSync(join(b.home, 'Library/Caches'), { recursive: true })
        mkdirSync(join(b.home, 'Library/Application Support'), { recursive: true })
        const home = b.home
        b.fake('du', [
          duDirs(home, [[100, join(home, 'a')], [900, home], [900, join(home, '.cache')], [20480, join(home, 'big dir')], [5242880, join(home, 'huge')]]),
          duDirs(join(home, 'Library/Caches'), [[10, join(home, 'Library/Caches/x')], [3000, join(home, 'Library/Caches')]]),
        ])
      },
    })
    const sec = section(run().stdout, '큰 디렉터리').split('\n')
    assert.deepEqual(sec.slice(0, 6), ['-- ~ (상위 15)', `  5.0G  ${join(home, 'huge')}`, `   20M  ${join(home, 'big dir')}`, `  900K  ${home}`, `  900K  ${join(home, '.cache')}`, `  100K  ${join(home, 'a')}`])
    assert.equal(sec[6], '-- ~/Library/Caches (상위 10)')
    assert.equal(sec[7], `  2.9M  ${join(home, 'Library/Caches')}`)
    assert.equal(sec[9], '-- ~/Library/Application Support (상위 10)')
  })

  test('크기 서식: 10 미만은 소수 한 자리, 10 이상은 정수, 정확히 반인 값은 짝수로 반올림한다', () => {
    const { home, run } = setup({
      extra: (b) => {
        const h = b.home
        b.fake('du', [duDirs(h, [[1, join(h, 'k1')], [1536, join(h, 'm15')], [1792, join(h, 'm175')], [1280, join(h, 'm125')], [10240 + 512, join(h, 'm105')], [11, join(h, 'k11')], [1024 * 1024 * 1024 * 5, join(h, 't')]])])
      },
    })
    const rows = section(run().stdout, '큰 디렉터리').split('\n').slice(1, 8).map((l) => l.trim().split(/\s+/)[0])
    assert.deepEqual(rows, ['5.0T', '10M', '1.8M', '1.5M', '1.2M', '11K', '1K'])
  })

  test('도구 캐시는 있는 경로만 한 줄씩 낸다', () => {
    const { home, run } = setup({
      extra: (b) => {
        const h = b.home
        for (const d of ['.npm', '.npm/_npx', '.gradle', '.cache/uv', 'Library/Caches/ms-playwright', 'Library/Caches/ms-playwright-1', 'Library/Caches/other', 'pnpm-store', 'pipcache', 'brewcache']) mkdirSync(join(h, d), { recursive: true })
        b.fake('pnpm', [{ args: ['store', 'path'], stdout: `${join(h, 'pnpm-store')}\n` }])
        b.fake('pip3', [{ args: ['cache', 'dir'], stdout: `${join(h, 'pipcache')}\n` }])
        b.fake('brew', [{ args: ['--cache'], stdout: `${join(h, 'brewcache')}\n` }])
        b.fake('du', [duSize(join(h, '.npm'), 3000), duSize(join(h, '.npm/_npx'), 2900), duSize(join(h, '.gradle'), 40960), duSize(join(h, '.cache/uv'), 100), duSize(join(h, 'pnpm-store'), 2048), duSize(join(h, 'pipcache'), 12), duSize(join(h, 'brewcache'), 8), duSize(join(h, 'Library/Caches/ms-playwright'), 1100), duSize(join(h, 'Library/Caches/ms-playwright-1'), 1200)])
      },
    })
    const rows = section(run().stdout, '도구 캐시').split('\n').filter(Boolean)
    assert.deepEqual(rows, [
      `  2.9M\t${join(home, '.npm')}`,
      `  2.8M\t${join(home, '.npm/_npx')}`,
      `  2.0M\t${join(home, 'pnpm-store')}`,
      `   40M\t${join(home, '.gradle')}`,
      `  100K\t${join(home, '.cache/uv')}`,
      `   12K\t${join(home, 'pipcache')}`,
      `    8K\t${join(home, 'brewcache')}`,
      `  1.1M\t${join(home, 'Library/Caches/ms-playwright')}`,
      `  1.2M\t${join(home, 'Library/Caches/ms-playwright-1')}`,
    ])
  })

  test('경로를 못 읽거나 없는 캐시는 건너뛴다', () => {
    const { run } = setup({
      extra: (b) => {
        b.fake('pnpm', [{ code: 1 }])
        b.fake('pip3', [{ stdout: '\n' }])
        b.fake('brew', [{ stdout: '/nonexistent/cache\n' }])
      },
    })
    assert.equal(section(run().stdout, '도구 캐시'), '')
  })
})

describe('Docker', () => {
  test('컨테이너 런타임은 container_runtimes.ts 가 조사하므로 Docker 절도 docker 호출도 없다', () => {
    const { box, run } = setup({ extra: (b) => b.fake('docker', [{ args: ['info'] }, { args: ['system', 'df'], stdout: 'T\n' }]) })
    const done = run()
    assert.ok(!done.stdout.includes('\n## Docker\n'))
    assert.deepEqual(box.fake('docker', []).calls(), [])
  })
})

describe('업데이트 캐시', () => {
  test('대기 표시가 있으면 유지, 없으면 안전이고 이름순으로 낸다', () => {
    const { run, home } = setup({
      extra: (b) => {
        const caches = join(b.home, 'Library/Caches')
        write(join(caches, 'app-updater/pending/x'), '')
        write(join(caches, 'app-updater/update.zip'), 'z')
        write(join(caches, 'other.ShipIt/ShipIt_stderr.log'), 'log')
        write(join(caches, 'unrelated/f'), '')
        write(join(caches, 'z-updater/update-info.json'), '{}')
        b.fake('du', [duSize(join(caches, 'app-updater'), 262144), duSize(join(caches, 'other.ShipIt'), 4)])
      },
    })
    const caches = join(home, 'Library/Caches')
    assert.equal(section(run().stdout, '업데이트 캐시 (*-updater, *.ShipIt)'), `  256M  ${caches}/app-updater  유지(설치 대기 업데이트)  대기=pending,update.zip\n    4K  ${caches}/other.ShipIt  안전(대기 표시 없음)\n     ?  ${caches}/z-updater  유지(설치 대기 업데이트)  대기=update-info.json\n`)
  })

  test('이름이 비슷하지만 해당하지 않는 폴더는 뺀다', () => {
    const { run } = setup({
      extra: (b) => {
        for (const n of ['com.google.GoogleUpdater', 'updater-cache', 'ShipIt.old', 'orca']) mkdirSync(join(b.home, 'Library/Caches', n), { recursive: true })
      },
    })
    assert.equal(section(run().stdout, '업데이트 캐시 (*-updater, *.ShipIt)'), '해당 디렉터리 없음\n')
  })

  test('Caches 폴더가 없으면 해당 디렉터리 없음이다', () => {
    assert.equal(section(setup().run().stdout, '업데이트 캐시 (*-updater, *.ShipIt)'), '해당 디렉터리 없음\n')
  })
})

describe('~/.cache, Codex, Cursor', () => {
  test('큰 하위 디렉터리를 크기 순으로 보이고 마지막 수정과 사용 여부를 붙인다', () => {
    const old = Math.floor(Date.now() / 1000) - 90 * 86400 - 100
    const { run, home } = setup({
      extra: (b) => {
        const root = join(b.home, '.cache')
        for (const name of ['big', 'puppeteer', 'small']) {
          const f = write(join(root, name, 'blob'), 'x')
          utimesSync(f, old, old)
          utimesSync(join(root, name), old, old)
        }
        b.fake('ps', [{ args: ['rss=,command='] }, { args: ['command='], stdout: `node ${join(root, 'puppeteer')}/chrome/run\n` }])
        b.fake('du', [duDirs(root, [[1000000, root], [204800, join(root, 'big')], [409600, join(root, 'puppeteer')], [102399, join(root, 'small')]])])
      },
    })
    const rows = section(run().stdout, '~/.cache 하위 (큰 것)').split('\n').filter(Boolean)
    assert.deepEqual(rows, [`  400M  마지막 수정    90일 전  사용중  ${join(home, '.cache/puppeteer')}`, `  200M  마지막 수정    90일 전  프로세스 없음  ${join(home, '.cache/big')}`])
  })

  test('기준 이상인 하위 디렉터리가 없으면 기준을 알린다', () => {
    const { run } = setup({ extra: (b) => mkdirSync(join(b.home, '.cache'), { recursive: true }) })
    assert.equal(section(run().stdout, '~/.cache 하위 (큰 것)'), '100M 이상인 하위 디렉터리 없음\n')
  })

  test('.cache 가 없으면 해당 디렉터리 없음이다', () => {
    assert.equal(section(setup().run().stdout, '~/.cache 하위 (큰 것)'), '해당 디렉터리 없음\n')
  })

  test('Codex 릴리스는 current 와 실행 중인 경로를 남길 것으로 센다', () => {
    const { run, home } = setup({
      extra: (b) => {
        const rel = join(b.home, '.codex/packages/standalone/releases')
        for (const v of ['0.1', '0.2', '0.3']) mkdirSync(join(rel, v), { recursive: true })
        symlinkSync(join(rel, '0.3'), join(b.home, '.codex/packages/standalone/current'))
        b.fake('ps', [{ args: ['rss=,command='] }, { args: ['command='], stdout: `${join(rel, '0.2')}/bin/codex serve\n/other/path/0.1/bin/codex\n` }])
        b.fake('du', [duDirs(rel, [[300, join(rel, '0.3')], [100, join(rel, '0.1')], [900, rel], [200, join(rel, '0.2')]])])
      },
    })
    const rel = join(home, '.codex/packages/standalone/releases')
    assert.equal(section(run().stdout, 'Codex 이전 버전'), `  100K  0.1\n  200K  0.2 실행중\n  300K  0.3 current\n버전 3개, 합계 600K, 남길 것(current 또는 실행중) 2개\n`)
  })

  test('읽을 수 없는 폴더 아래 경로가 있어도 풀지 못한 채 계속한다', (ctx) => {
    let locked = ''
    const { run } = setup({
      extra: (b) => {
        const rel = join(b.home, '.codex/packages/standalone/releases')
        locked = join(rel, 'locked')
        mkdirSync(locked, { recursive: true })
        chmodSync(locked, 0)
        b.fake('du', [duDirs(rel, [[100, join(locked, '0.1')], [100, rel]])])
      },
    })
    ctx.after(() => chmodSync(locked, 0o755))
    const done = run()
    assert.equal(done.code, 0)
    assert.ok(section(done.stdout, 'Codex 이전 버전').startsWith('  100K  0.1\n'))
  })

  test('실행 중인 릴리스가 없으면 안내 줄을 더한다', () => {
    const { run } = setup({
      extra: (b) => {
        const rel = join(b.home, '.codex/packages/standalone/releases')
        mkdirSync(join(rel, '0.1'), { recursive: true })
        b.fake('du', [duDirs(rel, [[100, join(rel, '0.1')], [100, rel]])])
      },
    })
    assert.equal(section(run().stdout, 'Codex 이전 버전'), '  100K  0.1\n버전 1개, 합계 100K, 남길 것(current 또는 실행중) 0개\n이 경로를 실행 중인 프로세스 없음(실행 중 codex 는 다른 경로를 쓴다)\n')
  })

  test('Codex 폴더가 없으면 해당 디렉터리 없음이다', () => {
    assert.equal(section(setup().run().stdout, 'Codex 이전 버전'), '해당 디렉터리 없음\n')
  })

  test('Cursor snapshots 는 크기와 실행 여부를 보인다', () => {
    const snap = (b: Sandbox) => join(b.home, 'Library/Application Support/Cursor/snapshots')
    const off = setup({
      extra: (b) => {
        mkdirSync(snap(b), { recursive: true })
        b.fake('du', [duSize(snap(b), 8912896)])
      },
    })
    assert.equal(section(off.run().stdout, 'Cursor snapshots'), `  8.5G\t${snap(off.box)}\nCursor 실행 중: 아니오\n`)
    const on = setup({
      ps: '/Applications/Cursor.app/Contents/MacOS/Cursor --x\n',
      extra: (b) => {
        mkdirSync(snap(b), { recursive: true })
        b.fake('du', [duSize(snap(b), 1024)])
      },
    })
    assert.ok(section(on.run().stdout, 'Cursor snapshots').endsWith('Cursor 실행 중: 예\n'))
    const near = setup({
      ps: '/bin/zsh -l\n/usr/bin/vim Cursor.md\n',
      extra: (b) => mkdirSync(snap(b), { recursive: true }),
    })
    assert.ok(section(near.run().stdout, 'Cursor snapshots').endsWith('Cursor 실행 중: 아니오\n'))
    assert.equal(section(setup().run().stdout, 'Cursor snapshots'), '해당 디렉터리 없음\n')
  })
})

describe('mise 와 스냅샷', () => {
  const OUT = [
    'mise pruned configuration links [dryrun]',
    'mise gradle@9.5.0 is prunable: no tracked config or tool stub requires gradle',
    'mise gradle@9.5.0 [dryrun]   uninstall',
    'mise gradle@9.7.1 is prunable: no tracked config or tool stub requires gradle',
    'mise maven@3.9.11 is prunable: maven is required at 3.9.15 by ~/.config/mise/config.toml',
    'mise node@20.1.0 is prunable: x',
    'garbage line',
  ].join('\n')

  test('버전마다 크기와 실행중 표시를 보이고 별칭 링크 경로로 도는 프로세스도 실행중이다', () => {
    const { run } = setup({
      extra: (b) => {
        const data = join(b.home, '.local/share/mise')
        const tool = join(data, 'installs/node')
        mkdirSync(join(tool, '20.1.0'), { recursive: true })
        symlinkSync('./20.1.0', join(tool, '20'))
        mkdirSync(join(data, 'installs/gradle/9.5.0'), { recursive: true })
        b.fake('mise', [{ args: ['prune', '--dry-run'], stdout: OUT }])
        b.fake('ps', [{ args: ['rss=,command='] }, { args: ['command='], stdout: `${join(tool, '20')}/bin/node /h/hud.mjs\n${join(data, 'installs/gradle/9.5.0')}1/bin/java\n` }])
        b.fake('du', [duSize(join(tool, '20.1.0'), 3145728), duSize(join(data, 'installs/gradle/9.5.0'), 208)])
      },
    })
    const out = section(run().stdout, 'mise prune --dry-run')
    assert.equal(out, '  208K  gradle 9.5.0\n    없음  gradle 9.7.1\n    없음  maven 3.9.11\n  3.0G  node 20.1.0  실행중\n버전 4개, 남길 것(실행중) 1개\nmise prune 을 그대로 돌리지 않는다. 사용자가 고른 도구만 `mise uninstall 도구@버전` 으로 지운다. 실행중 표시가 붙은 버전은 남긴다\n')
  })

  test('MISE_DATA_DIR 이 데이터 폴더를 바꾼다', () => {
    const { box, run } = setup({
      extra: (b) => {
        const data = join(b.root, 'custom-mise')
        mkdirSync(join(data, 'installs/node/20.1.0'), { recursive: true })
        b.fake('mise', [{ args: ['prune', '--dry-run'], stdout: 'mise node@20.1.0 is prunable: x\n' }])
        b.fake('du', [duSize(join(data, 'installs/node/20.1.0'), 3145728)])
      },
    })
    const out = section(run({ MISE_DATA_DIR: join(box.root, 'custom-mise') }).stdout, 'mise prune --dry-run')
    assert.equal(out, '  3.0G  node 20.1.0\n버전 1개, 남길 것(실행중) 0개\nmise prune 을 그대로 돌리지 않는다. 사용자가 고른 도구만 `mise uninstall 도구@버전` 으로 지운다. 실행중 표시가 붙은 버전은 남긴다\n')
  })

  test('mise 가 없거나 실패하거나 후보가 없을 때의 한 줄', () => {
    assert.equal(section(setup().run().stdout, 'mise prune --dry-run'), 'mise 가 없어 건너뛴다\n')
    const fail = setup({ extra: (b) => b.fake('mise', [{ code: 1 }]) })
    assert.equal(section(fail.run().stdout, 'mise prune --dry-run'), 'mise prune --dry-run 을 읽지 못했다\n')
    const empty = setup({ extra: (b) => b.fake('mise', [{ stdout: 'mise scanning tracked configs ✓ done\n' }]) })
    assert.equal(section(empty.run().stdout, 'mise prune --dry-run'), '지울 수 있다고 본 버전 없음\n')
  })

  test('mise 의 stderr 도 합쳐서 읽는다', () => {
    const { run } = setup({ extra: (b) => b.fake('mise', [{ stderr: 'mise node@20.1.0 is prunable: x\n' }]) })
    assert.equal(section(run().stdout, 'mise prune --dry-run').split('\n')[0], '    없음  node 20.1.0')
  })

  test('로컬 스냅샷과 휴지통', () => {
    const { run, home } = setup({
      extra: (b) => {
        mkdirSync(join(b.home, '.Trash'), { recursive: true })
        b.fake('du', [duSize(join(b.home, '.Trash'), 5)])
      },
    })
    assert.equal(section(run().stdout, '로컬 스냅샷과 휴지통'), `Snapshots for disk /:\ncom.apple.TimeMachine.2026-11-08-094100.local\n    5K\t${join(home, '.Trash')}\n`)
  })

  test('인자를 받지 않는다', () => {
    const { box } = setup()
    assert.equal(box.run('survey_system', ['x']).code, 2)
    const help = box.run('survey_system', ['-h'])
    assert.equal(help.code, 0)
    assert.ok(help.stdout.startsWith('usage: '))
  })
})
