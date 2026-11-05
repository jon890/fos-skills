// 팀 내보내기 명령(scripts/export-to-team)의 명령 경계 테스트.
// 명령은 자기 위치의 상위 폴더를 원본 저장소로 쓴다. 그래서 임시 git 저장소에 명령을 복사하고,
// 내보내는 스킬과 도구마다 파일 하나를 커밋해 원본을 만든다. 팀 저장소는 빈 임시 폴더로 대신한다.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { git, gitEnv } from '../../modules/testkit/git.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo, REPO_ROOT } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const INTERPRETER = ['/bin/bash']
const SCRIPT = 'scripts/export-to-team.sh'
const FILES = ['scripts/export-to-team.sh', 'scripts/skill_paths.py']
// 내보내는 목록을 명령 파일에서 읽는다. 목록을 테스트에 다시 적지 않는다
function sharedNames(variable: 'SHARED_SKILLS' | 'SHARED_TOOLS'): string[] {
  const match = new RegExp(`^${variable}=\\(([^)]*)\\)$`, 'm').exec(readFileSync(join(REPO_ROOT, SCRIPT), 'utf8'))
  if (!match) throw new Error(`${variable} 를 찾지 못했다`)
  return match[1].split(/\s+/).filter(Boolean)
}
// ──

const EXPORT_ONLY = new Set(['content-preview', 'korean-check'])

type Env = { repo: string; team: string; sha: string; skill: string }

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function setup(t: { after(fn: () => void): void }): Env {
  const root = tempDir('export-team-', t)
  const repo = join(root, 'source')
  const team = join(root, 'team')
  mkdirSync(join(team, 'skills'), { recursive: true })
  copyFromRepo(repo, FILES)
  for (const dir of [...sharedNames('SHARED_SKILLS'), ...sharedNames('SHARED_TOOLS').map((name) => `tools/${name}`)]) {
    write(join(repo, dir, 'NOTE.md'), 'committed\n')
  }
  git(repo, ['init', '-q'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return { repo, team, sha: git(repo, ['rev-parse', 'HEAD']), skill: sharedNames('SHARED_SKILLS')[0] }
}

function run(e: Env, ...args: string[]) {
  return runCommand([...INTERPRETER, join(e.repo, SCRIPT), ...args], { env: { ...gitEnv(), TEAM_SKILLS_DIR: e.team } })
}

// 내보내는 스킬을 지금 배치(skills/, export-only-skills/)로 옮긴다
function nestSources(e: Env): void {
  for (const name of sharedNames('SHARED_SKILLS')) {
    const prefix = EXPORT_ONLY.has(name) ? 'export-only-skills' : 'skills'
    mkdirSync(join(e.repo, prefix), { recursive: true })
    renameSync(join(e.repo, name), join(e.repo, prefix, name))
  }
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('export-to-team 인자', () => {
  test('모르는 인자는 2 다', (t) => {
    const done = run(setup(t), '--nope')
    assert.equal(done.code, 2, done.stderr)
    assert.match(done.stderr, /알 수 없는 인자: --nope/)
  })

  test('--source-ref 에 값이 없으면 2 다', (t) => {
    const e = setup(t)
    for (const args of [['--source-ref'], ['--source-ref', '--apply']]) {
      const done = run(e, ...args)
      assert.equal(done.code, 2, args.join(' '))
      assert.match(done.stderr, /--source-ref 뒤에 커밋이나 브랜치를 준다/)
    }
  })

  test('없는 커밋은 2 다', (t) => {
    const done = run(setup(t), '--source-ref', 'no-such-ref-xyz')
    assert.equal(done.code, 2, done.stderr)
    assert.match(done.stderr, /커밋을 찾지 못했다: no-such-ref-xyz/)
  })

  test('팀 저장소가 없어도 없는 커밋은 2 다', (t) => {
    const e = setup(t)
    e.team = join(e.team, 'missing')
    const done = run(e, '--source-ref', 'no-such-ref-xyz')
    assert.equal(done.code, 2, done.stdout + done.stderr)
    assert.match(done.stderr, /커밋을 찾지 못했다: no-such-ref-xyz/)
  })

  test('팀 저장소가 없으면 건너뛰고 0 이다', (t) => {
    const e = setup(t)
    e.team = join(e.team, 'missing')
    const done = run(e)
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `팀 저장소가 없어 건너뛴다: ${e.team}\n`)
  })
})

describe('export-to-team 원본과 어긋남', () => {
  test('--source-ref 는 원본 줄에 SHA 를 적고 빈 팀 저장소와의 어긋남을 낸다', (t) => {
    const e = setup(t)
    const done = run(e, '--source-ref', 'HEAD')
    assert.equal(done.code, 1, done.stdout + done.stderr)
    const missing = [...sharedNames('SHARED_SKILLS').map((name) => `skills/${name}`), ...sharedNames('SHARED_TOOLS').map((name) => `tools/${name}`)]
      .map((dir) => `  없음   ${dir}/NOTE.md`)
    assert.equal(
      done.stdout,
      [`원본: HEAD (${e.sha})`, '팀 저장소의 사본이 원본과 어긋난다:', ...missing, '', `팀 저장소: ${e.team}`, `반영: ${SCRIPT} --apply`, ''].join('\n'),
    )
  })

  test('작업 트리의 커밋하지 않은 변경을 원본 줄에 적는다', (t) => {
    const e = setup(t)
    write(join(e.repo, e.skill, 'NOTE.md'), 'uncommitted\n')
    assert.match(run(e).stdout, new RegExp(`^원본: 작업 트리 \\(HEAD ${e.sha}\\), 커밋하지 않은 변경 있음\n`))
  })

  test('git 저장소가 아니어도 기본 경로는 돈다', (t) => {
    const e = setup(t)
    rmSync(join(e.repo, '.git'), { recursive: true })
    const done = run(e)
    assert.equal(done.code, 1, done.stdout + done.stderr)
    assert.ok(done.stdout.startsWith('원본: 작업 트리 (git 저장소 아님)\n'))
    assert.ok(done.stdout.includes(`  없음   skills/${e.skill}/NOTE.md\n`))
  })

  test('--source-ref 는 작업 트리를 보지 않는다', (t) => {
    const e = setup(t)
    write(join(e.repo, e.skill, 'NOTE.md'), 'uncommitted\n')
    const applied = run(e, '--source-ref', 'HEAD', '--apply')
    assert.equal(applied.code, 0, applied.stdout + applied.stderr)
    assert.ok(applied.stdout.includes('팀 저장소에 내보냈다:\n'))
    assert.ok(applied.stdout.endsWith(`\n${e.team} 에서 커밋해야 팀에 전파된다.\n`))
    assert.equal(read(join(e.team, 'skills', e.skill, 'NOTE.md')), 'committed\n')
    const drift = run(e)
    assert.equal(drift.code, 1)
    assert.ok(drift.stdout.includes(`  다름   skills/${e.skill}/NOTE.md\n`))
  })

  test('같으면 0 이고 같다고 적는다', (t) => {
    const e = setup(t)
    assert.equal(run(e, '--apply').code, 0)
    const done = run(e)
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `원본: 작업 트리 (HEAD ${e.sha})\n팀 저장소의 사본이 원본과 같다.\n`)
  })

  test('팀에만 남은 파일은 남음이고 --apply 가 지운다', (t) => {
    const e = setup(t)
    assert.equal(run(e, '--apply').code, 0)
    write(join(e.team, 'skills', e.skill, 'extra', 'OLD.md'), 'old\n')
    const drift = run(e)
    assert.equal(drift.code, 1)
    assert.ok(drift.stdout.includes(`  남음   skills/${e.skill}/extra/OLD.md\n`))
    assert.equal(run(e, '--apply').code, 0)
    assert.ok(!existsSync(join(e.team, 'skills', e.skill, 'extra', 'OLD.md')))
  })

  test('팀 쪽 버전이 더 높으면 3 이고 아무것도 덮지 않는다', (t) => {
    const e = setup(t)
    write(join(e.repo, e.skill, 'SKILL.md'), '---\nname: x\nmetadata:\n  version: "1.2.0"\n---\n')
    write(join(e.team, 'skills', e.skill, 'SKILL.md'), '---\nname: x\nversion: 1.10.0\n---\n')
    const done = run(e, '--apply')
    assert.equal(done.code, 3)
    assert.ok(done.stdout.includes(`팀 저장소의 버전이 더 높다. 내보내면 팀의 수정을 되돌린다:\n  ${e.skill}: 팀 1.10.0 > 이 저장소 1.2.0\n`))
    assert.ok(!existsSync(join(e.team, 'skills', e.skill, 'NOTE.md')))
  })

  test('SKILL.md 의 metadata.version 은 팀의 최상위 version 으로 바꿔 쓴다', (t) => {
    const e = setup(t)
    write(join(e.repo, e.skill, 'SKILL.md'), '---\nname: x\nmetadata:\n  version: "1.2.0"\n---\n본문\n')
    assert.equal(run(e, '--apply').code, 0)
    assert.equal(read(join(e.team, 'skills', e.skill, 'SKILL.md')), '---\nname: x\nversion: 1.2.0\n---\n본문\n')
    assert.equal(run(e).code, 0)
  })
})

describe('export-to-team 이 내보내지 않는 파일과 권한', () => {
  test('개인 자산, 빌드 부산물, 런타임 상태는 내보내지 않는다', (t) => {
    const e = setup(t)
    for (const rel of ['references/work-writing-persona.md', '__pycache__/a.pyc', 'x.pyc', '.omc/s.json', '.orch/s.json', '.DS_Store', 'sub/.git/HEAD']) {
      write(join(e.repo, e.skill, rel), 'x\n')
    }
    assert.equal(run(e, '--apply').code, 0)
    const done = run(e)
    assert.equal(done.code, 0, done.stdout)
    for (const rel of ['references/work-writing-persona.md', '__pycache__', 'x.pyc', '.omc', '.orch', '.DS_Store', 'sub']) {
      assert.ok(!existsSync(join(e.team, 'skills', e.skill, rel)), rel)
    }
  })

  test('실행 비트를 함께 옮긴다', (t) => {
    const e = setup(t)
    write(join(e.repo, e.skill, 'run.sh'), 'x\n')
    chmodSync(join(e.repo, e.skill, 'run.sh'), 0o755)
    assert.equal(run(e, '--apply').code, 0)
    assert.equal(statSync(join(e.team, 'skills', e.skill, 'run.sh')).mode & 0o777, 0o755)
  })

  test('작업 트리에 내보낼 스킬이 없으면 2 다', (t) => {
    const e = setup(t)
    rmSync(join(e.repo, e.skill), { recursive: true })
    assert.equal(run(e).code, 2)
  })

  test('그 커밋에 내보낼 도구 폴더가 없으면 2 다', (t) => {
    const e = setup(t)
    git(e.repo, ['rm', '-q', '-r', 'tools'])
    git(e.repo, ['commit', '-q', '-m', 'no tools'])
    const done = run(e, '--source-ref', 'HEAD')
    assert.equal(done.code, 2)
    assert.match(done.stderr, /그 커밋에 내보낼 디렉터리가 없다: HEAD/)
  })
})

describe('export-to-team 의 변경 이력 조각', () => {
  test('조각은 내보내지 않고 어긋남으로도 보지 않는다', (t) => {
    const e = setup(t)
    write(join(e.repo, e.skill, 'changes', 'add-x.minor.md'), '- 새 기능\n')
    assert.equal(run(e, '--apply').code, 0)
    assert.ok(existsSync(join(e.team, 'skills', e.skill, 'NOTE.md')))
    assert.ok(!existsSync(join(e.team, 'skills', e.skill, 'changes')))
    assert.equal(run(e).code, 0)
  })

  test('팀 사본에 이미 있는 조각도 어긋남이 아니다', (t) => {
    const e = setup(t)
    assert.equal(run(e, '--apply').code, 0)
    write(join(e.team, 'skills', e.skill, 'changes', 'old.minor.md'), '- 옛 조각\n')
    assert.equal(run(e).code, 0)
  })
})

describe('export-to-team 의 링크 옮기기', () => {
  test('두 원본 루트 사이의 상대 링크를 팀 배치로 옮긴다', (t) => {
    const e = setup(t)
    nestSources(e)
    write(join(e.repo, 'skills/spec/NOTE.md'), '[규칙](../../export-only-skills/korean-check/NOTE.md)\n')
    run(e, '--apply')
    assert.equal(read(join(e.team, 'skills/spec/NOTE.md')), '[규칙](../korean-check/NOTE.md)\n')
    assert.equal(run(e).code, 0)
    git(e.repo, ['add', '-A'])
    git(e.repo, ['commit', '-q', '-m', 'move sources'])
    assert.equal(run(e, '--source-ref', 'HEAD').code, 0)
  })

  test('테스트 파일, 코드, Markdown 의 코드 부분은 그대로 둔다', (t) => {
    const e = setup(t)
    nestSources(e)
    const source = join(e.repo, 'skills/plan')
    const testSource =
      '"""[문서](../../export-only-skills/korean-check/NOTE.md)"""\n' +
      'LINK = "[문서](../../export-only-skills/korean-check/NOTE.md)"\n' +
      'def test_x():\n    assert "./.claude" in "cd frontend && bun test ./.claude"\n'
    write(join(source, 'tests/test_verify_task.py'), testSource)
    write(join(source, 'tests/fixture.md'), '[문서](../NOTE.md)\n')
    const code =
      'safe = "cd frontend && bun test ./.claude\\ncd frontend && bun test ./.claude"\n' +
      'command = "python3 -m unittest -v ./.github/scripts/tests/test_sync.py"\n' +
      'command = "bun test ./pkg/scripts/profile/"\n' +
      'command = "go test ./..."\n' +
      'link = "[문서](../../export-only-skills/korean-check/NOTE.md)"\n'
    write(join(source, 'example.py'), code)
    const markdown =
      '`[문서](../../export-only-skills/korean-check/NOTE.md)`\n' +
      '``[문서](../../export-only-skills/korean-check/NOTE.md) `code` ``\n' +
      '`여러 줄\n[문서](../../export-only-skills/korean-check/NOTE.md)`\n' +
      '```python\n' + code + '```\n' +
      '~~~markdown\n[문서](../../export-only-skills/korean-check/NOTE.md)\n~~~~\n' +
      '    [문서](../../export-only-skills/korean-check/NOTE.md)\n' +
      '평문 ./pkg/scripts/profile/\n' +
      '```미완성 코드 블록\n[문서](../../export-only-skills/korean-check/NOTE.md)\n'
    write(join(source, 'NOTE.md'), markdown)
    const done = run(e, '--apply')
    assert.equal(done.code, 0, done.stdout + done.stderr)
    const exported = join(e.team, 'skills/plan')
    assert.equal(read(join(exported, 'tests/test_verify_task.py')), testSource)
    assert.equal(read(join(exported, 'tests/fixture.md')), '[문서](../NOTE.md)\n')
    assert.equal(read(join(exported, 'example.py')), code)
    assert.equal(read(join(exported, 'NOTE.md')), markdown)
  })

  test('Markdown 링크 주소만 옮긴다', (t) => {
    const e = setup(t)
    nestSources(e)
    const fence = '~~~~markdown\n[문서](../../export-only-skills/korean-check/NOTE.md)\n~~~~~\n'
    write(
      join(e.repo, 'skills/plan/NOTE.md'),
      fence +
        '[문서](../../export-only-skills/korean-check/NOTE.md#section "제목")\n' +
        '[`문서`](<../../export-only-skills/korean-check/NOTE.md>)\n' +
        '[문서]: ../../export-only-skills/korean-check/NOTE.md "제목"\n' +
        '[폴더](../../export-only-skills/korean-check/)\n' +
        '[같은](./NOTE.md) [위](../spec/NOTE.md)\n' +
        '문자열 "../../export-only-skills/korean-check/NOTE.md"\n',
    )
    run(e, '--apply')
    assert.equal(
      read(join(e.team, 'skills/plan/NOTE.md')),
      fence +
        '[문서](../korean-check/NOTE.md#section "제목")\n' +
        '[`문서`](<../korean-check/NOTE.md>)\n' +
        '[문서]: ../korean-check/NOTE.md "제목"\n' +
        '[폴더](../korean-check)\n' +
        '[같은](./NOTE.md) [위](../spec/NOTE.md)\n' +
        '문자열 "../../export-only-skills/korean-check/NOTE.md"\n',
    )
  })

  test('어긋남 줄은 경로 조각 순서로 낸다', (t) => {
    const e = setup(t)
    write(join(e.repo, e.skill, 'a-c.md'), 'x\n')
    write(join(e.repo, e.skill, 'a', 'b.md'), 'x\n')
    const done = run(e)
    const lines = done.stdout.split('\n').filter((line) => line.includes(`skills/${e.skill}/`))
    assert.deepEqual(lines, [
      `  없음   skills/${e.skill}/NOTE.md`,
      `  없음   skills/${e.skill}/a/b.md`,
      `  없음   skills/${e.skill}/a-c.md`,
    ])
  })
})
