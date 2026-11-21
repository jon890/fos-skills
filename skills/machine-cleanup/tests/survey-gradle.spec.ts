// survey_gradle 의 명령 경계 테스트. 임시 HOME 의 ~/.gradle 만 읽고 pgrep 은 가짜 실행 파일이다.

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'

const TOOLS = ['mktemp', 'find', 'grep', 'head', 'sort', 'awk', 'du', 'basename', 'rm', 'cat']

function setup(daemons: string[] = []) {
  const box = new Sandbox('mc-', TOOLS)
  const gradle = (rel: string) => join(box.home, '.gradle', rel)
  const dirs = (...rels: string[]) => {
    for (const rel of rels) write(gradle(`${rel}/f`), 'x'.repeat(100))
  }
  const root = join(box.root, 'projects')
  mkdirSync(root)
  const wrapper = (project: string, text: string, base = root) => write(join(base, project, 'gradle/wrapper/gradle-wrapper.properties'), text)
  box.fake('pgrep', [{ stdout: daemons.map((v) => `4242 java -cp /x/gradle-${v}/lib/gradle-launcher.jar GradleDaemon\n`).join('') }])
  const run = (args: string[] = [root]) => box.run('survey_gradle', args)
  const tail = (out: string, title: string) => out.slice(out.indexOf(`## ${title}`))
  const section = (out: string, title: string) => {
    const start = out.indexOf(`## ${title}`)
    const next = out.indexOf('\n## ', start + 1)
    return out.slice(start, next < 0 ? undefined : next)
  }
  return { box, root, gradle, dirs, wrapper, run, section, tail }
}

const SIZE = '\\S+'

describe('절 구성', () => {
  test('네 절을 순서대로 내고 마지막 문장으로 끝난다', () => {
    const { run } = setup()
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, '## wrapper 버전과 사용처\n\n## 캐시된 배포판과 크기\n\n## 실행 중 데몬 버전\n없음\n\n## 삭제 후보 (사용처도 데몬도 없는 버전)\n없음\n지워도 wrapper 가 필요할 때 다시 받는다.\n')
  })

  test('wrapper 버전은 한 줄에 버전과 프로젝트 폴더이고 줄 전체를 정렬한다', () => {
    const { root, wrapper, run, section } = setup()
    wrapper('b', 'distributionUrl=https://services.gradle.org/distributions/gradle-8.10.2-bin.zip\n')
    wrapper('a', 'distributionUrl=https://services.gradle.org/distributions/gradle-8.5-all.zip\n')
    wrapper('c', '# 주석\ndistributionUrl=https\\://x/gradle-7.6.4-bin.zip\ndistributionUrl=https://x/gradle-9.0.0-bin.zip\n')
    wrapper('none', 'distributionUrl=https://x/custom.zip\n')
    wrapper('nodot', 'distributionUrl=https://x/gradle-8-bin.zip\n')
    const part = section(run().stdout, 'wrapper 버전과 사용처')
    assert.equal(part, `## wrapper 버전과 사용처\n${'7.6.4'.padEnd(8)} ${join(root, 'c')}\n${'8.10.2'.padEnd(8)} ${join(root, 'b')}\n${'8.5'.padEnd(8)} ${join(root, 'a')}\n`)
  })

  test('같은 버전이 여러 프로젝트에 있으면 줄마다 낸다', () => {
    const { root, wrapper, run, section } = setup()
    wrapper('x', 'distributionUrl=https://x/gradle-8.1.0-bin.zip\n')
    wrapper('y', 'distributionUrl=https://x/gradle-8.1.0-all.zip\n')
    assert.equal(section(run().stdout, 'wrapper 버전과 사용처'), `## wrapper 버전과 사용처\n${'8.1.0'.padEnd(8)} ${join(root, 'x')}\n${'8.1.0'.padEnd(8)} ${join(root, 'y')}\n`)
  })

  test('node_modules, worktrees, .orca-worktree-trash 아래와 깊이 6 밖은 보지 않는다', () => {
    const { root, wrapper, run, section } = setup()
    const text = 'distributionUrl=https://x/gradle-8.1.0-bin.zip\n'
    wrapper('ok', text)
    wrapper('deep/a/b', text) // root/deep/a/b/gradle/wrapper/file → 깊이 6
    wrapper('deep/a/b/c', text) // 깊이 7
    wrapper('node_modules/x', text)
    wrapper('worktrees/x', text)
    wrapper('p/.orca-worktree-trash/x', text)
    wrapper('p/sub/node_modules/x', text)
    const part = section(run().stdout, 'wrapper 버전과 사용처')
    const paths = part.split('\n').slice(1).filter(Boolean).map((l) => l.slice(9))
    assert.deepEqual(paths, [join(root, 'deep/a/b'), join(root, 'ok')])
  })

  test('루트가 심볼릭 링크면 내려가지 않고 폴더가 아닌 루트는 건너뛴다', () => {
    const { box, root, wrapper, run, section } = setup()
    wrapper('p', 'distributionUrl=https://x/gradle-8.1.0-bin.zip\n')
    const link = join(box.root, 'link')
    symlinkSync(root, link)
    const out = run([link, join(box.root, 'missing'), '']).stdout
    assert.equal(section(out, 'wrapper 버전과 사용처'), '## wrapper 버전과 사용처\n')
  })

  test('루트를 여러 개 받는다', () => {
    const { box, root, wrapper, run, section } = setup()
    const other = join(box.root, 'other')
    wrapper('p', 'distributionUrl=https://x/gradle-8.1.0-bin.zip\n')
    wrapper('q', 'distributionUrl=https://x/gradle-7.0-bin.zip\n', other)
    const part = section(run([root, other]).stdout, 'wrapper 버전과 사용처')
    assert.equal(part, `## wrapper 버전과 사용처\n${'7.0'.padEnd(8)} ${join(other, 'q')}\n${'8.1.0'.padEnd(8)} ${join(root, 'p')}\n`)
  })

  test('인자가 없으면 ~/projects 와 ~/personal 을 본다', () => {
    const { box, wrapper, run, section } = setup()
    wrapper('a', 'distributionUrl=https://x/gradle-8.1.0-bin.zip\n', join(box.home, 'projects'))
    wrapper('b', 'distributionUrl=https://x/gradle-8.2.0-bin.zip\n', join(box.home, 'personal'))
    const part = section(run([]).stdout, 'wrapper 버전과 사용처')
    assert.equal(part, `## wrapper 버전과 사용처\n${'8.1.0'.padEnd(8)} ${join(box.home, 'projects/a')}\n${'8.2.0'.padEnd(8)} ${join(box.home, 'personal/b')}\n`)
  })
})

describe('캐시된 배포판', () => {
  test('dists, caches, daemon 에서 버전을 모아 정렬하고 크기를 보인다', () => {
    const { dirs, run, section } = setup()
    dirs('wrapper/dists/gradle-8.5-bin/h1', 'wrapper/dists/gradle-8.5-all/h2', 'caches/8.5', 'caches/8.10.2', 'daemon/9.0.0', 'caches/modules-2')
    const part = section(run().stdout, '캐시된 배포판과 크기')
    const rows = part.split('\n').slice(1).filter(Boolean)
    assert.equal(rows.length, 3)
    assert.match(rows[0], new RegExp(`^8\\.10\\.2   dists -       caches ${SIZE}\\s+daemon -\\s*$`))
    assert.match(rows[1], new RegExp(`^8\\.5      dists ${SIZE}\\s+caches ${SIZE}\\s+daemon -\\s*$`))
    assert.match(rows[2], new RegExp(`^9\\.0\\.0    dists -       caches -       daemon ${SIZE}\\s*$`))
  })

  test('dists 의 파일은 건너뛰고 폴더만 센다', () => {
    const { gradle, dirs, run, section } = setup()
    dirs('caches/8.1.0')
    write(gradle('wrapper/dists/gradle-9.9.9-bin'), 'file')
    const part = section(run().stdout, '캐시된 배포판과 크기')
    assert.ok(!part.includes('9.9.9'))
    assert.ok(part.includes('8.1.0'))
  })
})

describe('du 출력', () => {
  test('BSD du -h 처럼 크기 앞에 공백이 있어도 첫 칸을 읽는다', () => {
    const { box, dirs, run, section, tail } = setup()
    dirs('wrapper/dists/gradle-9.8.0-bin/h1', 'caches/9.8.0', 'daemon/9.8.0')
    box.fake('du', [{ stdout: ' 15M\t/x/a\n' }])
    const out = run().stdout
    assert.match(section(out, '캐시된 배포판과 크기'), /\n9\.8\.0    dists 15M     caches 15M     daemon 15M    \n/)
    assert.ok(tail(out, '삭제 후보 (사용처도 데몬도 없는 버전)').includes('9.8.0    15M     ~/.gradle/caches/9.8.0\n'))
  })
})

describe('실행 중 데몬', () => {
  test('pgrep 줄에서 gradle-버전을 뽑아 정렬해 중복 없이 낸다', () => {
    const { run, section } = setup(['8.2.0', '7.6.4', '8.2.0'])
    assert.equal(section(run().stdout, '실행 중 데몬 버전'), '## 실행 중 데몬 버전\n7.6.4\n8.2.0\n')
  })

  test('버전이 없는 줄과 pgrep 이 없는 환경은 없음이다', () => {
    const { box, run, section } = setup()
    box.fake('pgrep', [{ stdout: '1 java GradleDaemon gradle-launcher\n' }])
    assert.equal(section(run().stdout, '실행 중 데몬 버전'), '## 실행 중 데몬 버전\n없음\n')
  })

  test('pgrep 이 실패해도 계속한다', () => {
    const { box, run } = setup()
    box.fake('pgrep', [{ code: 1 }])
    const done = run()
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('## 실행 중 데몬 버전\n없음\n'))
  })

  test('pgrep 은 GradleDaemon 을 -fl 로 찾는다', () => {
    const { box, run } = setup()
    const pgrep = box.fake('pgrep', [{ stdout: '' }])
    run()
    assert.deepEqual(pgrep.calls().map((c) => c.argv), [['-fl', 'GradleDaemon']])
  })
})

describe('삭제 후보', () => {
  test('후보 경로를 한 줄에 하나씩 보이고 같은 경로를 이은 rm -rf 한 줄을 낸다', () => {
    const { dirs, run, tail } = setup()
    dirs('wrapper/dists/gradle-9.8.0-bin/h1', 'caches/9.8.0', 'daemon/9.8.0')
    const part = tail(run().stdout, '삭제 후보 (사용처도 데몬도 없는 버전)')
    for (const rel of ['wrapper/dists/gradle-9.8.0-bin', 'caches/9.8.0', 'daemon/9.8.0']) assert.match(part, new RegExp(`(?:^|\\n)9\\.8\\.0    ${SIZE}\\s+~/\\.gradle/${rel.replaceAll('.', '\\.')}\\n`))
    assert.ok(part.includes('\n## 승인 뒤 돌릴 명령 (출력만 하고 돌리지 않는다)\nrm -rf ~/.gradle/wrapper/dists/gradle-9.8.0-bin ~/.gradle/caches/9.8.0 ~/.gradle/daemon/9.8.0\n'), part)
  })

  test('없는 경로는 나열하지 않는다', () => {
    const { dirs, run, tail } = setup()
    dirs('caches/9.8.0')
    const part = tail(run().stdout, '삭제 후보 (사용처도 데몬도 없는 버전)')
    assert.ok(part.includes('rm -rf ~/.gradle/caches/9.8.0\n'))
    assert.ok(!part.split('rm -rf')[1].includes('dists'))
  })

  test('사용처가 있거나 데몬이 도는 버전은 뺀다', () => {
    const { dirs, wrapper, run, tail } = setup(['8.2.0'])
    dirs('caches/8.1.0', 'caches/8.2.0', 'caches/8.3.0')
    wrapper('proj', 'distributionUrl=https://x/gradle-8.1.0-bin.zip\n')
    const part = tail(run().stdout, '삭제 후보 (사용처도 데몬도 없는 버전)')
    assert.ok(!part.includes('8.1.0') && !part.includes('8.2.0'))
    assert.ok(part.includes('rm -rf ~/.gradle/caches/8.3.0\n'))
  })

  test('후보가 없으면 없음이고 rm -rf 를 내지 않는다', () => {
    const { run, tail } = setup()
    const part = tail(run().stdout, '삭제 후보 (사용처도 데몬도 없는 버전)')
    assert.ok(part.includes('없음'))
    assert.ok(!part.includes('rm -rf'))
  })

  test('버전은 문자열 순서로 정렬해 후보를 나열한다', () => {
    const { dirs, run, tail } = setup()
    dirs('caches/9.1.0', 'caches/10.0.0', 'caches/8.14.1')
    const part = tail(run().stdout, '삭제 후보 (사용처도 데몬도 없는 버전)')
    assert.ok(part.includes('rm -rf ~/.gradle/caches/10.0.0 ~/.gradle/caches/8.14.1 ~/.gradle/caches/9.1.0\n'), part)
  })
})
