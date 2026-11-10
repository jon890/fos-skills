// 큐 시작 전 설정 확인과 임시 사본 정리.

import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, HOOKS_KEYS, loadConfig, PIPELINE_KEYS, section } from '../../lib/config.ts'
import { eventTimeoutSec, handlerFile } from '../../lib/events.ts'
import { ownAuthors } from '../../lib/gh.ts'
import { alive } from '../../lib/process.ts'
import type { QueueEvent, StepContext, StepResult } from './model.ts'
import { COPY_NAME, DOCS_ONLY_NOTE, QUEUE_EVENTS, Usage } from './model.ts'
import type { StepState } from './model.ts'
import { git, isDigits, isDir, log } from './runtime.ts'

export async function setup(stepContext: StepContext, state: StepState): Promise<StepResult<{ kind: 'ready' } | { kind: 'error'; error: Usage | ConfigError }>> {
  const changes = () => {
    const { repoDir, hooks, verify, realTmp, copyDir, ghRetries, ghRetrySeconds } = state
    return { repoDir, hooks, verify, realTmp, copyDir, ghRetries, ghRetrySeconds }
  }
  try {
    setupImpl(stepContext, state)
    return { kind: 'ready', changes: changes() }
  } catch (error) {
    if (!(error instanceof Usage || error instanceof ConfigError)) throw error
    return { kind: 'error', error, changes: changes() }
  }
}

function setupImpl(stepContext: StepContext, state: StepState): void {
  const o = state.o
  try {
    process.chdir(o.repo)
  } catch (e) {
    throw new Usage(`${o.repo} 로 이동하지 못했다: ${(e as Error).message}`)
  }
  state.repoDir = process.cwd()
  preflight(stepContext, state)
  const tmp = process.env.TMPDIR || '/tmp'
  if (!isDir(tmp)) throw new Usage(`TMPDIR 를 읽지 못했다: ${tmp}`)
  state.realTmp = realpathSync(tmp)
  state.copyDir = o.copyDir || state.realTmp
  readQueueEnv(stepContext, state)
  dropStaleCopies(stepContext, state)
}

// 스레드 수 명령의 기본값과 gh 재시도 환경 변수를 읽는다. 머지 큐와 `orch queue gate` 가 함께 쓴다
export function readQueueEnv(stepContext: StepContext, state: StepState): void {
  const o = state.o
  if (!o.threadsCmd) {
    // 옛 명령과 같은 글자를 내려고 정규화하지 않고 잇는다
    const rt = `${stepContext.here}/../../../review-fix/scripts/review_threads.ts`
    let found = false
    try {
      found = statSync(rt).isFile()
    } catch {
      found = false
    }
    if (!found) throw new Usage(`review_threads.ts 를 찾지 못했다: ${rt}. --threads-cmd 로 준다`)
    o.threadsCmd = `node '${rt}' list --count "$OWNER" "$REPO" "$PR"`
  }
  // 빈 값은 설정하지 않은 것으로 보고 기본값을 쓴다
  const retries = process.env.MERGE_QUEUE_GH_RETRIES || '3'
  const seconds = process.env.MERGE_QUEUE_GH_RETRY_SECONDS || '10'
  for (const [name, value] of [
    ['MERGE_QUEUE_GH_RETRIES', retries],
    ['MERGE_QUEUE_GH_RETRY_SECONDS', seconds],
  ]) {
    if (!isDigits(value)) throw new Usage(`${name} 는 정수다: '${value}'`)
  }
  state.ghRetries = Number(retries)
  state.ghRetrySeconds = Number(seconds)
}

// 큐를 시작하기 전에 설정과 핸들러를 본다. 여기서 내는 ConfigError 와 Usage 는 사용법 오류(종료 코드 2)다.
// fire 도 핸들러이 함께 있으면 ConfigError 를 내지만, after-queue 는 머지가 끝난 뒤에 나므로 fire 에만 맡기면
// 앞 PR 이 머지된 뒤에야 멈춘다. 설정 파일도 after-merge, after-queue, 쌓인 PR 판정이 머지 뒤에 읽으므로 여기서 먼저 읽는다
export function preflight(stepContext: StepContext, state: StepState): void {
  const o = state.o
  const repo = state.repoDir
  const config = loadConfig(repo)
  section(config, 'hooks', HOOKS_KEYS)
  const authors = section<{ authors?: unknown }>(config, 'pipeline', PIPELINE_KEYS).authors
  // 비지 않은 값이면 ownAuthors 는 gh 를 부르지 않고 타입만 본다. 틀리면 ConfigError 다
  if (authors !== undefined && !(Array.isArray(authors) && authors.length === 0)) ownAuthors(repo, '')
  for (const event of QUEUE_EVENTS) {
    if (handlerFile(event, repo)) state.hooks.add(event)
  }
  // 핸들러만 있고 옵션이 없어도 사본 검사가 빠지지 않게 겹침 판정을 켠다
  state.verify = state.hooks.has('verify-merged')
  if (state.verify) o.overlap = true
  const afterQueue = state.hooks.has('after-queue')
  if (!state.verify) {
    if (o.verifyWhen !== 'overlap') throw new Usage(`--verify-merged-when ${o.verifyWhen} 은 hooks/verify-merged.ts 와 함께 쓴다`)
    if (o.docsGlob && !(afterQueue || o.updateDocs || o.upToDateWhen === 'overlap')) throw new Usage(DOCS_ONLY_NOTE)
  }
  // 큐가 낼 이벤트의 시간 제한 값을 본다. after-merge 와 after-queue 는 머지 뒤에 나므로 fire 에만 맡기면 머지한 뒤에야 멈춘다
  const firing: [QueueEvent, boolean][] = [
    ['before-merge', state.hooks.has('before-merge')],
    ['verify-merged', state.verify],
    ['after-merge', state.hooks.has('after-merge')],
    ['after-queue', afterQueue],
  ]
  for (const [event, fires] of firing) if (fires) eventTimeoutSec(event, repo)
}

// 앞 실행이 KILL 로 끝나 남긴 사본을 지운다. 이름 끝의 pid 가 살아 있으면 다른 큐가 쓰는 중이다
export function dropStaleCopies(stepContext: StepContext, state: StepState): void {
  if (!isDir(state.copyDir)) return
  const names = readdirSync(state.copyDir)
    .filter((name) => COPY_NAME.test(name))
    .sort()
  for (const name of names) {
    const old = join(state.copyDir, name)
    if (!isDir(old)) continue
    const pid = name.slice(name.lastIndexOf('-') + 1)
    if (isDigits(pid) && alive(Number(pid))) continue
    removeCopy(stepContext, state, old)
    log(`끝난 실행(pid ${pid})이 남긴 사본을 지웠다: ${old}`)
  }
  git('worktree', 'prune')
}

export function removeCopy(stepContext: StepContext, state: StepState, path: string): void {
  if (git('worktree', 'remove', '--force', path).code !== 0) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // 옛 명령의 shutil.rmtree(ignore_errors=True) 와 같이 지우지 못한 것은 넘긴다. 다음 실행이 다시 지운다
    }
  }
}

export function dropCopy(stepContext: StepContext, state: StepState): void {
  if (!state.copy) return
  removeCopy(stepContext, state, state.copy)
  git('worktree', 'prune')
  state.copy = ''
}
