// 리뷰 worker 지시서를 PR 번호로 만든다. templates/spec-review.md 를 PR 메타데이터로 채워 지시서 폴더에 쓴다.
// 사용법: orch spec review <PR> [--repo DIR] [--specs-dir DIR] [--out FILE] [--impl-agent claude|codex] [--force]
//
//     <PR>           리뷰할 PR 번호(`#12` 도 받는다)
//     --specs-dir    지시서 폴더. 주지 않으면 진입점이 설정(finish.specs_dir)이나 기본 폴더로 채운다
//     --out          만들 파일. 기본은 <지시서 폴더>/spec-review-pr-<N>.md. 같은 PR 을 다시 리뷰하면 `-<꼬리>` 를 붙인다(lib/review.ts 의 이름 규칙).
//                    파일 이름이 spec-review-pr-<N>-<꼬리>.md 꼴이면 `브랜치:` 줄이 review/pr-<N>-<꼬리> 가 된다. 아니면 review/pr-<N> 이다
//     --impl-agent   구현 worker 의 제공자. 영구 이력에서 구현 worker 를 못 찾을 때(직접 띄운 PR, 이력 도입 전)만 준다
//     --force        있는 파일을 덮어쓴다. 코디네이터가 채운 「배경」 을 잃으므로 기본은 거부한다. 같은 리뷰 브랜치를 다시 쓰는 용도라 브랜치 중복도 보지 않는다
//
// 채우는 것(lib/review-spec.ts 가 소유): PR 번호, 제목, `리뷰 PR:`·`브랜치: review/pr-<N>[-<꼬리>]` 줄, 공통 지시서 경로,
//     구현 worker 의 제공자와 다른 제공자의 `worker 선택:` 줄. 구현 worker 는 영구 이력에서 브랜치가 PR head 인 가장 늦은 행이다.
// 남기는 것: 「배경」 의 첫 줄과 「특히 볼 것」 절의 `{{채울 것: …}}` 자리표시 둘. 코디네이터가 채운다. 남아 있으면 spec-lint 가 `채움` 경고를 낸다.
// 만든 지시서는 `orch spec lint` 가 막지 않는다(리뷰 지시서라 루프 검사를 하지 않고, review 행은 후보 검사를 하지 않는다).
//
// 출력 줄:
//     REVIEW-SPEC <파일>                              만들었다. 종료 코드 0
//     REVIEW-SPEC-WORKER impl=<구현> review=<리뷰>    고른 제공자와 모델
//     REVIEW-SPEC-FILL <설명>; <설명>                  코디네이터가 채울 자리표시(만든 파일에 남아 있다)
//     REVIEW-SPEC-WARN <이유>                         만들었지만 알릴 것(PR 이 열려 있지 않다, 구현 이력의 제공자가 둘 이상이다)
//     REVIEW-SPEC-EXISTS <파일>                       이미 있어 만들지 않았다. 종료 코드 1
//     REVIEW-SPEC-FAIL <이유>                         PR 을 읽지 못했거나 구현 worker 를 모르거나 틀이 맞지 않거나 같은 이름의 리뷰 브랜치가 이미 있다. 종료 코드 1
// 사용법 오류는 2 다.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { bundleRoot } from '../lib/bundle.ts'
import { ghJson } from '../lib/gh.ts'
import { git, mainCheckout } from '../lib/git.ts'
import { launchHistory } from '../lib/launch-history.ts'
import { oneLine } from '../lib/output.ts'
import { pathOf } from '../lib/paths.ts'
import { fillReviewSpec, implementerOf, reviewBranchFor, reviewerFor, unfilled } from '../lib/review-spec.ts'

const USAGE = '사용법: orch spec review <PR> [--repo DIR] [--specs-dir DIR] [--out FILE] [--impl-agent claude|codex] [--force]'

// 같은 이름의 브랜치가 이미 있는 곳. 로컬 브랜치(워크트리에 체크아웃된 것 포함)와 원격 추적 브랜치(마지막 fetch 기준, 네트워크는 부르지 않는다)를 본다. 없으면 null 이다
function branchTaken(repo: string, branch: string): string | null {
  if (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0) return '로컬 브랜치'
  const remotes = git(repo, ['remote'])
  if (remotes.code !== 0) return null
  for (const remote of remotes.stdout.split('\n').filter((line) => line)) {
    if (git(repo, ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]).code === 0) return `원격 추적 브랜치 ${remote}/${branch}`
  }
  return null
}

type View = { number: number; title: string; url: string; headRefName: string; state: string }

export function main(argv: string[]): number {
  const options = {
    pr: { type: 'string' }, repo: { type: 'string' }, 'specs-dir': { type: 'string' }, out: { type: 'string' },
    'impl-agent': { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } as const
  let values
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: expandArgs(argv, options), options, allowPositionals: true })
    values = parsed.values
    positionals = parsed.positionals
  } catch (e) {
    process.stderr.write(`${USAGE}\nreview-spec: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const given = values.pr ?? positionals[0]
  const number = /^#?([1-9]\d*)$/.exec(given ?? '')?.[1]
  if (!number || positionals.length > (values.pr ? 0 : 1)) {
    process.stderr.write(`${USAGE}\nreview-spec: PR 번호 하나를 준다\n`)
    return 2
  }
  if (values['impl-agent'] && !['claude', 'codex'].includes(values['impl-agent'])) {
    process.stderr.write(`${USAGE}\nreview-spec: --impl-agent 는 claude 나 codex 다\n`)
    return 2
  }
  const fail = (reason: string): number => {
    process.stdout.write(`REVIEW-SPEC-FAIL ${oneLine(reason)}\n`)
    return 1
  }
  const repo = mainCheckout(resolve(values.repo ?? process.cwd()))
  const viewed = ghJson<View>(['pr', 'view', number, '--json', 'number,title,url,headRefName,state'], { cwd: repo })
  if (!viewed.ok) return fail(`PR #${number} 를 읽지 못했다: ${viewed.error}`)
  const pr = viewed.data
  if (typeof pr?.number !== 'number' || !pr.headRefName) return fail(`PR #${number} 의 응답에 번호나 브랜치가 없다`)

  const history = implementerOf(launchHistory(repo), pr.headRefName)
  const agent = values['impl-agent'] ?? history.found?.agent
  if (!agent) return fail(`구현 worker 를 이력에서 찾지 못했다(브랜치 ${pr.headRefName}). --impl-agent claude|codex 로 구현한 제공자를 알려 준다`)
  const reviewer = reviewerFor(agent)
  if (!reviewer) return fail(`구현 worker 의 제공자 ${agent} 는 다른 제공자를 정할 수 없다. 지시서를 직접 쓴다`)
  const implementer = values['impl-agent'] && values['impl-agent'] !== history.found?.agent
    ? { agent: values['impl-agent'], model: null, effort: null, dispatch: '-' }
    : history.found!

  const specsDir = resolve(values['specs-dir'] ?? pathOf('specs', repo))
  const file = resolve(values.out ?? join(specsDir, `spec-review-pr-${pr.number}.md`))
  if (existsSync(file) && !values.force) {
    process.stdout.write(`REVIEW-SPEC-EXISTS ${file}\n`)
    return 1
  }
  const branch = reviewBranchFor(pr.number, file)
  const taken = values.force ? null : branchTaken(repo, branch)
  if (taken) return fail(`리뷰 브랜치 ${branch} 가 이미 있다(${taken}). 같은 이름이면 launch 가 띄우지 못한다. --out 파일 이름에 다른 꼬리를 줘서(spec-review-pr-${pr.number}-<꼬리>.md) 다시 만든다`)
  let text: string
  try {
    const template = readFileSync(process.env.SPEC_REVIEW_TEMPLATE || join(bundleRoot(), 'templates', 'spec-review.md'), 'utf8')
    text = fillReviewSpec(template, { number: pr.number, title: pr.title, url: pr.url, specsDir, branch, implementer, reviewer })
  } catch (e) {
    return fail((e as Error).message)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  process.stdout.write(`REVIEW-SPEC ${file}\n`)
  process.stdout.write(`REVIEW-SPEC-WORKER impl=${implementer.agent}${implementer.model ? `/${implementer.model}` : ''} review=${reviewer.agent}/${reviewer.model}/${reviewer.effort}\n`)
  process.stdout.write(`REVIEW-SPEC-FILL ${unfilled(text).join('; ')}\n`)
  if (pr.state !== 'OPEN') process.stdout.write(`REVIEW-SPEC-WARN PR #${pr.number} 의 상태가 ${pr.state} 다\n`)
  if (!values['impl-agent'] && history.agents.length > 1) process.stdout.write(`REVIEW-SPEC-WARN 구현 이력의 제공자가 둘 이상이다(${history.agents.join(', ')}). 가장 늦은 ${agent} 의 반대로 골랐다\n`)
  return 0
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
