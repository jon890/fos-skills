#!/usr/bin/env node
// 미리보기 HTML 을 사용자 화면에 띄운다. 같은 파일이 이미 열려 있으면 새 탭을 만들지 않고 갱신한다.
//
// 왜 이렇게 하는가 (실측):
//   1. 에이전트 브라우저에 탭을 만들면 사용자 화면에 드러나지 않는다. 탭은 생기는데 보이지 않아
//      사용자가 미리보기를 찾지 못한다. 미리보기는 사람이 읽어야 하므로 기본 브라우저로 띄운다.
//   2. 본문을 고쳐 같은 경로로 재생성할 때마다 탭이 쌓인다. 사용자는 어느 탭이 새 본문인지
//      알 수 없고, 오래된 탭을 읽고 판단한다.
//   3. 에이전트 IDE 안의 브라우저(예: Orca)로 보는 사람은 위 두 경로로 찾을 수 없다.
//      AppleScript 는 Chrome 계열과 Safari 만 훑기 때문이다. browser-driver 로 열고
//      돌려받은 page id 로 같은 탭을 다시 쓴다.
//   4. 그 탭은 사용자가 보는 워크트리에 있어야 한다. 다른 워크트리에 열리면 갱신은 성공하는데
//      화면은 바뀌지 않아, 사용자는 미리보기가 열리지 않았다고 판단한다. 그래서 열거나 다시 쓸
//      때마다 워크트리를 대조하고, 어긋나면 그 탭을 닫고 기본 브라우저로 내려간다.
//   5. 어느 백엔드로 띄울지는 사람이 정한다. 이 스크립트가 값을 박지 않는다.
//      미리보기는 사람이 읽는 화면이라 IDE 안의 탭에 떠야 하고 워크트리 대조도 되어야 하는데,
//      그 둘을 주는 백엔드가 환경마다 다르다. 자동화용 백엔드로 띄우면 worktree 명령이 없어
//      대조를 건너뛰고, 사용자가 로그인해 둔 프로필의 탭을 자동화와 함께 쓰게 된다.
//      그래서 값을 정할 자리를 두고, 정하지 않았으면 대조를 건너뛴다는 것만 알린다.
//
// 사용법:
//   node show-preview.ts /path/to/preview.html
//
// 종료 코드:
//   0  띄웠거나 기존 탭을 갱신했다
//   1  경로를 주지 않았다
//   2  파일이 없거나 어떤 방법으로도 열지 못했다
//
// browser-driver(browser_driver.py)는 아직 Python 이라 옛 꼴 그대로 실행 파일로 부른다.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isMain, write } from './io.ts'
import { pyStr } from './kit/py.ts'

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// $(...) 처럼 끝의 줄바꿈을 모두 지운다
const stripNewlines = (text: string) => text.replace(/\n+$/, '')

// 셸의 논리 현재 디렉터리. PWD 가 지금 디렉터리를 가리킬 때만 쓴다(셸이 시작할 때 하는 확인과 같다)
function logicalCwd(): string {
  const cwd = process.cwd()
  const pwd = process.env.PWD
  try {
    if (pwd && resolve(pwd) === pwd && realpathSync(pwd) === realpathSync(cwd)) return pwd
  } catch {
    // 아래로 내려간다
  }
  return cwd
}

// 스킬 번들 위치에서 위로 올라가며 browser_driver.py 를 찾는다.
// 이 저장소의 드라이버는 skills/browser/browser-driver/, 팀 사본은 tools/browser-driver/ 에 있다.
// 스킬 번들도 이 저장소는 export-only-skills/content-preview/scripts, 팀 사본은 skills/content-preview/scripts 라
// 거리가 한 단 다르다. 고정 상대경로로는 둘 다 맞출 수 없다 (실측).
// 스킬 디렉터리가 심링크라 논리 경로로는 저장소 밖으로 나가므로 실체 경로를 잡는다.
const DRIVER_HOMES = ['skills/browser/browser-driver', 'tools/browser-driver']
function findBundledDriver(): string | null {
  let dir = realpathSync(import.meta.dirname)
  for (let i = 0; i < 5; i++) {
    dir = dirname(dir)
    if (dir === '/') return null
    for (const home of DRIVER_HOMES) {
      const cand = join(dir, home, 'browser_driver.py')
      if (isExecutable(cand)) return cand
    }
  }
  return null
}

type Out = { code: number; out: string }

// 실행 파일을 직접 부른다. stderr 는 버리고 stdout 은 $(...) 처럼 끝의 줄바꿈을 지워 낸다. 띄우지 못하면 126 이다
function call(argv0: string, args: string[], env: NodeJS.ProcessEnv = process.env): Out {
  const done = spawnSync(argv0, args, { env, stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' })
  if (done.error) return { code: 126, out: '' }
  return { code: done.status ?? 128, out: stripNewlines(done.stdout) }
}

// 설정 파일의 previewDriver. 설정 파일 경로는 드라이버와 같은 것을 본다.
// 두 곳이 갈리면 doctor 가 읽는 파일과 미리보기가 읽는 파일이 달라져, 사용자가 고친 값이 반영되지 않는다.
// 경로를 정하는 곳은 드라이버 본체 하나라 BROWSER_CONFIG 가 없으면 `config-path` 로 묻는다.
// 플러그인 설치본은 설정을 데이터 폴더에 두므로 이 스크립트가 옛 위치를 박으면 갈린다.
// config-path 를 모르는 옛 드라이버는 실패하므로 옛 위치로 내려간다.
// 값이 문자열, 숫자, 불리언이 아니면 없는 것으로 본다.
function previewDriverFromConfig(driver: string): string {
  let cfg = process.env.BROWSER_CONFIG ?? ''
  if (!cfg && driver) {
    const asked = call(driver, ['config-path'])
    cfg = asked.code === 0 ? asked.out : ''
    if (cfg.includes('\n')) cfg = ''
  }
  if (!cfg) cfg = `${process.env.HOME ?? ''}/.claude/browser.config.json`
  if (!isFile(cfg)) return ''
  try {
    const parsed = JSON.parse(readFileSync(cfg, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
    const value = parsed.previewDriver
    if (!value || !['string', 'number', 'boolean'].includes(typeof value)) return ''
    return stripNewlines(typeof value === 'string' ? value : pyStr(value))
  } catch {
    return ''
  }
}

// 기존 탭을 찾아 갱신하는 AppleScript. 앱마다 탭을 앞으로 가져오는 방식이 다르다
function chromiumScript(app: string, fileUrl: string): string {
  return `tell application "System Events"
  if not (exists process "${app}") then return "absent"
end tell
tell application "${app}"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if URL of t is equal to "${fileUrl}" then
        tell t to reload
        set active tab index of w to i
        set index of w to 1
        activate
        return "reloaded"
      end if
    end repeat
  end repeat
end tell
return "notfound"
`
}

function safariScript(fileUrl: string): string {
  return `tell application "System Events"
  if not (exists process "Safari") then return "absent"
end tell
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t is equal to "${fileUrl}" then
        set URL of t to (URL of t)
        set current tab of w to t
        set index of w to 1
        activate
        return "reloaded"
      end if
    end repeat
  end repeat
end tell
return "notfound"
`
}

// osascript 에 스크립트를 stdin 으로 준다. 돌지 못하면 빈 글자다
function osascript(script: string): string {
  const done = spawnSync('osascript', [], { input: script, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' })
  return done.error ? '' : stripNewlines(done.stdout ?? '')
}

const MISSING = new Set(['ENOENT', 'EACCES', 'ENOTDIR'])

export function main(argv: string[]): number {
  const file = argv[0]
  if (!file) {
    write(2, '미리보기 HTML 경로가 필요하다\n')
    return 1
  }
  if (!isFile(file)) {
    write(2, `파일이 없다: ${file}\n`)
    return 2
  }

  // AppleScript 대조는 전체 주소로 한다. basename 만 보면 다른 디렉터리의 같은 이름
  // (preview.html 처럼 흔한 이름) 탭을 잡아 엉뚱한 화면을 갱신하고 앞으로 가져온다.
  // 셸의 cd 와 pwd 처럼 심링크를 풀지 않은 논리 경로로 만든다
  const abs = `${resolve(logicalCwd(), dirname(file))}/${basename(file)}`
  const fileUrl = `file://${abs}`

  // 1순위 — browser-driver 가 있으면 그것으로 띄운다.
  // 어느 브라우저를 쓰는지는 드라이버가 정하므로 에이전트 IDE 안의 탭도 잡힌다.
  // page id 를 HTML 옆에 남겨 다음 실행이 같은 탭을 다시 쓴다.
  //
  // 찾는 순서는 셋이다. 호출자가 지정한 것, 스킬과 함께 받은 것, 개인이 걸어 둔 것.
  // 함께 받은 것을 개인 심링크보다 먼저 보는 이유는, 스킬만 받은 사람도 그대로 돌아가야 해서다.
  //
  // 경로를 지정하는 변수는 BROWSER_DRIVER_PATH 다. BROWSER_DRIVER 를 쓰지 않는 이유는
  // 드라이버 자신이 그 이름을 백엔드 이름으로 읽기 때문이다. 한 이름에 두 뜻을 두면
  // BROWSER_DRIVER=ego 를 셸에 둔 사람이 여기서는 실행 파일 경로로 해석되는 값을 주게 된다.
  let driver = ''
  for (const cand of [process.env.BROWSER_DRIVER_PATH ?? '', findBundledDriver() ?? '', `${process.env.HOME ?? ''}/.claude/scripts/browser-driver`]) {
    if (cand && isExecutable(cand)) {
      driver = cand
      break
    }
  }

  // 사람이 보는 화면은 이 세션이 서 있는 워크트리다. ORCA_WORKTREE 가 없으면 현재 저장소 루트를
  // 그 값으로 쓴다. 비워 두면 조사하느라 다른 저장소로 cd 한 채 만든 탭이 그대로 재사용되고,
  // 갱신은 성공하는데 사용자 화면은 바뀌지 않는다.
  let want: string
  if (process.env.ORCA_WORKTREE) {
    want = process.env.ORCA_WORKTREE.replace(/^path:/, '')
  } else {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' })
    want = !top.error && top.status === 0 ? stripNewlines(top.stdout) : logicalCwd()
  }

  // 미리보기가 쓸 백엔드. 위 4번과 5번이 무엇을 고려해 정하는지 말한다.
  // 찾는 순서는 둘이다. 호출자가 준 환경변수, 그리고 설정 파일의 previewDriver.
  // 둘 다 없으면 값을 주지 않아 드라이버의 자동 감지에 맡긴다.
  const preview = process.env.PREVIEW_BROWSER_DRIVER || previewDriverFromConfig(driver)

  // 드라이버를 부르는 단일 창구. 정해진 값이 있으면 매번 그 백엔드로 부른다.
  // 직접 드라이버를 부르면 그 호출만 다른 백엔드로 돌아 탭이 갈린다.
  const drv = (...args: string[]): Out => call(driver, args, preview ? { ...process.env, BROWSER_DRIVER: preview } : process.env)

  if (driver && isExecutable(driver)) {
    const idfile = `${abs}.tabid`
    if (isFile(idfile)) {
      let page = stripNewlines(readFileSync(idfile, 'utf8'))
      // 탭이 닫혔으면 url 조회가 실패한다. 그때는 아래에서 새로 연다.
      if (page && drv('url', page).code === 0) {
        // 살아 있어도 사용자가 보는 곳의 탭이 아닐 수 있다. 조사하느라 다른 저장소로 cd 한 채
        // 만든 탭이 그대로 남으면, 갱신은 성공하는데 사용자 화면은 바뀌지 않는다 (실측).
        // 드라이버가 worktree 명령을 모르면 대조를 건너뛴다.
        if (drv('worktree', page).code !== 0) write(2, '이 백엔드는 worktree 를 다루지 않아 탭 위치를 대조하지 못한다.\n')
        const have = drv('worktree', page)
        if (have.code === 0 && have.out !== '' && have.out !== want) {
          write(2, `기존 탭이 다른 워크트리에 있다: ${have.out}. 새로 연다.\n`)
          page = ''
        }
        if (page && drv('nav', page, fileUrl).code === 0) {
          write(1, `갱신: 기존 탭 (${page})\n`)
          return 0
        }
        if (page) write(2, '기존 탭을 찾았으나 갱신하지 못했다. 새로 연다.\n')
      }
    }
    const opened = drv('open', fileUrl)
    let page = opened.code === 0 ? opened.out : ''
    if (page) {
      // 쓰기에 실패해도 탭은 이미 열렸다. 조용히 죽지 않게 알리고 계속한다
      try {
        writeFileSync(idfile, `${page}\n`)
      } catch {
        write(2, `탭 id 를 남기지 못했다. 다음 실행은 새 탭을 연다: ${idfile}\n`)
      }
      write(1, `새로 열었다: ${abs}\n`)
      // 어느 워크트리에 열렸는지 함께 알린다. 사용자가 탭을 찾지 못하는 상황을 바로 드러낸다
      if (drv('worktree', page).code !== 0) {
        write(2, '이 백엔드는 worktree 를 다루지 않아 탭 위치를 대조하지 못한다.\n')
        write(2, '사람이 볼 화면이면 설정 파일의 previewDriver 나 PREVIEW_BROWSER_DRIVER 로 정한다.\n')
      }
      const where = drv('worktree', page)
      if (where.code === 0 && where.out !== '') {
        write(1, `탭 위치: ${where.out}\n`)
        if (where.out !== want) {
          // 여기서 성공으로 끝내면 사용자는 보이지 않는 탭을 찾다가 미리보기가 열리지 않았다고 판단한다
          write(2, `이 탭은 사용자가 보는 워크트리(${want})가 아니다. 기본 브라우저로 다시 띄운다.\n`)
          // 남겨 두면 다음 실행이 다시 집어 갈 수 있고, 사용자가 찾지 못하는 탭만 쌓인다
          drv('close', page)
          rmSync(idfile, { force: true })
          page = ''
        }
      }
      if (page) return 0
    }
    // 여기까지 왔으면 드라이버가 실패한 것이다. 조용히 넘어가지 않고 알린 뒤 기본 브라우저로 간다
    write(2, `browser-driver(${preview || '자동 감지'}) 로 열지 못했다. 기본 브라우저로 내려간다.\n`)
  }

  const uname = spawnSync('uname', ['-s'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' })
  const system = uname.error ? '' : stripNewlines(uname.stdout)

  // macOS 에서만 기존 탭을 찾아 갱신할 수 있다. 다른 환경은 새로 여는 것으로 내려간다.
  if (system === 'Darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser']) {
      if (osascript(chromiumScript(app, fileUrl)) === 'reloaded') {
        write(1, `갱신: ${app} 의 기존 탭\n`)
        return 0
      }
    }

    // Safari 는 탭을 앞으로 가져오는 방식이 달라 따로 처리한다.
    if (osascript(safariScript(fileUrl)) === 'reloaded') {
      write(1, '갱신: Safari 의 기존 탭\n')
      return 0
    }

    const opened = spawnSync('open', [abs], { stdio: 'inherit' })
    if (!opened.error && opened.status === 0) {
      write(1, `새로 열었다: ${abs}\n`)
      return 0
    }
    write(2, `기본 브라우저로 열지 못했다: ${abs}\n`)
    return 2
  }

  const xdg = spawnSync('xdg-open', [abs], { stdio: 'ignore' })
  if (!xdg.error || !MISSING.has((xdg.error as NodeJS.ErrnoException).code ?? '')) {
    if (!xdg.error && xdg.status === 0) {
      write(1, `새로 열었다: ${abs}\n`)
      write(1, '이 환경은 기존 탭 갱신을 지원하지 않는다. 재생성하면 탭이 하나 더 열린다.\n')
      return 0
    }
    write(2, `xdg-open 으로 열지 못했다: ${abs}\n`)
    return 2
  }

  write(2, `브라우저를 열 방법을 찾지 못했다. 직접 열어야 한다: ${abs}\n`)
  return 2
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
