// 팀 저장소로 내보내는 폴더가 그 폴더 밖을 상대 경로로 import 하지 못하게 막는다.
// 팀 저장소에서는 폴더 배치가 달라(korean-check, content-preview 는 심볼릭 링크) 밖을 가리키는 상대 경로가 다른 곳을 가리킨다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { tempDir } from '../../modules/testkit/temp.ts'
import { sharedLists } from '../export-lists.ts'
import { SKILL_ROOTS } from '../skill_paths.ts'

const EXTENSIONS = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const SKIP_DIRS = new Set(['node_modules', '.git'])

// 각 꼴에서 `.` 로 시작하는 경로 문자열을 잡는다
const SPECIFIER_PATTERNS = [
  /\bfrom\s*(['"`])(\.[^'"`]*)\1/g, // import ... from, export ... from
  /\bimport\s*(['"`])(\.[^'"`]*)\1/g, // 부수 효과 import
  /\bimport\s*\(\s*(['"`])(\.[^'"`]*)\1/g, // 동적 import
  /\brequire\s*\(\s*(['"`])(\.[^'"`]*)\1/g,
  /\bnew\s+URL\s*\(\s*(['"`])(\.[^'"`]*)\1\s*,\s*import\.meta\.url/g,
]

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (SKIP_DIRS.has(name)) continue
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (EXTENSIONS.test(name)) found.push(path)
  }
  return found
}

// folders 는 root 기준 상대 경로다. `<저장소 상대 파일>: <import 경로>` 를 모은다
export function outsideImports(root: string, folders: string[]): string[] {
  const outside: string[] = []
  for (const folder of folders) {
    const base = resolve(root, folder)
    for (const file of sourceFiles(base)) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of SPECIFIER_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const specifier = match[2]
          const rel = relative(base, resolve(dirname(file), specifier))
          if (rel === '..' || rel.startsWith('../')) outside.push(`${relative(root, file)}: ${specifier}`)
        }
      }
    }
  }
  return outside
}

// scripts/export-to-team.ts 의 SHARED_SKILLS, SHARED_TOOLS 를 읽어 폴더로 바꾼다. 찾지 못한 이름이 있으면 던진다
export function exportedFolders(root: string): string[] {
  const lists = sharedLists(readFileSync(join(root, 'scripts/export-to-team.ts'), 'utf8'))
  if (!lists) throw new Error('export-to-team.ts 에서 SHARED_SKILLS, SHARED_TOOLS 를 찾지 못했다')
  const names = (variable: 'SHARED_SKILLS' | 'SHARED_TOOLS') => (variable === 'SHARED_SKILLS' ? lists.skills : lists.tools)
  const folders: string[] = []
  for (const name of names('SHARED_SKILLS')) {
    const found = SKILL_ROOTS.map((r) => `${r}/${name}`).find((p) => existsSync(join(root, p)))
    if (!found) throw new Error(`내보내는 스킬 폴더가 없다: ${name} (${SKILL_ROOTS.join(', ')} 에서 찾았다)`)
    folders.push(found)
  }
  for (const name of names('SHARED_TOOLS')) {
    if (!existsSync(join(root, `tools/${name}`))) throw new Error(`내보내는 도구 폴더가 없다: tools/${name}`)
    folders.push(`tools/${name}`)
  }
  return folders
}

const REPO_ROOT = join(import.meta.dirname, '..', '..')

function write(root: string, file: string, text: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('내보내는 폴더의 바깥 import', () => {
  it('저장소의 내보내는 폴더는 밖을 import 하지 않는다', () => {
    assert.deepEqual(outsideImports(REPO_ROOT, exportedFolders(REPO_ROOT)), [])
  })

  const forms: [string, string][] = [
    ['import from', "import { a } from '../../out/x.ts'"],
    ['여러 줄 import', "import {\n  a,\n  b,\n} from '../../out/x.ts'"],
    ['export from', "export { a } from '../../out/x.ts'"],
    ['부수 효과 import', "import '../../out/x.ts'"],
    ['동적 import', "const m = await import('../../out/x.ts')"],
    ['require', "const m = require('../../out/x.cjs')"],
    ['new URL', "const u = new URL('../../out/x.json', import.meta.url)"],
  ]
  for (const [name, line] of forms) {
    it(`${name}: 밖을 가리키면 잡고 안을 가리키면 잡지 않는다`, () => {
      const root = tempDir()
      write(root, 'skills/demo/scripts/a.ts', `${line}\n`)
      assert.equal(outsideImports(root, ['skills/demo']).length, 1)
      write(root, 'skills/demo/scripts/a.ts', `${line.replaceAll('../../out/', '../lib/')}\n`)
      assert.deepEqual(outsideImports(root, ['skills/demo']), [])
    })
  }

  it('확장자마다 읽는다', () => {
    const root = tempDir()
    for (const ext of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']) write(root, `skills/demo/a.${ext}`, "import '../x'\n")
    write(root, 'skills/demo/a.md', "import '../x'\n")
    assert.equal(outsideImports(root, ['skills/demo']).length, 6)
  })

  it('보고 줄은 저장소 상대 파일과 경로를 적는다', () => {
    const root = tempDir()
    write(root, 'tools/t/a.ts', "import '../x.ts'\n")
    assert.deepEqual(outsideImports(root, ['tools/t']), ['tools/t/a.ts: ../x.ts'])
  })

  it('exportedFolders 는 목록의 폴더를 고른다', () => {
    const root = tempDir()
    write(root, 'scripts/export-to-team.ts', "export const SHARED_SKILLS = ['alpha', 'beta']\nexport const SHARED_TOOLS = ['drv']\n")
    mkdirSync(join(root, 'skills/alpha'), { recursive: true })
    mkdirSync(join(root, 'export-only-skills/beta'), { recursive: true })
    mkdirSync(join(root, 'tools/drv'), { recursive: true })
    assert.deepEqual(exportedFolders(root), ['skills/alpha', 'export-only-skills/beta', 'tools/drv'])
  })

  it('목록에 없는 폴더 이름이면 exportedFolders 가 던진다', () => {
    const root = tempDir()
    write(root, 'scripts/export-to-team.ts', "export const SHARED_SKILLS = ['missing']\nexport const SHARED_TOOLS = []\n")
    assert.throws(() => exportedFolders(root), /missing/)
    write(root, 'scripts/export-to-team.ts', "export const SHARED_SKILLS = []\nexport const SHARED_TOOLS = ['nope']\n")
    assert.throws(() => exportedFolders(root), /nope/)
  })
})
