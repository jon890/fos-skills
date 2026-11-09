// ego 백엔드의 공간 선택을 가짜 ego API 로 본다. 실제 브라우저는 부르지 않는다.
// 가짜 ego-browser 가 드라이버가 stdin 으로 넘긴 스크립트에 가짜 API 를 붙여 Node 로 돌리고 그 stdout 을 낸다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { egoOut, type T } from './helpers.ts'
import { FunctionBox as Box } from './function-box.ts'

const FAKE_API = `
const profiles = async () => [{id: 'Default', name: 'Personal', isDefault: true}];
const listTaskSpaces = async () => fixture;
const fakePage = {
  label: 'p1', goto: async () => {}, waitForLoadState: async () => {},
  close: async () => { throw new Error('reset 은 page 를 하나씩 닫지 않고 finish 로 닫는다'); },
  url: async () => 'https://example.com'
};
const taskSpace = async (key, options) => {
  if (typeof key === 'string' && (!options || options.profileId !== 'Default')) {
    throw new Error('잘못된 프로필로 공간을 만들었다');
  }
  const spaceId = typeof key === 'number' ? key : 99;
  return {
    spaceId, page: () => fakePage, newPage: async () => fakePage,
    tabs: async () => tabsFixture,
    // 실제 ego 와 같은 규칙이다 (실측). 관리 중인 page 는 keep 에 없으면 닫고,
    // 사용자 탭(label 이 없는 것)이 남아 있거나 keep 이 있으면 공간을 닫지 않는다.
    finish: async (options) => {
      const labels = tabsFixture.filter((t) => t.label).map((t) => t.label);
      const kept = labels.filter((l) => options.keep.includes(l));
      const unmanaged = tabsFixture.filter((t) => !t.label).length;
      return {
        spaceId, closedSpace: kept.length === 0 && unmanaged === 0,
        keptManagedLabels: kept, closedManagedLabels: labels.filter((l) => !kept.includes(l)),
        preservedUnmanagedCount: unmanaged,
      };
    }
  };
};
`

type Space = { id: number; name: string; ownership: string; profileId?: string }
type Tab = { label?: string; openedBy: string; url: string }

function space(name: string, opts: { ownership?: string; profile?: string | null; id?: number } = {}): Space {
  const item: Space = { id: opts.id ?? 7, name, ownership: opts.ownership ?? 'agent' }
  const profile = opts.profile === undefined ? 'Default' : opts.profile
  if (profile !== null) item.profileId = profile
  return item
}

function setup(t: T, spaces: Space[] = [], tabs?: Tab[]) {
  const box = new Box(t)
  box.env.BROWSER_DRIVER = 'ego'
  const tabList = tabs ?? [{ label: 'p1', openedBy: 'agent', url: 'about:blank' }]
  const prelude = `const fixture = ${JSON.stringify(spaces)};\nconst tabsFixture = ${JSON.stringify(tabList)};\n${FAKE_API}`
  const fake = box.fake('ego-browser', [{ prelude }])
  return { box, fake }
}

function exec(t: T, args: string[], env: Record<string, string | undefined> = {}, spaces: Space[] = [], tabs?: Tab[]) {
  const { box, fake } = setup(t, spaces, tabs)
  const done = box.run(args, env)
  return { done, fake, stdout: done.stdout.replace(/\n$/, ''), box }
}

describe('open 의 공간 이름', () => {
  test('변수가 없거나 비면 기본 이름을 쓴다', (t) => {
    for (const value of [undefined, '']) {
      const { done } = exec(t, ['open', 'https://example.com'], { BROWSER_EGO_SPACE: value })
      assert.equal(done.code, 0, done.stderr)
      assert.equal(done.stdout, '99:p1\n')
      assert.ok(done.stderr.includes('공간: browser-driver/Default'))
    }
  })

  test('이름 양끝 공백은 지우고 한 줄로 알린다', (t) => {
    const { done } = exec(t, ['open', 'https://example.com'], { BROWSER_EGO_SPACE: '  월 공수 "등록"  ', BROWSER_EGO_PROFILE: 'Personal' })
    assert.equal(done.stdout, '99:p1\n')
    assert.ok(done.stderr.includes('공간: 월 공수 "등록"'))
    assert.ok(done.stderr.includes('BROWSER_EGO_PROFILE=Personal'))
    assert.equal(done.stderr.trimEnd().split('\n').length, 1)
    assert.equal(done.stderr, '프로필: Default (Personal) — BROWSER_EGO_PROFILE=Personal; 공간: 월 공수 "등록"\n')
  })

  test('사용자가 제어권을 가져간 공간 뒤에는 번호를 붙여 새로 만든다', (t) => {
    const spaces = [space('작업', { ownership: 'user' }), space('작업 #2', { ownership: 'user' })]
    const { done } = exec(t, ['open', 'https://example.com'], { BROWSER_EGO_SPACE: '작업' }, spaces)
    assert.equal(done.stdout, '99:p1\n')
    assert.ok(done.stderr.includes('공간: 작업 #3'))
  })

  test('번호 붙은 에이전트 공간은 다시 쓴다', (t) => {
    const spaces = [space('작업', { ownership: 'user' }), space('작업 #2', { id: 8 })]
    const { done } = exec(t, ['open', 'https://example.com'], { BROWSER_EGO_SPACE: '작업' }, spaces)
    assert.equal(done.stdout, '8:p1\n')
    assert.ok(done.stderr.includes('공간: 작업 #2'))
  })

  test('이름 준 공간은 프로필이 맞을 때만 다시 쓴다', (t) => {
    for (const profile of [null, 'Other']) {
      const { done } = exec(t, ['open', 'https://example.com'], { BROWSER_EGO_SPACE: '작업' }, [space('작업', { profile })])
      assert.equal(done.stdout, '99:p1\n')
      assert.ok(done.stderr.includes('공간: 작업 #2'))
    }
  })

  test('기본 이름의 공간은 프로필 없는 옛 공간도 다시 쓴다', (t) => {
    const { done } = exec(t, ['open', 'https://example.com'], {}, [space('browser-driver/Default', { profile: null })])
    assert.equal(done.stdout, '7:p1\n')
  })

  test('프로필을 정하지 않으면 경고를 낸다', (t) => {
    const { done } = exec(t, ['open', 'https://example.com'])
    assert.equal(done.stderr, '경고: 프로필을 정하지 않아 ego 의 기본 프로필로 돈다 (Default / Personal); 공간: browser-driver/Default\n')
  })

  test('빈 page 가 있으면 새로 만들지 않고 쓴다', (t) => {
    const { done, fake } = exec(t, ['open', 'https://example.com/a b'])
    assert.equal(done.code, 0)
    const script = fake.calls().at(-1)!.stdin
    assert.ok(script.includes('for (const t of await task.tabs())'))
    assert.ok(script.includes('await page.goto("https://example.com/a b");'))
    assert.ok(script.includes("await page.waitForLoadState('load', { timeout: 30000 });"))
  })

  test('open 의 준비 시간 인자를 스크립트에 넣는다', (t) => {
    const { fake, box } = setup(t)
    assert.equal(box.run(['open', 'about:blank', '1234']).code, 0)
    assert.ok(fake.calls().at(-1)!.stdin.includes("{ timeout: 1234 }"))
  })
})

describe('pages 와 reset', () => {
  test('pages 는 기본 이름을 그대로 쓴다', (t) => {
    const spaces = [space('browser-driver/Default', { id: 5 }), space('작업')]
    for (const value of [undefined, '']) {
      const { stdout } = exec(t, ['pages'], { BROWSER_EGO_SPACE: value }, spaces)
      assert.ok(stdout.startsWith('5:p1\t'), stdout)
      assert.equal(stdout, '5:p1\tagent\tabout:blank')
    }
  })

  test('기본 공간의 reset 은 ego 를 부르지 않고 거절한다', (t) => {
    for (const value of [undefined, '']) {
      const { done, fake } = exec(t, ['reset'], { BROWSER_EGO_SPACE: value })
      assert.equal(done.code, 2, done.stderr)
      assert.ok(done.stderr.includes('BROWSER_EGO_SPACE'))
      assert.equal(fake.calls().length, 0)
    }
  })

  test('pages 와 reset 은 고른 이름과 프로필의 공간만 대상으로 한다', (t) => {
    const spaces = [
      space('browser-driver/Default', { id: 1 }),
      space('作業', { profile: 'Other', id: 2 }),
      space('作業 #2', { id: 3 }),
      space('다른 작업', { id: 4 }),
    ]
    for (const cmd of ['pages', 'reset']) {
      const { done } = exec(t, [cmd, 'Personal'], { BROWSER_EGO_SPACE: '作業' }, spaces)
      assert.equal(done.code, 0, `${cmd}: ${done.stderr}`)
      assert.ok(done.stdout.startsWith('3:p1\t'), done.stdout)
    }
  })

  test('reset 은 공간을 닫고 닫은 탭을 알린다', (t) => {
    const { done } = exec(t, ['reset'], { BROWSER_EGO_SPACE: '작업' }, [space('작업', { id: 3 })])
    assert.equal(done.stdout, '3:p1\tabout:blank\n')
    assert.equal(done.stderr, 'reset 대상 프로필: (ego 의 기본 프로필) — 아무 호출자도 정하지 않았다\nreset 대상 공간: 3\n공간 3 를 닫았다\n')
  })

  test('reset 은 사용자 탭이 남으면 공간을 남긴다', (t) => {
    const tabs: Tab[] = [{ label: 'p1', openedBy: 'agent', url: 'https://a' }, { openedBy: 'user', url: 'https://user' }]
    const { done } = exec(t, ['reset'], { BROWSER_EGO_SPACE: '작업' }, [space('작업', { id: 3 })], tabs)
    assert.equal(done.stdout, '3:p1\thttps://a\n')
    assert.ok(done.stderr.includes('공간 3 는 닫지 않았다: 사용자 탭 1개'))
    assert.ok(!done.stderr.includes('공간 3 를 닫았다'))
    assert.ok(done.stderr.endsWith('에이전트가 연 page 만 닫았다. 남은 탭은 사용자가 닫는다\n'))
  })

  test('reset 은 소유를 모르는 page 를 남긴다', (t) => {
    const tabs: Tab[] = [{ label: 'p1', openedBy: 'agent', url: 'https://a' }, { label: 'p2', openedBy: 'unknown', url: 'https://u' }]
    const { done } = exec(t, ['reset'], { BROWSER_EGO_SPACE: '작업' }, [space('작업', { id: 3 })], tabs)
    assert.equal(done.stdout, '3:p1\thttps://a\n')
    assert.ok(done.stderr.includes('소유를 판정하지 못한 page p2'))
  })

  test('reset --space-id 는 공간 이름 변수를 보지 않는다', (t) => {
    const spaces = [space('남은 작업', { id: 9 })]
    for (const value of [undefined, '', '다른 이름']) {
      const { done } = exec(t, ['reset', '--space-id', '9'], { BROWSER_EGO_SPACE: value }, spaces)
      assert.equal(done.stdout, '9:p1\tabout:blank\n')
      assert.equal(done.stderr, 'reset 대상 공간: 9\n공간 9 를 닫았다\n')
    }
  })

  test('reset --space-id 는 사용자 공간, 기본 공간, 없는 공간을 거절한다', (t) => {
    const spaces = [space('남은 작업', { ownership: 'user', id: 5 }), space('browser-driver/Default', { id: 6 })]
    const cases: [string, string][] = [
      ['5', '공간 5 는 에이전트가 가진 공간이 아니다. 사용자가 제어권을 가져간 공간은 닫지 않는다'],
      ['6', '공간 6 는 기본 공간이라 닫지 않는다. 같은 프로필의 다른 호출자가 나눠 쓴다. pages 로 핸들을 보고 close 로 골라 닫는다'],
      ['77', '공간 77 가 없다. spaces 로 남은 공간을 다시 본다'],
    ]
    for (const [id, message] of cases) {
      const { done } = exec(t, ['reset', '--space-id', id], {}, spaces)
      assert.equal(done.code, 2, id)
      assert.equal(done.stderr, `${message}\n`)
    }
  })

  test('reset --space-id 는 유니코드 숫자 id 도 받는다', (t) => {
    const { done, fake } = exec(t, ['reset', '--space-id', '٩'], {}, [space('남은 작업', { id: 9 })])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(fake.calls().at(-1)!.stdin.includes('const targetId = 9;'))
  })

  test('공간이 없으면 없다고 알리고 아무것도 내지 않는다', (t) => {
    const { done } = exec(t, ['reset'], { BROWSER_EGO_SPACE: '작업' }, [space('다른', { id: 1 })])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '')
    assert.ok(done.stderr.endsWith('reset 대상 공간: (공간 없음)\n'))
  })

  test('pages 와 reset 은 관계없는 공간을 만들거나 쓰지 않는다', (t) => {
    const spaces = [space('browser-driver/Default'), space('작업', { ownership: 'user' })]
    for (const cmd of ['pages', 'reset']) {
      const { done } = exec(t, [cmd], { BROWSER_EGO_SPACE: '작업' }, spaces)
      assert.equal(done.code, 0, done.stderr)
      assert.equal(done.stdout, '')
    }
  })
})

describe('spaces', () => {
  const spaces = [space('fos 확인', { id: 3 }), space('fos 다른', { ownership: 'user', id: 4 }), space('다른 저장소', { id: 5 })]
  const tabs: Tab[] = [{ label: 'p1', openedBy: 'agent', url: 'a' }, { label: 'p2', openedBy: 'agent', url: 'b' }]

  test('에이전트 공간만 탭 수와 함께 낸다', (t) => {
    assert.equal(exec(t, ['spaces'], {}, spaces, tabs).done.stdout, '3\tfos 확인\t2\n5\t다른 저장소\t2\n')
    assert.equal(exec(t, ['spaces', 'fos'], {}, spaces, tabs).done.stdout, '3\tfos 확인\t2\n')
  })

  test('에이전트 공간이 없으면 아무것도 내지 않는다', (t) => {
    const { done } = exec(t, ['spaces'], {}, [space('작업', { ownership: 'user' })])
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })

  test('공간 이름 변수가 틀려도 상관하지 않는다', (t) => {
    const { done } = exec(t, ['spaces'], { BROWSER_EGO_SPACE: '\n' }, [space('작업', { id: 3 })])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.startsWith('3\t작업\t'))
  })
})

describe('공간 이름 검사', () => {
  test('틀린 이름은 백엔드를 부르기 전에 2 로 끝난다', (t) => {
    const { box, fake } = setup(t)
    const message = 'BROWSER_EGO_SPACE 는 공백뿐이거나 줄바꿈이 든 이름을 받을 수 없다\n'
    // 줄 경계는 str.splitlines 가 보는 것이다: \n \r \v \f \x1c~\x1e \x85 \u2028 \u2029
    const bad = ['  ', '\t', '작업\n이름', '작업\r', '\n작업', '작업\u2028이름', '\u0085', '작업\v', '작업\x1c', '작업\u2029', '\u3000']
    for (const value of bad) {
      for (const args of [['open', 'https://example.com'], ['pages'], ['reset']]) {
        const done = box.run(args, { BROWSER_EGO_SPACE: value })
        assert.equal(done.code, 2, `${JSON.stringify(value)} ${args[0]}`)
        assert.equal(done.stderr, message, `${JSON.stringify(value)} ${args[0]}`)
      }
    }
    assert.equal(fake.calls().length, 0)
  })

  test('가운데 공백이나 줄로 보지 않는 글자는 이름에 쓸 수 있다', (t) => {
    const { box } = setup(t)
    for (const value of ['작업 이름', '작업\u00a0이름', '작업\u200b이름', '작업\ufeff', '작업\x1f']) {
      const done = box.run(['open', 'https://example.com'], { BROWSER_EGO_SPACE: value })
      assert.equal(done.code, 0, `${JSON.stringify(value)}: ${done.stderr}`)
    }
  })

  test('doctor 도 틀린 이름이면 2 로 끝난다', (t) => {
    const { box } = setup(t)
    assert.equal(box.run(['doctor'], { BROWSER_EGO_SPACE: '   ' }).code, 2)
  })

  test('doctor 는 기본 이름과 지정한 이름을 설명한다', (t) => {
    const { box } = setup(t)
    assert.ok(box.run(['doctor']).stdout.includes('browser-driver/<해석된 프로필 id>'))
    assert.ok(box.run(['doctor'], { BROWSER_EGO_SPACE: '작업' }).stdout.includes('공간 해석: 작업'))
  })

  test('핸들을 받는 명령은 공간 이름 변수를 보지 않는다', (t) => {
    const { box, fake } = setup(t)
    fake.setRules([{ stdout: egoOut('') }])
    const cases: [string[], string][] = [
      [['url', '42:p1'], 'await page.url()'],
      [['close', '42:p1'], 'await page.close();'],
      [['nav', '42:p1', 'https://example.com'], 'page.goto("https://example.com")'],
      [['js', '42:p1', 'document.title'], 'document.title'],
    ]
    for (const [args, token] of cases) {
      const done = box.run(args, { BROWSER_EGO_SPACE: '\n' })
      assert.equal(done.code, 0, `${args[0]}: ${done.stderr}`)
      const script = fake.calls().at(-1)!.stdin
      assert.ok(script.includes('taskSpace(42)'), args[0])
      assert.ok(script.includes(token), args[0])
      assert.ok(!script.includes('listTaskSpaces'), args[0])
    }
  })
})
