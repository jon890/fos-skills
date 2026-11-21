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
//        - 그 밖(2, 신호, 실행 실패, 발견 줄 없는 1)은 검사기가 돌지 못한 것이다. 검사기 사본이 없거나 node 가 MIN_NODE 보다 낮은 것도 같다.
//          이때 .md 를 스테이징한 커밋이면 원인과 끄는 방법을 stderr 에 내고 1 로 거절한다. 검사 없이 한국어 문서가 커밋되지 않게 한다.
//          스테이징한 .md 가 없으면 한 줄로 알리고 이어 간다. 스테이징한 파일을 읽지 못해도 거절한다.
//          node 는 잡지 않은 예외에도 1 을 내므로 「금지어가 있다」 와 「돌지 못했다」 는 종료 코드가 아니라 발견 줄로 구분한다.
//        - 머지, 리베이스, cherry-pick, revert 가 진행 중이면 검사하지 않는다. 그때 스테이징된 줄은 다른 브랜치에서 온 것이다.
//        - 자식 환경에서 KOREAN_STYLE_RULES, KOREAN_CHECK_ALLOW 는 지운다. 사본의 규칙과 저장소의 예외 파일을 읽게 한다.
//     2. 훅 이름이 pre-commit 이나 commit-msg 면 비공개 낱말 검사를 한다. 옆의 private-words.ts 사본을 부른다(인자 pre-commit, 또는 commit-msg 와 메시지 파일).
//        검사의 뜻과 출력은 scripts/lib/private-words.ts 머리 주석이 소유한다. 한국어 검사에서 거절했으면 부르지 않는다.
//        - 목록(~/.config/orch/private-words.txt, ORCH_PRIVATE_WORDS 가 있으면 그 경로)에 낱말이 없으면 부르지 않는다. 목록을 쓰지 않는 사용자의 커밋에 node 를 더 띄우지 않는다.
//        - 종료 코드 0 은 이어 가고, 1 이고 거절 첫 줄(`orch 커밋 검사: 비공개 낱말 목록(`)이 있으면 출력을 그대로 둔 채 1 로 거절한다.
//        - 그 밖(2, 신호, 실행 실패, 거절 줄 없는 1, 사본 없음, 낮은 node)은 검사하지 못한 것이다. 목록이 있으므로 원인과 함께 1 로 거절한다.
//          공개 저장소에 값이 새는 비용이 커밋을 다시 하는 비용보다 크다(스펙 DECISION5 와 같은 판단).
//        - pre-commit 은 머지가 진행 중(MERGE_HEAD)일 때만 보지 않는다. 그때 스테이징된 줄은 다른 브랜치에서 온 것이다.
//          리베이스, cherry-pick, revert 중에는 본다. 충돌을 풀며 새로 쓴 줄과 edit 단계의 amend 도 검사받게 하려는 것이다.
//     3. 모든 훅 이름에서 저장소가 원래 쓰던 훅을 같은 인자와 표준 입출력으로 부르고 그 종료 코드로 끝난다.
//        git 은 core.hooksPath 가 있으면 원래 폴더를 보지 않으므로 여기서 이어 부른다.
//        - 원래 훅 폴더: `git config --show-scope --get-all core.hooksPath` 에서 범위가 system, global, local 인 마지막 값이다.
//          워크트리 범위(이 훅 폴더를 가리킨다)와 명령줄 범위는 뺀다. 상대 경로는 작업 디렉터리(워크트리 최상위) 기준이다.
//          그런 값이 없으면 <공통 git 폴더>/hooks 다. 실행할 때마다 다시 읽으므로 워크트리를 만든 뒤 설치된 훅도 불린다.
//        - 그 폴더가 이 훅 폴더 자신이거나, 훅 파일이 없거나 실행 권한이 없으면 부르지 않는다. git 도 실행 권한 없는 훅은 무시한다.
//        - shebang 없는 훅(ENOEXEC)은 git 처럼 /bin/sh 로 한 번 더 부른다.
//        - 원래 훅에는 환경 변수 ORCH_GITHOOK 에 「훅 폴더:훅 이름」 을 넣어 넘긴다. 같은 값을 받은 채 불리면 원래 훅이
//          이 훅을 다시 부른 것이라 아무것도 하지 않고 0 으로 끝난다(`git rev-parse --git-path hooks` 로 다음 훅을 찾는 훅).
//          표시는 원래 훅의 자식 프로세스에도 전달된다. 원래 pre-commit 이 같은 워크트리에서 git commit 을 다시 하면 그 안쪽 커밋은 검사하지 않는다.
//
// 종료 코드: 0 이어 간다, 1 금지어나 비공개 낱말이 있거나 검사기가 돌지 못해 커밋을 거절했거나 원래 훅을 실행하지 못했다, 그 밖은 원래 훅의 종료 코드(신호면 128 + 신호 번호)

import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, constants as osConstants } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const MIN_NODE = [24, 0]
const HOOKS = dirname(realpathSync(process.argv[1]))
const NAME = basename(process.argv[1])
const ARGS = process.argv.slice(2)
const BANNED_ROW = /: 금지어 "/
const PRIVATE_REFUSED = 'orch 커밋 검사: 비공개 낱말 목록('
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

// 스테이징한 .md 가 있는가. 읽지 못하면 null 이다
function stagedMarkdown() {
  const done = spawnSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=AMRT', '--', '*.md'], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  return done.status === 0 ? done.stdout.split('\0').some(Boolean) : null
}

// 검사기가 돌지 못했다. .md 를 스테이징한 커밋이면 거절(1)하고, 없으면 알리기만 한다(0)
function broken(reason, detail = '') {
  const staged = stagedMarkdown()
  if (staged === false) {
    say(`orch 커밋 검사: ${reason}. 스테이징한 .md 가 없어 그대로 커밋한다`)
    return 0
  }
  say(`orch 커밋 검사: ${reason}`)
  if (detail) say(detail)
  say(staged === null ? '스테이징한 파일을 읽지 못해 커밋하지 않았다.' : '한국어 검사 없이 .md 를 커밋할 수 없어 커밋하지 않았다.')
  say('--no-verify 로 넘기지 않고 코디네이터에게 위 원인을 알린다.')
  say('이 저장소에서 검사를 끄려면 코디네이터가 `orch config set worker.commit_check false --json` 을 한 뒤 worker 를 다시 띄운다.')
  return 1
}

function inProgress() {
  const gitDir = git(['rev-parse', '--absolute-git-dir'])
  return Boolean(gitDir && IN_PROGRESS.some((name) => existsSync(join(gitDir, name))))
}

// 0 이어 간다, 1 금지어가 있거나 검사기가 돌지 못해 거절한다
function koreanCheck() {
  if (inProgress()) return 0
  const checker = join(HOOKS, 'korean-check', 'scripts', 'check.ts')
  if (!existsSync(checker)) return broken('한국어 검사기 사본이 없다')
  if (nodeTooOld()) return broken(`Node ${process.versions.node} 은 한국어 검사기를 돌리지 못한다`)
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
  return broken('한국어 검사기가 돌지 못했다', report || done.error?.message || '')
}

// 목록에 낱말이 한 줄이라도 있는가. 읽는 규칙은 private-words.ts 의 readPrivateWords 와 같다
function hasPrivateWords() {
  try {
    return readFileSync(process.env.ORCH_PRIVATE_WORDS || join(homedir(), '.config', 'orch', 'private-words.txt'), 'utf8').split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith('#'))
  } catch {
    return false
  }
}

function privateBroken(reason, detail = '') {
  say(`orch 커밋 검사: ${reason}`)
  if (detail) say(detail)
  say('비공개 낱말 목록이 있는데 검사하지 못해 커밋하지 않았다. --no-verify 로 넘기지 않고 코디네이터에게 위 원인을 알린다.')
  return 1
}

// 0 이어 간다, 1 비공개 낱말이 있거나 검사하지 못해 거절한다
function privateCheck() {
  if (!hasPrivateWords()) return 0
  const gitDir = git(['rev-parse', '--absolute-git-dir'])
  if (NAME === 'pre-commit' && gitDir && existsSync(join(gitDir, 'MERGE_HEAD'))) return 0
  const checker = join(HOOKS, 'private-words.ts')
  if (!existsSync(checker)) return privateBroken('비공개 낱말 검사기 사본이 없다')
  if (nodeTooOld()) return privateBroken(`Node ${process.versions.node} 은 비공개 낱말 검사기를 돌리지 못한다`)
  const done = spawnSync(process.execPath, [checker, NAME, ...ARGS.slice(0, 1)], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  const report = `${done.stdout ?? ''}${done.stderr ?? ''}`.trim()
  if (done.status === 0) return 0
  if (done.status === 1 && report.includes(PRIVATE_REFUSED)) {
    say(report)
    return 1
  }
  return privateBroken('비공개 낱말 검사기가 돌지 못했다', report || done.error?.message || '')
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

function ownChecks() {
  if (NAME === 'pre-commit') return koreanCheck() || privateCheck()
  if (NAME === 'commit-msg') return privateCheck()
  return 0
}

process.exitCode = process.env.ORCH_GITHOOK === MARK ? 0 : ownChecks() || forward()
