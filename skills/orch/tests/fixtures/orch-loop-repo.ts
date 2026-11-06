import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { copyRepo, git, templateRepo } from '../../../../modules/testkit/git.ts'
import type { Repo } from '../../../../modules/testkit/git.ts'
import { tempDir } from '../../../../modules/testkit/temp.ts'

const templates = new Map<string, Repo>()

// 초기 파일이 같은 저장소는 파일 프로세스마다 한 번 만들고 테스트별 origin 과 clone 으로 복사한다.
export function loopRepo(dest: string, files: Record<string, string> = {}): Repo {
  if (Object.keys(files).length === 0) return copyRepo(dest)
  const key = JSON.stringify(files)
  let source = templates.get(key)
  if (!source) {
    source = copyRepo(join(tempDir('loop-template-'), 'repo'), templateRepo())
    for (const [name, content] of Object.entries(files)) {
      const file = join(source.dir, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    git(source.dir, ['add', '.'])
    git(source.dir, ['commit', '-q', '-m', 'init'])
    git(source.dir, ['push', '-q', 'origin', 'main'])
    git(source.dir, ['remote', 'set-head', 'origin', 'main'])
    templates.set(key, source)
  }
  return copyRepo(dest, source)
}
