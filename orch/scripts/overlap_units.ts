// PR 을 머지하기 전에 base 최신화가 필요한지 「단위」 겹침으로 판정한다.
//
// 머지 큐(`merge_queue.py --up-to-date-when overlap`)가 PR 차례마다 부른다. 판정은 큐를 걸 때가 아니라
// 그 PR 차례에 한다. 앞 PR 이 머지되면 base 가 바뀌기 때문이다. 판정 함수는 lib/overlap.ts 에 있다.
//
// 사용법:
//     overlap_units.ts --base REF --head REF [--shared-paths 정규식] [--unit-prefix 접두] [--unit-group a,b ...]
//                      [--docs-glob G1,G2] [--repo DIR]
//
//     PR 이 바꾼 파일(merge-base..HEAD)과 PR 이 갈라진 뒤 base 에서 바뀐 파일(merge-base..BASE)을 단위로 바꿔 비교한다.
//     - 단위: 접두(기본 `modules/`) 아래의 첫 폴더 하나(`modules/api/x.py` 는 `api`). 그 밖의 파일은 경로 자체가 단위다
//     - 단위 묶음: `--unit-group a,b`(여러 번)로 준 단위들은 한 단위로 센다. 계약 파일 없이 서로의 응답 모양에 기대는
//       모듈 쌍(화면 모듈과 그 BFF)은 폴더가 달라도 묶음 안 어느 쪽이 바뀌든 같은 단위가 바뀐 것이다
//     - 공용 경로: 정규식에 맞는 파일은 어느 쪽에 있든 겹친 것으로 본다(모든 모듈에 영향을 주는 경로).
//       정규식은 Python re 의 글자로 받는다(lib/py.ts 의 pyRegExp). `(?P<이름>...)`, `\A`, `\Z` 를 그대로 쓸 수 있다
//     - 문서 파일: --docs-glob 에 맞는 파일은 세지 않는다. glob 은 merge_queue.py 와 같이 `*` 가 `/` 도 넘는다
//     - 이름을 바꾼 파일은 옛 경로와 새 경로를 모두 센다
//     다음은 겹침을 따지지 않고 바로 머지로 본다: base 가 갈라진 뒤 문서 밖 변경이 없다(이미 최신이거나 문서만 들어왔다),
//     PR 이 문서만 바꿨다.
//
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts). `-` 로 시작하는 정규식은 `--shared-paths=-lock$` 처럼 `=` 로 붙여 준다.
//     띄워 넘기면 옛 명령과 같이 사용법 오류다.
//
// 출력(표준 출력 한 줄): `바로 머지` 또는 `갱신 필요(이유)`. 오류는 표준 오류에 `오류: ...` 를 쓴다.
// 종료 코드: 0 바로 머지, 1 갱신 필요, 2 판정하지 못함(사용법 오류, git 실패, 잘못된 정규식). 호출하는 쪽은 2 를 갱신 필요로 다룬다

import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { git } from './lib/git.ts'
import { groupMap, judge, splitGlobs, verdictText } from './lib/overlap.ts'
import { pyRegExp } from './lib/py.ts'

const USAGE = [
  '사용법: overlap_units.ts --base REF --head REF [--shared-paths 정규식] [--unit-prefix 접두] [--unit-group a,b ...]',
  '                         [--docs-glob G1,G2] [--repo DIR]',
].join('\n')

function gitLines(repo: string, args: string[]): string[] {
  const done = git(repo, args)
  if (done.code !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr.trim() || `종료 코드 ${done.code}`}`)
  return done.stdout.split('\n').filter((line) => line)
}

// merge-base 이후 양쪽에서 바뀐 파일. 이름 바꾸기는 옛 경로와 새 경로를 따로 센다.
function changedFiles(repo: string, base: string, head: string): [string[], string[]] {
  const mb = gitLines(repo, ['merge-base', base, head])[0]
  if (!mb) throw new Error(`git merge-base ${base} ${head} 가 커밋을 내지 않았다`)
  return [
    gitLines(repo, ['diff', '--name-only', '--no-renames', mb, head]),
    gitLines(repo, ['diff', '--name-only', '--no-renames', mb, base]),
  ]
}

function main(argv: string[]): number {
  const options = {
    base: { type: 'string' },
    head: { type: 'string' },
    'shared-paths': { type: 'string', default: '' },
    'unit-prefix': { type: 'string', default: 'modules/' },
    'unit-group': { type: 'string', multiple: true, default: [] },
    'docs-glob': { type: 'string', default: '' },
    repo: { type: 'string', default: '.' },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv, options), options }).values
  } catch (e) {
    process.stderr.write(`${USAGE}\noverlap_units: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.base || !values.head) {
    process.stderr.write(`${USAGE}\noverlap_units: --base 와 --head 가 필요하다\n`)
    return 2
  }
  const sharedPaths = values['shared-paths']
  let groups: string[][]
  let files: [string[], string[]]
  try {
    if (sharedPaths) pyRegExp(sharedPaths)
    groups = values['unit-group'].map(splitGlobs)
    groupMap(groups)
    files = changedFiles(values.repo, values.base, values.head)
  } catch (e) {
    process.stderr.write(`오류: ${(e as Error).message}\n`)
    return 2
  }
  const verdict = judge(files[0], files[1], {
    sharedPaths,
    unitPrefix: values['unit-prefix'],
    docsGlobs: splitGlobs(values['docs-glob']),
    groups,
  })
  process.stdout.write(`${verdictText(verdict)}\n`)
  return verdict.update ? 1 : 0
}

process.exitCode = main(process.argv.slice(2))
