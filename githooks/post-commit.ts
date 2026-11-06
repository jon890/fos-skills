// 공용 스킬을 고쳐 커밋하면, 사본을 두고 쓰는 저장소에 반영이 필요함을 알린다. 진입은 같은 이름의 확장자 없는 파일이다.
//
// 왜 필요한가 (실측):
//   같은 스킬을 이 저장소와 팀 저장소에 나눠 두고 각각 커밋한 적이 있다.
//   어느 쪽이 최신인지 알 방법이 없어 낡은 판이 조용히 남았다.
//
// 알리기만 하고 고치지 않는다. 다른 저장소의 작업 트리를 말없이 건드리면
// 그쪽이 dirty 하거나 다른 브랜치일 때 사고가 난다.
//
// 커밋한 체크아웃의 scripts/export-to-team.ts 를 쓴다. 없으면 조용히 지나간다(이 영역을 옮기기 전 브랜치 포함).
// 공용 스킬 목록은 그 파일의 글에서 읽는다(sharedLists). 그 파일을 import 하지 않아 낡거나 깨져도 훅이 죽지 않는다.
// 팀 저장소 위치는 TEAM_SKILLS_DIR 로 바꾼다 (export-to-team.ts 가 읽는다).
//
// 종료 코드: 늘 0. git 은 post-commit 의 종료 코드를 보지 않는다
// 설치: node scripts/install-hooks.ts

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isFile } from '../scripts/skill_paths.ts'
import { pySplitLines } from '../modules/kit/py.ts'
import { sharedLists } from '../scripts/export-lists.ts'

const SYNC_NAME = 'scripts/export-to-team.ts'
const DRIFT = /^ {2}(다름|없음|남음) /

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 이번 커밋이 건드린 최상위 이름. 두 원본 루트(skills/, export-only-skills/) 아래는 스킬 이름이다
function touchedNames(): Set<string> {
  const done = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { encoding: 'utf8' })
  const names = new Set<string>()
  if (done.status !== 0) return names
  for (const path of pySplitLines(done.stdout)) {
    const parts = path.split('/')
    names.add(parts[0] === 'skills' || parts[0] === 'export-only-skills' ? (parts[1] ?? '') : parts[0])
  }
  return names
}

export function main(): number {
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim() ?? ''
  const sync = join(root, SYNC_NAME)
  // 내보내기 도구가 없으면 조용히 지나간다
  if (!root || !isFile(sync)) return 0
  const changed = touchedNames()
  if (changed.size === 0) return 0
  const shared = sharedLists(readFileSync(sync, 'utf8'))?.skills ?? []
  const touched = shared.filter((name) => changed.has(name))
  if (touched.length === 0) return 0

  // 같으면 조용히 지나간다. 커밋마다 알림이 뜨면 읽지 않게 된다.
  // 방금 만든 커밋을 원본으로 비교한다. 작업 트리를 보면 커밋하지 않은 변경 때문에 어긋났다고 알린다.
  const done = spawnSync(process.execPath, [sync, '--source-ref', 'HEAD'], { encoding: 'utf8' })
  if (done.status === 0) return 0
  const out = pySplitLines((done.stdout ?? '') + (done.stderr ?? ''))

  // 어긋남이 많으면 이번 커밋의 것이 가려진다. 이번에 건드린 스킬의 파일만 자세히 내고 나머지는 개수만 낸다.
  // 어긋남 줄의 형식은 「  다름|없음|남음   <경로>」 이고, 경로에 /<스킬>/ 이 들어 있으면 그 스킬의 것이다.
  const mineRe = new RegExp(`^ {2}(다름|없음|남음) +[^ ]*/(${touched.map(escapeRegExp).join('|')})/`)
  const mine = out.filter((line) => mineRe.test(line))
  const others = out.filter((line) => DRIFT.test(line) && !mineRe.test(line)).length

  const lines = ['']
  if (mine.length > 0) {
    lines.push('── 이번 커밋이 건드린 공용 스킬이 팀 저장소와 어긋난다.')
    lines.push(...out.filter((line) => line.startsWith('원본:')))
    lines.push(...mine)
    lines.push(`반영: ${SYNC_NAME} --source-ref HEAD --apply`)
  } else {
    lines.push('── 이번 커밋이 건드린 공용 스킬은 팀 저장소와 같다.')
  }
  if (others > 0) lines.push(`다른 스킬의 어긋난 파일 ${others}개 (이번 커밋과 무관). 전체는 ${SYNC_NAME} 로 본다.`)
  lines.push('──')
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}
