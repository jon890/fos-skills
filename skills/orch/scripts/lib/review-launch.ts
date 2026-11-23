import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { apiTarget, ghJson } from './gh.ts'
import { git } from './git.ts'
import { launchHistory } from './launch-history.ts'
import { implementerOf } from './review-spec.ts'

export function writeReviewLaunch(worktree: string, repo: string, pr: number, replacementAgent: string | null): void {
  const ref = git(worktree, ['rev-parse', '--git-path', 'orch-review-launch.json'])
  if (ref.code !== 0 || !ref.stdout.trim()) throw new Error('리뷰 워크트리의 Git 경로를 읽지 못했다')
  const file = resolve(worktree, ref.stdout.trim())
  const remote = git(repo, ['remote', 'get-url', 'origin'])
  let slug = /[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote.stdout.trim())?.[1] ?? ''
  let sameProviderDueToLimit = false
  if (replacementAgent) {
    const prInfo = ghJson<{ headRefName: string; url: string }>(['pr', 'view', String(pr), '--json', 'headRefName,url'], { cwd: repo, repoFromCwd: true, timeoutMs: 10_000 })
    if (!prInfo.ok || typeof prInfo.data?.headRefName !== 'string') throw new Error('리뷰 PR 의 구현 브랜치를 읽지 못했다')
    const target = apiTarget(prInfo.data.url)
    if (target) slug = target.slug
    const { found } = implementerOf(launchHistory(repo), prInfo.data.headRefName)
    sameProviderDueToLimit = found?.agent === replacementAgent
  }
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ repo: slug, pr, sameProviderDueToLimit }) + '\n')
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}
