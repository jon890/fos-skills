// 진단과 설치. 브라우저를 조작하지 않는 명령이다.

import { mkdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { BACKENDS, EGO_INSTALL_URL, resolveBackendName } from './backends/index.ts'
import { COMMANDS } from './commands.ts'
import { CONFIG_PATH, CONFIG_RESOLUTION } from './config.ts'
import { EXIT_USAGE, UsageError } from './errors.ts'
import { print } from './io.ts'
import { exists, isSymlink, pyExpanduser, pyHomePrefix, pyPath, pyResolve, pyStrCompare, shQuote, which } from './pylike.ts'

export function cmdDoctor(): number {
  print('=== 브라우저 드라이버 진단 ===')
  print('')
  print(`설정 파일: ${CONFIG_PATH}` + (exists(CONFIG_PATH) ? '' : '  (없음, 자동 감지로 돈다)'))
  print(`설정 판정: ${CONFIG_RESOLUTION.reason}`)

  const env = process.env.BROWSER_DRIVER
  print(`BROWSER_DRIVER: ${env ? env : '(비어 있음)'}`)

  print('')
  print('백엔드')
  for (const [name, backend] of BACKENDS) {
    const path = which(backend.binary)
    if (!path) {
      print(`  ✗ ${name.padEnd(14)} 설치 안 됨`)
      continue
    }
    const note = backend.prepareNote()
    const mark = backend.verified ? '✓' : '!'
    print(`  ${mark} ${name.padEnd(14)} ${path}`)
    if (note) {
      // 백엔드가 줄을 나눠 오면 그대로 나눠 낸다. ego 의 프로필 해석처럼
      // 한 줄로 이으면 묻히는 판정이 있다.
      const [head, ...rest] = note.split('\n')
      print(`      참고: ${head}`)
      for (const line of rest) print(`      ${line}`)
    }
    const missing = COMMANDS.map((c) => c.name)
      .filter((commandName) => !backend.supported.has(commandName))
      .sort(pyStrCompare)
    if (missing.length) print(`      못 쓰는 명령: ${missing.join(', ')}`)
  }

  print('')
  let name: unknown
  let source: string
  try {
    ;[name, source] = resolveBackendName()
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    print('판정: 쓸 수 있는 백엔드가 없다')
    print(`  ${error.message}`)
    return EXIT_USAGE
  }
  print(`판정: ${typeof name === 'string' ? name : String(name)} (${source})`)
  if (name !== 'ego') {
    if (BACKENDS.get('ego')!.available()) {
      print('  권고: 로그인 세션이 필요한 자동화는 ego 가 맞다. 설치돼 있으니 driver 를 ego 로 두는 것을 권한다.')
    } else {
      print(`  권고: 로그인 세션이 필요한 자동화는 ego lite 가 맞다. ${EGO_INSTALL_URL} 에서 설치하길 권한다.`)
    }
  }
  return 0
}

// 심링크가 아닌 실제 파일이면 `.bak.{pid}` 로 옮기고 백업 경로를 돌려준다.
//
// 사용자가 같은 이름으로 만들어 둔 스크립트를 말없이 지우지 않기 위한 보호다.
function backupIfRealFile(path: string): string | null {
  if (isSymlink(path) || !exists(path)) return null
  // Path.with_suffix(suffix + ".bak.pid"): 마지막 확장자 뒤에 붙는다
  const backup = `${path}.bak.${process.pid}`
  renameSync(path, backup)
  return backup
}

// 이 드라이버의 진입 파일을 ~/.claude/scripts/ 에 심볼릭 링크로 연결한다.
//
// 심링크라 git pull 만으로 최신이 그대로 반영된다 (스킬 설치 방식과 동일).
export function cmdInstall(argv: string[]): number {
  let dst = pyPath(`${pyHomePrefix()}/.claude/scripts`)
  if (argv.length >= 2 && argv[0] === '--dst') dst = pyPath(pyExpanduser(argv[1]))

  // 링크가 가리키는 곳은 진입 파일(browser_driver.ts)이다. 이 파일은 driver/ 아래에 있으므로 한 단계 위다
  const src = pyResolve(`${dirname(import.meta.dirname)}/browser_driver.ts`)
  mkdirSync(dst, { recursive: true })

  print('=== 브라우저 드라이버 설치 ===')
  print('')
  for (const linkName of ['browser-driver']) {
    const link = pyPath(`${dst}/${linkName}`)
    const backup = backupIfRealFile(link)
    if (backup) print(`  기존 파일을 ${backup} 로 백업`)
    if (isSymlink(link) || exists(link)) unlinkSync(link)
    symlinkSync(src, link)
    print(`  ✓ ${link} → ${src}`)
  }

  // 셸 시절에 쓰던 이름들이다. 남아 있으면 낡은 사본을 부르게 되므로 지운다.
  // 심링크만 지우고, 사용자가 같은 이름으로 만든 실제 파일은 백업해 남긴다.
  for (const staleName of ['orca-browser.sh', 'browser-driver.sh']) {
    const stale = pyPath(`${dst}/${staleName}`)
    const backup = backupIfRealFile(stale)
    if (backup) {
      print(`  기존 파일을 ${backup} 로 백업`)
      continue
    }
    if (isSymlink(stale) || exists(stale)) {
      unlinkSync(stale)
      print(`  ✓ 낡은 ${stale} 제거`)
    }
  }

  print('')
  print('백엔드 확인')
  try {
    const [name, source] = resolveBackendName()
    print(`  ✓ ${String(name)} (${source})`)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    print('  ✗ 쓸 수 있는 백엔드가 없다')
    print(`    ${error.message}`)
  }

  print('')
  print('설정을 바꾸려면 예시를 복사해 고친다.')
  // 플러그인 데이터 폴더는 설치만으로는 생기지 않아 부모가 없으면 cp 가 실패한다.
  print(`  mkdir -p ${shQuote(dirname(CONFIG_PATH))}`)
  print(`  cp ${shQuote(`${dirname(src)}/browser.config.example.json`)} ${shQuote(CONFIG_PATH)}`)
  return 0
}

