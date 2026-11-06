#!/usr/bin/env node
// PR 을 만든 직후 기준 브랜치와 충돌하는지 확인한다.
//
// 충돌은 PR 을 만든 순간에 이미 정해지지만, 확인하지 않으면 리뷰나 머지 단계에서야 드러난다.
// GitHub 는 생성 직후 mergeable 을 UNKNOWN 으로 두고 뒤에서 계산하므로, 값이 정해질 때까지 다시 묻는다.
//
// 사용법 (cwd: 대상 저장소 안):
//   node "$SKILL_DIR/scripts/pr_mergeable.ts" <PR번호> [--tries <n>] [--interval <초>]
//
//   --tries     UNKNOWN 일 때 다시 묻는 횟수. 기본 10
//   --interval  다시 묻기 전 기다리는 초. 기본 3
//
// 출력: `mergeable=<값> mergeStateStatus=<값>` 한 줄
//
// 종료 코드:
//   0  충돌 없음 (MERGEABLE). 보호 규칙의 BLOCKED 는 충돌이 아니라 0 이다
//   1  충돌 (mergeable CONFLICTING 또는 mergeStateStatus DIRTY)
//   2  조회 실패, 횟수를 다 써도 UNKNOWN, 또는 사용법 오류

import { spawnSync } from 'node:child_process'
import { isMain, write } from './io.ts'

const JQ = '"mergeable=\\(.mergeable) mergeStateStatus=\\(.mergeStateStatus)"'

function sleep(seconds: number): void {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

export function main(argv: string[]): number {
  let pr = ''
  let tries = '10'
  let interval = '3'
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i]
    if (arg === '--tries') {
      tries = argv[i + 1] ?? ''
      i += 2
    } else if (arg === '--interval') {
      interval = argv[i + 1] ?? ''
      i += 2
    } else if (arg.startsWith('-')) {
      write(2, `pr_mergeable: 다루지 않는 옵션이다: ${arg}\n`)
      return 2
    } else {
      pr = arg
      i += 1
    }
  }
  if (!pr) {
    write(2, 'pr_mergeable: PR 번호가 필요하다\n')
    return 2
  }
  if (!/^\d+$/.test(tries) || !/^(\d+\.?\d*|\.\d+)$/.test(interval)) {
    write(2, 'pr_mergeable: --tries 는 정수, --interval 은 초 단위 숫자여야 한다\n')
    return 2
  }

  for (let attempt = 1; ; attempt++) {
    const view = spawnSync('gh', ['pr', 'view', pr, '--json', 'mergeable,mergeStateStatus', '--jq', JQ], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
    if (view.status !== 0) {
      write(2, 'pr_mergeable: gh pr view 가 실패했다\n')
      return 2
    }
    const line = view.stdout.replace(/\n+$/, '')
    if (line.includes('mergeable=CONFLICTING') || line.includes('mergeStateStatus=DIRTY')) {
      write(1, `${line}\n`)
      write(2, 'pr_mergeable: 기준 브랜치와 충돌한다. 기준 브랜치를 병합해 풀고 일반 push 로 올린다\n')
      return 1
    }
    if (line.includes('mergeable=MERGEABLE')) {
      write(1, `${line}\n`)
      return 0
    }
    if (attempt >= Number(tries)) {
      write(1, `${line}\n`)
      write(2, `pr_mergeable: ${tries} 번 물어도 값이 정해지지 않았다\n`)
      return 2
    }
    sleep(Number(interval))
  }
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
