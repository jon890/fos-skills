#!/usr/bin/env node
// gh 가 봐야 할 호스트 이름을 낸다.
//
// 사용법:
//   node gh_host.ts <owner> <repo>                                 그 저장소의 호스트
//   node gh_host.ts                                                현재 디렉터리의 origin 으로 정한다
//   gh api --hostname "$(node gh_host.ts <owner> <repo>)" <경로>   한 번만 쓸 때
//
// `gh api` 는 `--repo` 를 받지 않아 기본 호스트를 본다.
// GitHub Enterprise 저장소에서 호스트를 넘기지 않으면 `Not Found` 가 난다.
// 결과가 `github.com` 이어도 그대로 넘긴다. 넘겨도 동작이 달라지지 않는다 (실측).
//
// 환경 변수는 호출 사이에 남지 않는다 (실측). 에이전트 하네스는 명령마다 새 셸을 띄운다.
// 그래서 이 값은 쓰는 쪽과 같은 호출 안에서 구한다.
//
// ## 저장소 이름으로 정한다
//
// PR URL 등으로 호스트를 명시하면 그 호스트만 쓴다.
// 그 값이 없으면 `GH_HOST` 를 우선한다.
//
// `<owner> <repo>` 를 주면 origin 의 저장소 이름과 먼저 대조한다.
// 같은 저장소면 origin 의 호스트를 쓰므로 다른 로그인 호스트를 조회하지 않는다.
// 다른 저장소에서 실행했으면 origin 의 호스트를 쓰지 않는다.
// 로그인된 호스트가 하나면 그 호스트를 쓰고, 여럿이면 저장소가 있는 호스트를 찾는다.
//
// 로그인된 호스트 어디에도 그 저장소가 없거나 로그인 정보가 없으면
// 경고를 내고 현재 디렉터리의 origin 에서 호스트를 읽는다.
//
// `<owner> <repo>` 없이 부르면 처음부터 현재 디렉터리의 origin 을 본다.
// 그 저장소 안에서 돌리는 것이 확실할 때만 이 형태를 쓴다.
//
// origin 이 SSH config 별칭이면 별칭이 그대로 나오므로 `ssh -G` 로 실제 호스트를 되찾는다.
// `git@github-personal:...` 은 `github-personal` 로 나오고, 그대로 쓰면
// `error connecting to github-personal` 로 실패한다. `ssh -G` 가 `github.com` 으로 되돌린다.
//
// 종료 코드: 0 호스트를 냈다, 1 origin 주소에서 호스트를 읽지 못했다, 2 사용법 오류

import { capture, isMain, write } from './io.ts'
import { pySplitLines, pyStrip } from './kit/py.ts'

const SCP_LIKE = /^[^@/]*@([^:/]+)[:/]/
const URL_LIKE = /^[a-z]+:\/\/([^/]+)\//
const HOSTNAME_LINE = /^([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/

export class HostError extends Error {}

// stdout 을 낸다. anyExit 이면 종료 코드가 0 이 아니어도 stdout 과 stderr 를 이어 낸다. 실행하지 못하면 null
function run(argv: string[], anyExit = false): string | null {
  let done
  try {
    done = capture(argv)
  } catch {
    return null
  }
  if (done.code === 0) return done.stdout
  // 실패한 `gh auth status` 는 호스트별 상태를 stderr 로 낸다 (실측)
  return anyExit ? done.stdout + done.stderr : null
}

function fromUrl(url: string): string {
  for (const pattern of [SCP_LIKE, URL_LIKE]) {
    const m = pattern.exec(url)
    if (m) return m[1]
  }
  return ''
}

// SSH config 별칭이면 실제 호스트로 되돌린다. 못 찾으면 그대로 둔다
function viaSshConfig(host: string): string {
  const out = run(['ssh', '-G', host])
  if (!out) return host
  for (const line of pySplitLines(out)) {
    if (line.startsWith('hostname ')) return pyStrip(line.slice('hostname '.length)) || host
  }
  return host
}

// `gh` 에 로그인된 호스트. 출력 순서를 그대로 쓴다.
// `gh auth status` 는 호스트 하나라도 토큰 확인에 실패하면 종료 코드 1 이다.
// github.com 은 로그인돼 있어도 다른 호스트의 timeout 때문에 1 이 나오므로
// 종료 코드를 보지 않고 stdout 과 stderr 를 읽는다 (실측).
export function loggedInHosts(): string[] {
  const out = run(['gh', 'auth', 'status'], true) ?? ''
  const hosts: string[] = []
  for (const line of pySplitLines(out)) {
    const m = HOSTNAME_LINE.exec(pyStrip(line))
    if (m && !hosts.includes(m[1])) hosts.push(m[1])
  }
  return hosts
}

function hasRepo(host: string, owner: string, repo: string): boolean {
  return run(['gh', 'api', '--hostname', host, `repos/${owner}/${repo}`, '--jq', '.id']) !== null
}

function fromOrigin(): string {
  const url = pyStrip(run(['git', 'remote', 'get-url', 'origin']) ?? '')
  const host = fromUrl(url)
  if (!host) throw new HostError(`origin 리모트에서 호스트를 읽지 못했다: ${url}`)
  return viaSshConfig(host)
}

// gh 에 넘길 호스트 이름. 구하지 못하면 HostError 를 던진다.
// host 가 있으면 탐색하지 않는다. 없으면 대상과 같은 origin 을 먼저 본다
export function resolveHost(owner?: string, repo?: string, host?: string): string {
  if (host) return host

  // 호출자가 지정했으면 그것을 존중한다. 오버레이가 호스트를 고정하는 경우가 있다
  const given = process.env.GH_HOST
  if (given) return given

  if (owner && repo) {
    // 같은 저장소의 origin 이면 이미 호스트가 정해져 있다. 다른 저장소에서
    // 실행한 경우에는 origin 호스트를 쓰지 않고 기존 탐색을 이어 간다
    const origin = pyStrip(run(['git', 'remote', 'get-url', 'origin']) ?? '')
    const originRepo = origin.replace(/\/+$/, '').split(/[:/]/).slice(-2)
    if (originRepo.length === 2) {
      originRepo[1] = originRepo[1].replace(/\.git$/, '')
      if (originRepo.map((part) => part.toLowerCase()).join('/') === `${owner.toLowerCase()}/${repo.toLowerCase()}`) {
        const originHost = fromUrl(origin)
        if (originHost) return viaSshConfig(originHost)
      }
    }
    const hosts = loggedInHosts()
    if (hosts.length === 1) return hosts[0]
    for (const candidate of hosts) if (hasRepo(candidate, owner, repo)) return candidate
    // 로그인 정보로 어느 호스트인지 가려내지 못하면 현재 디렉터리로 되돌아간다.
    // 맞을 수도 있고 아닐 수도 있으나, 여기서 멈추면 쓸 수 있는 값이 없다.
    //
    // **되돌아간 것을 알린다.** 이 스크립트가 없애려는 것이 바로 이 동작이라,
    // 조용히 넘어가면 호출자는 저장소 이름으로 정해진 줄 안다.
    // `gh auth status` 가 0 이 아닌 코드로 끝나면 로그인된 호스트가 빈 목록이 되어
    // 저장소 이름을 넘겨도 이 경로로 온다 (실측)
    const reason = hosts.length === 0 ? '로그인된 호스트가 없다' : '로그인된 호스트에 그 저장소가 없다'
    write(2, `gh_host: ${reason}. ${owner}/${repo} 대신 현재 디렉터리의 origin 으로 정한다.\n`)
  }

  return fromOrigin()
}

const USAGE = `사용법:
    gh_host.ts <owner> <repo>   그 저장소의 호스트
    gh_host.ts                  현재 디렉터리의 origin 으로 정한다
`

export function main(args: string[]): number {
  if (args.length !== 0 && args.length !== 2) {
    // 머리말 전체를 내면 40줄이 오류 출력으로 나와 정작 사용법이 묻힌다
    write(2, USAGE)
    return 2
  }
  try {
    write(1, `${resolveHost(args[0], args[1])}\n`)
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    write(2, `${error.message}\n`)
    return 1
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
