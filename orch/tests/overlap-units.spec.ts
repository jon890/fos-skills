// overlap_units 의 판정(lib/overlap.ts)은 순수 함수로, git 연동은 임시 저장소로 본다.
// 예시 경로는 가상의 모노레포(`modules/api/`, `modules/common/`)다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { groupMap, judge as judgeRaw, unitOf, verdictText } from '../scripts/lib/overlap.ts'
import type { JudgeOptions } from '../scripts/lib/overlap.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/overlap_units.ts', import.meta.url))
const SHARED = '^(modules/common/|build\\.gradle$|\\.github/)'
const DOCS = ['docs/*', '*.md']

function judge(pr: string[], base: string[], opts: JudgeOptions = {}) {
  return judgeRaw(pr, base, { sharedPaths: SHARED, docsGlobs: DOCS, ...opts })
}

function text(pr: string[], base: string[], opts: JudgeOptions = {}): string {
  return verdictText(judge(pr, base, opts))
}

describe('unitOf', () => {
  test('모듈 폴더가 단위다', () => {
    assert.equal(unitOf('modules/api/src/Main.java', 'modules/'), 'api')
    assert.equal(unitOf('modules/api/build.gradle', 'modules/'), 'api')
  })

  test('그 밖의 파일은 경로 자체가 단위다', () => {
    assert.equal(unitOf('README.txt', 'modules/'), 'README.txt')
    assert.equal(unitOf('scripts/run.sh', 'modules/'), 'scripts/run.sh')
    assert.equal(unitOf('modules/loose.txt', 'modules/'), 'modules/loose.txt')
  })

  test('접두는 폴더 경계다', () => {
    assert.equal(unitOf('modules-old/api/x', 'modules'), 'modules-old/api/x')
    assert.equal(unitOf('modules/api/x', 'modules'), 'api')
  })

  test('접두를 바꿀 수 있다', () => {
    assert.equal(unitOf('apps/web/src/a.ts', 'apps/'), 'web')
  })
})

describe('judge', () => {
  test('같은 모듈이면 갱신 필요다', () => {
    const v = judge(['modules/api/A.java'], ['modules/api/B.java', 'modules/web/C.java'])
    assert.equal(v.update, true)
    assert.equal(verdictText(v), '갱신 필요(단위 겹침: api)')
  })

  test('다른 모듈이면 바로 머지다', () => {
    const v = judge(['modules/api/A.java'], ['modules/web/C.java'])
    assert.equal(v.update, false)
    assert.equal(verdictText(v), '바로 머지')
  })

  test('PR 쪽에만 있는 공용 경로도 갱신 필요다', () => {
    assert.equal(text(['modules/common/Util.java'], ['modules/web/C.java']), '갱신 필요(공용 경로: modules/common/Util.java)')
  })

  test('base 쪽에만 있는 공용 경로도 갱신 필요다', () => {
    assert.equal(text(['modules/api/A.java'], ['build.gradle']), '갱신 필요(공용 경로: build.gradle)')
  })

  test('문서만 바꾼 PR 은 base 가 공용 경로를 바꿨어도 바로 머지다', () => {
    assert.equal(judge(['docs/guide.txt', 'README.md'], ['modules/common/Util.java']).update, false)
  })

  test('base 쪽 문서는 세지 않는다', () => {
    assert.equal(judge(['modules/api/A.java'], ['docs/api.md', 'modules/web/C.java']).update, false)
    assert.equal(judge(['docs/x.txt', 'modules/api/A.java'], ['docs/x.txt', 'modules/web/C.java']).update, false)
  })

  test('공용 경로처럼 보이는 문서는 공용 경로가 아니다', () => {
    assert.equal(judge(['modules/api/A.java'], ['.github/README.md'], { docsGlobs: ['*.md'] }).update, false)
  })

  test('base 에 새 코드가 없으면 바로 머지다', () => {
    assert.equal(judge(['modules/common/Util.java'], []).update, false)
    assert.equal(judge(['modules/common/Util.java'], ['docs/a.md']).update, false)
  })

  test('같은 일반 파일은 겹침이고 다른 파일은 아니다', () => {
    assert.equal(judge(['scripts/run.sh'], ['scripts/run.sh']).update, true)
    assert.equal(judge(['scripts/run.sh'], ['scripts/other.sh']).update, false)
  })

  test('공용 경로가 없으면 단위만 센다', () => {
    assert.equal(judgeRaw(['modules/common/Util.java'], ['modules/web/C.java'], { sharedPaths: '' }).update, false)
  })

  test('Python 의 이름 붙은 묶음을 쓴 공용 경로도 맞는다', () => {
    assert.equal(text(['modules/core/a.ts'], ['modules/web/b.ts'], { sharedPaths: '(?P<m>modules/core)/' }), '갱신 필요(공용 경로: modules/core/a.ts)')
    assert.equal(judge(['modules/api/a.ts'], ['modules/web/b.ts'], { sharedPaths: '(?P<m>modules/core)/' }).update, false)
  })

  test('묶은 단위는 한 단위로 센다', () => {
    const groups = [['web', 'bff']]
    assert.equal(text(['modules/web/A.ts'], ['modules/bff/B.java'], { groups }), '갱신 필요(단위 겹침: web+bff)')
    assert.equal(judge(['modules/bff/B.java'], ['modules/web/A.ts'], { groups }).update, true)
    assert.equal(judge(['modules/web/A.ts'], ['modules/bff/B.java']).update, false)
  })

  test('묶음은 다른 단위를 끌어들이지 않는다', () => {
    assert.equal(judge(['modules/web/A.ts'], ['modules/api/B.java'], { groups: [['web', 'bff']] }).update, false)
  })

  test('묶음 멤버는 일반 파일 단위여도 된다', () => {
    assert.equal(judge(['scripts/a.sh'], ['scripts/b.sh'], { groups: [['scripts/a.sh', 'scripts/b.sh']] }).update, true)
  })

  test('한 단위가 두 묶음에 들면 오류다. 같은 묶음을 두 번 적은 것은 모호하지 않다', () => {
    assert.throws(() => groupMap([['a', 'b'], ['b', 'c']]), /단위 b 가 묶음 둘에 들어 있다/)
    assert.deepEqual(Object.fromEntries(groupMap([['a', 'b'], ['a', 'b']])), { a: 'a+b', b: 'a+b' })
  })

  test('긴 이름 목록은 줄인다', () => {
    const pr = Array.from({ length: 6 }, (_, i) => `modules/m${i}/a`)
    const base = Array.from({ length: 6 }, (_, i) => `modules/m${i}/b`)
    assert.equal(text(pr, base), '갱신 필요(단위 겹침: m0, m1, m2 외 3)')
  })
})

// CI 에는 git 작성자 설정이 없고, 로컬의 전역 설정은 결과를 바꿀 수 있어 고정한다.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

describe('overlap_units 명령', () => {
  let repo: string

  function git(...args: string[]): void {
    const done = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
  }

  function write(name: string, body: string): void {
    const target = join(repo, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }

  function commit(message: string): void {
    git('add', '-A')
    git('commit', '-q', '-m', message)
  }

  function cli(extra: string[] = [], opts: { base?: string; head?: string } = {}): [number | null, string, string] {
    const args = ['--repo', repo, '--base', opts.base ?? 'main', '--head', opts.head ?? 'feature', '--shared-paths', SHARED, '--docs-glob', 'docs/*,*.md', ...extra]
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { encoding: 'utf8', env: GIT_ENV })
    return [done.status, done.stdout.trim(), done.stderr.trim()]
  }

  function diverge(prFile: string, baseFile: string | null): void {
    git('checkout', '-q', '-b', 'feature')
    write(prFile, 'pr')
    commit('pr')
    git('checkout', '-q', 'main')
    if (baseFile) {
      write(baseFile, 'base')
      commit('base')
    }
  }

  function deleteOnBranch(name: string): void {
    git('checkout', '-q', '-b', 'feature')
    unlinkSync(join(repo, name))
    commit('pr deletes')
    git('checkout', '-q', 'main')
  }

  // PR 을 갱신(base 를 merge)한 뒤 base 가 또 움직인 상태. 첫 base 변경은 PR 과 겹쳤다.
  function updatePrThenMoveBase(secondBaseFile: string): void {
    diverge('modules/api/B.java', 'modules/api/C.java')
    git('checkout', '-q', 'feature')
    git('merge', '-q', '--no-edit', 'main')
    git('checkout', '-q', 'main')
    write(secondBaseFile, 'second')
    commit('base again')
  }

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'overlap-units-')))
    git('init', '-q', '-b', 'main')
    write('modules/api/A.java', 'a')
    write('modules/web/W.java', 'w')
    commit('init')
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('모듈이 겹치면 1 과 갱신 필요다', () => {
    diverge('modules/api/B.java', 'modules/api/C.java')
    assert.deepEqual(cli(), [1, '갱신 필요(단위 겹침: api)', ''])
  })

  test('모듈이 겹치지 않으면 0 과 바로 머지다', () => {
    diverge('modules/api/B.java', 'modules/web/C.java')
    assert.deepEqual(cli(), [0, '바로 머지', ''])
  })

  test('PR 쪽 공용 경로', () => {
    diverge('modules/common/U.java', 'modules/web/C.java')
    const [code, out] = cli()
    assert.equal(code, 1)
    assert.match(out, /공용 경로: modules\/common\/U\.java/)
  })

  test('base 쪽 공용 경로', () => {
    diverge('modules/api/B.java', 'build.gradle')
    const [code, out] = cli()
    assert.equal(code, 1)
    assert.match(out, /공용 경로: build\.gradle/)
  })

  test('Python 의 이름 붙은 묶음으로 쓴 --shared-paths 가 공용 경로로 맞는다', () => {
    diverge('modules/core/U.java', 'modules/web/C.java')
    assert.deepEqual(cli(['--shared-paths', '(?P<m>modules/core)/']), [1, '갱신 필요(공용 경로: modules/core/U.java)', ''])
  })

  test('문서만 바꾼 PR', () => {
    diverge('docs/guide.txt', 'modules/api/C.java')
    assert.deepEqual(cli(), [0, '바로 머지', ''])
  })

  test('base 를 이미 합친 PR', () => {
    diverge('modules/api/B.java', 'modules/api/C.java')
    git('checkout', '-q', 'feature')
    git('merge', '-q', '--no-edit', 'main')
    assert.deepEqual(cli(), [0, '바로 머지', ''])
  })

  test('갱신한 뒤 다시 판정하면 그 뒤에 들어온 변경만 본다', () => {
    // 갱신한 PR 의 새 merge-base 는 이미 품은 base 다. 앞서 겹쳤던 api 변경은 다시 세지 않는다
    updatePrThenMoveBase('docs/guide.txt')
    assert.deepEqual(cli(), [0, '바로 머지', ''])
    git('checkout', '-q', 'main')
    write('modules/web/W.java', 'web again')
    commit('base web')
    assert.deepEqual(cli(), [0, '바로 머지', ''])
  })

  test('갱신한 뒤 새 변경이 겹치면 다시 갱신 필요다', () => {
    updatePrThenMoveBase('modules/api/D.java')
    assert.deepEqual(cli(), [1, '갱신 필요(단위 겹침: api)', ''])
  })

  test('base 에 새 커밋이 없다', () => {
    diverge('modules/api/B.java', null)
    assert.deepEqual(cli(), [0, '바로 머지', ''])
  })

  test('이름을 바꾼 파일은 옛 모듈도 센다', () => {
    git('checkout', '-q', '-b', 'feature')
    git('mv', 'modules/api/A.java', 'modules/web/A.java')
    commit('rename')
    git('checkout', '-q', 'main')
    write('modules/api/A.java', 'changed')
    commit('base')
    const [code, out] = cli()
    assert.equal(code, 1)
    assert.match(out, /api/)
  })

  test('--unit-group 옵션', () => {
    diverge('modules/api/B.java', 'modules/web/C.java')
    assert.deepEqual(cli(['--unit-group', 'api,web']), [1, '갱신 필요(단위 겹침: api+web)', ''])
    assert.deepEqual(cli(['--unit-group', 'api,db', '--unit-group', 'web,x']), [0, '바로 머지', ''])
  })

  test('서로 겹치는 단위 묶음은 판정하지 못한다', () => {
    diverge('modules/api/B.java', 'modules/web/C.java')
    const [code, , err] = cli(['--unit-group', 'api,web', '--unit-group', 'web,db'])
    assert.equal(code, 2)
    assert.ok(err.startsWith('오류:'), err)
  })

  test('없는 ref 는 판정하지 못한다', () => {
    diverge('modules/api/B.java', 'modules/web/C.java')
    const [code, out, err] = cli([], { head: 'nothing' })
    assert.equal(code, 2)
    assert.equal(out, '')
    assert.ok(err.startsWith('오류:'), err)
  })

  test('PR 이 지운 파일은 그 단위로 센다', () => {
    deleteOnBranch('modules/api/A.java')
    write('modules/api/C.java', 'base')
    commit('base')
    assert.deepEqual(cli(), [1, '갱신 필요(단위 겹침: api)', ''])
  })

  test('다른 단위에서 지운 파일은 겹치지 않는다', () => {
    deleteOnBranch('modules/web/W.java')
    write('modules/api/C.java', 'base')
    commit('base')
    assert.deepEqual(cli(), [0, '바로 머지', ''])
  })

  test('base 쪽에서 지운 파일도 그 단위로 센다', () => {
    git('checkout', '-q', '-b', 'feature')
    write('modules/api/B.java', 'pr')
    commit('pr')
    git('checkout', '-q', 'main')
    unlinkSync(join(repo, 'modules/api/A.java'))
    commit('base deletes')
    assert.deepEqual(cli(), [1, '갱신 필요(단위 겹침: api)', ''])
  })

  test('PR 이 지운 공용 경로는 공용 경로 겹침이다', () => {
    write('build.gradle', 'g')
    commit('gradle')
    deleteOnBranch('build.gradle')
    write('modules/web/C.java', 'base')
    commit('base')
    const [code, out] = cli()
    assert.equal(code, 1)
    assert.match(out, /공용 경로: build\.gradle/)
  })

  test('- 로 시작하는 --shared-paths 는 = 로 붙여 값으로 준다. 띄워 넘기면 판정하지 못한다', () => {
    diverge('modules/api/B.java', 'yarn-lock')
    const [code, out] = cli(['--shared-paths=-lock$'])
    assert.equal(code, 1)
    assert.match(out, /공용 경로: yarn-lock/)
    const [spaced, , err] = cli(['--shared-paths', '-lock$'])
    assert.equal(spaced, 2, err)
  })

  test('잘못된 --shared-paths 는 판정하지 못한다', () => {
    diverge('modules/api/B.java', 'modules/web/C.java')
    const [code, , err] = cli(['--shared-paths', '('])
    assert.equal(code, 2)
    assert.ok(err.startsWith('오류:'), err)
  })
})
