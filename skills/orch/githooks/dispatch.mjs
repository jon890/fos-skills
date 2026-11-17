#!/usr/bin/env node
// orch 가 worker 워크트리에 거는 git 훅 본체다. 워크트리의 훅 폴더(<git 관리 폴더>/orch-hooks)에 복사되고,
// 훅 이름마다 이 파일을 가리키는 심볼릭 링크로 불린다. 거는 일과 훅 폴더 구성은 scripts/lib/commit-check.ts 가 소유한다.
// 선택 이유는 docs/adr/036-worker-commit-korean-check.md 다.
//
// 타입 문법 없는 ESM 이고 Node 내장 모듈만 쓴다. 확장자가 .mjs 라 대상 저장소 package.json 의 type 과 상관없이 ESM 으로 읽힌다.
// 훅 이름은 불린 경로(process.argv[1])의 파일 이름이다. 심볼릭 링크로 불려도 그 값은 링크 이름이고, 훅 폴더는 실체 경로의 폴더다.
//
// 하는 일
//     1. 훅 이름이 pre-commit 이면 한국어 검사를 한다. 옆의 korean-check/scripts/check.ts --staged 를 부른다.
//        - 종료 코드가 1 이고 출력에 금지어 발견 줄(`: 금지어 "`)이 있으면 출력과 안내를 stderr 에 내고 1 로 끝난다. 원래 훅은 부르지 않는다.
//        - 0 이면 출력(경고)이 있을 때만 stderr 에 내고 이어 간다.
//        - 그 밖(2, 신호, 실행 실패, 발견 줄 없는 1)은 검사기가 돌지 못한 것이다. 알리고 이어 간다.
//          node 는 잡지 않은 예외에도 1 을 내므로 종료 코드만으로 거절하지 않는다. 도구 고장이 모든 커밋을 막지 않게 한다.
//        - 검사기 사본이 없거나 node 가 MIN_NODE 보다 낮아도 알리고 이어 간다.
//        - 머지, 리베이스, cherry-pick, revert 가 진행 중이면 검사하지 않는다. 그때 스테이징된 줄은 다른 브랜치에서 온 것이다.
//        - 자식 환경에서 KOREAN_STYLE_RULES, KOREAN_CHECK_ALLOW 는 지운다. 사본의 규칙과 저장소의 예외 파일을 읽게 한다.
//     2. 모든 훅 이름에서 저장소가 원래 쓰던 훅을 같은 인자와 표준 입출력으로 부르고 그 종료 코드로 끝난다.
//        git 은 core.hooksPath 가 있으면 원래 폴더를 보지 않으므로 여기서 이어 부른다.
//        - 원래 훅 폴더: `git config --show-scope --get-all core.hooksPath` 에서 범위가 system, global, local 인 마지막 값이다.
//          워크트리 범위(이 훅 폴더를 가리킨다)와 명령줄 범위는 뺀다. 상대 경로는 작업 디렉터리(워크트리 최상위) 기준이다.
//          그런 값이 없으면 <공통 git 폴더>/hooks 다. 실행할 때마다 다시 읽으므로 워크트리를 만든 뒤 설치된 훅도 불린다.
//        - 그 폴더가 이 훅 폴더 자신이거나, 훅 파일이 없거나 실행 권한이 없으면 부르지 않는다. git 도 실행 권한 없는 훅은 무시한다.
//        - shebang 없는 훅(ENOEXEC)은 git 처럼 /bin/sh 로 한 번 더 부른다.
//        - 원래 훅에는 환경 변수 ORCH_GITHOOK 에 「훅 폴더:훅 이름」 을 넣어 넘긴다. 같은 값을 받은 채 불리면 원래 훅이
//          이 훅을 다시 부른 것이라 아무것도 하지 않고 0 으로 끝난다(`git rev-parse --git-path hooks` 로 다음 훅을 찾는 훅).
//
// 종료 코드: 0 이어 간다, 1 금지어가 있어 커밋을 거절했거나 원래 훅을 실행하지 못했다, 그 밖은 원래 훅의 종료 코드(신호면 128 + 신호 번호)

import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const MIN_NODE = [24, 0]
const HOOKS = dirname(realpathSync(process.argv[1]))
const NAME = basename(process.argv[1])
const ARGS = process.argv.slice(2)
const BANNED_ROW = /: 금지어 "/
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
const MAX_BUFFER = 256 * 1024 * 1024
const MARK = `${HOOKS}:${NAME}`

function say(text) {
  process.stderr.write(`${text}\n`)
}

function git(args) {
  const done = spawnSync('git', args, { encoding: 'utf8' })
  return done.status === 0 ? done.stdout.trim() : null
}

function nodeTooOld() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])
}

// 0 이어 간다, 1 금지어가 있어 거절한다
function koreanCheck() {
  const gitDir = git(['rev-parse', '--absolute-git-dir'])
  if (gitDir && IN_PROGRESS.some((name) => existsSync(join(gitDir, name)))) return 0
  const checker = join(HOOKS, 'korean-check', 'scripts', 'check.ts')
  if (!existsSync(checker)) {
    say('orch 커밋 검사: 한국어 검사기 사본이 없어 점검을 건너뛴다')
    return 0
  }
  if (nodeTooOld()) {
    say(`orch 커밋 검사: Node ${process.versions.node} 은 한국어 검사기를 돌리지 못해 점검을 건너뛴다`)
    return 0
  }
  const env = { ...process.env }
  delete env.KOREAN_STYLE_RULES
  delete env.KOREAN_CHECK_ALLOW
  const done = spawnSync(process.execPath, [checker, '--staged'], { encoding: 'utf8', env, maxBuffer: MAX_BUFFER })
  const report = `${done.stdout ?? ''}${done.stderr ?? ''}`.trim()
  if (done.status === 1 && BANNED_ROW.test(report)) {
    say(report)
    say('한국어 문서에 금지어가 있어 커밋하지 않았다. 권장 표현으로 고쳐 다시 스테이징한 뒤 커밋한다.')
    say('--no-verify 로 넘기지 않는다. 고유명사라 그대로 써야 하면 .claude/korean-check-allow.txt 에 적는다.')
    return 1
  }
  if (done.status === 0) {
    if (report) say(`${report}\n위 경고는 커밋을 막지 않는다. 문맥을 보고 고칠지 판단한다.`)
    return 0
  }
  say('orch 커밋 검사: 한국어 검사기가 돌지 못해 점검을 건너뛴다')
  const detail = report || done.error?.message || ''
  if (detail) say(detail)
  return 0
}

function originalHooksDir() {
  const scoped = spawnSync('git', ['config', '--show-scope', '--type=path', '--get-all', 'core.hooksPath'], { encoding: 'utf8' })
  let value = ''
  if (scoped.status === 0) {
    for (const row of scoped.stdout.split('\n')) {
      const tab = row.indexOf('\t')
      if (tab > 0 && ['system', 'global', 'local'].includes(row.slice(0, tab))) value = row.slice(tab + 1)
    }
  }
  if (value) return resolve(process.cwd(), value)
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return common ? join(common, 'hooks') : null
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function forward() {
  const dir = originalHooksDir()
  if (!dir) return 0
  let real
  try {
    real = realpathSync(dir)
  } catch {
    return 0
  }
  if (real === HOOKS) return 0
  const hook = join(dir, NAME)
  if (!isExecutableFile(hook)) return 0
  const env = { ...process.env, ORCH_GITHOOK: MARK }
  let done = spawnSync(hook, ARGS, { stdio: 'inherit', env })
  if (done.error?.code === 'ENOEXEC') done = spawnSync('/bin/sh', [hook, ...ARGS], { stdio: 'inherit', env })
  if (done.error) {
    say(`orch 커밋 검사: 원래 훅을 실행하지 못했다: ${hook}: ${done.error.message}`)
    return 1
  }
  if (done.signal) return 128 + (osConstants.signals[done.signal] ?? 0)
  return done.status ?? 1
}

process.exitCode = process.env.ORCH_GITHOOK === MARK ? 0 : (NAME === 'pre-commit' ? koreanCheck() : 0) || forward()
