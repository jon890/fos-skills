// PR 변경 파일과 base 변경의 겹침 확인.

import { isDoc, judge } from '../../lib/overlap.ts'
import { NO_LIMIT_MS, run, scriptCommand } from '../../lib/proc.ts'
import type { StepState } from './model.ts'
import { chomp, git, log } from './runtime.ts'

export function fetchPrRefs(state: StepState): boolean {
  const p = state.p
  // 단일 브랜치 clone 이어도 origin/BASE 가 갱신되도록 대상 ref 를 명시한다
  if (git('fetch', '-q', 'origin', `+refs/heads/${p.base}:refs/remotes/origin/${p.base}`).code !== 0) return false
  if (git('cat-file', '-e', `${p.ph}^{commit}`).code !== 0) {
    git('fetch', '-q', 'origin', p.cross ? `refs/pull/${p.n}/head` : p.branch)
  }
  return git('cat-file', '-e', `${p.ph}^{commit}`).code === 0
}

export function names(state: StepState, ...args: string[]): string[] | null {
  // 겹침·문서 전용·합친 사본 검사는 이동 전 경로도 변경 목록에 포함해야 한다
  const done = git('diff', '--name-only', '--no-renames', ...args)
  return done.code !== 0 ? null : done.stdout.split('\n').filter((x) => x)
}

// PR 이 바꾼 파일 가운데 PR 이 갈라진 뒤 base 에서도 바뀐 파일. 판정하지 못하면 null
export function overlapFiles(state: StepState): string[] | null {
  const p = state.p
  if (!fetchPrRefs(state)) return null
  const mb = git('merge-base', `origin/${p.base}`, p.ph)
  if (mb.code !== 0) return null
  const mine = names(state, mb.stdout.trim(), p.ph)
  const theirs = names(state, mb.stdout.trim(), `origin/${p.base}`)
  if (mine === null || theirs === null) return null
  const other = new Set(theirs)
  return [...new Set(mine)].filter((file) => other.has(file)).sort()
}

// PR 이 base 에서 갈라진 뒤 바꾼 파일. 판정하지 못하면 null
export function prFiles(state: StepState): string[] | null {
  const p = state.p
  if (!fetchPrRefs(state)) return null
  const mb = git('merge-base', `origin/${p.base}`, p.ph)
  return mb.code !== 0 ? null : names(state, mb.stdout.trim(), p.ph)
}

// 앞지르기 하려는 PR 이 미룬 차례 PR 과 겹치는지. 판정은 --up-to-date-when overlap 과 같다(lib/overlap.ts 의 judge). 읽지 못하면 겹친 것으로 본다
export function overlapsDeferred(state: StepState): string | null {
  const against = state.against
  if (!against) return null
  const mine = prFiles(state)
  if (mine === null) return `#${against.n} 과 겹치는지 판정하지 못했다`
  const o = state.o
  const verdict = judge(mine, against.files, {
    sharedPaths: o.sharedPaths,
    unitPrefix: o.unitPrefix,
    docsGlobs: o.docsGlob.split(',').filter((g) => g),
    groups: o.unitGroups.map((group) => group.split(',')),
  })
  return verdict.update ? `#${against.n} 과 겹친다(${verdict.reason})` : null
}

// PR 이 바꾼 파일이 모두 --docs-glob 에 맞으면 true. 바꾼 파일이 없거나 판정하지 못하면 false
export function docsOnly(state: StepState): boolean {
  const p = state.p
  const mb = git('merge-base', `origin/${p.base}`, p.ph)
  if (mb.code !== 0) return false
  const files = names(state, mb.stdout.trim(), p.ph)
  const patterns = state.o.docsGlob.split(',').filter((g) => g)
  return files !== null && files.length > 0 && files.every((file) => isDoc(file, patterns))
}

// --up-to-date-when overlap: 최신화가 필요하면(판정하지 못한 경우 포함) true. 판정 한 줄은 여기서 찍는다
export function needsUpdate(state: StepState): boolean {
  const p = state.p
  const o = state.o
  if (!fetchPrRefs(state)) {
    log(`${p.n} 판정: 갱신 필요(판정 실패: PR HEAD 나 base 를 받지 못했다)`)
    return true
  }
  const judgedBase = git('rev-parse', '-q', '--verify', `origin/${p.base}`).stdout.trim()
  const done = run(
    scriptCommand(state.overlapUnits, [
      '--base',
      `origin/${p.base}`,
      '--head',
      p.ph,
      // 값이 `-` 로 시작해도 옵션으로 읽히지 않도록 `=` 로 붙여 넘긴다
      `--shared-paths=${o.sharedPaths}`,
      `--unit-prefix=${o.unitPrefix}`,
      `--docs-glob=${o.docsGlob}`,
      ...o.unitGroups.map((group) => `--unit-group=${group}`),
    ]),
    { timeoutMs: NO_LIMIT_MS },
  )
  // 옛 명령은 stderr 를 stdout 에 합쳐 읽었다. 판정 줄은 stdout 에, 오류는 stderr 에 나온다
  const verdict = chomp(done.stdout + done.stderr)
  if (done.code === 0) {
    log(`${p.n} 판정: ${verdict}`)
    // 판정한 base 를 적어 둔다. 머지 직전에 base 가 움직였는지 다시 본다
    p.judgedBase = judgedBase
    return false
  }
  if (done.code === 1) {
    log(`${p.n} 판정: ${verdict}`)
    return true
  }
  log(`${p.n} 판정: 갱신 필요(판정 실패: ${verdict.replaceAll('\n', ' ')})`)
  return true
}
