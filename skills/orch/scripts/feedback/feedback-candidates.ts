// 개선 후보를 정해진 칸으로만 적는다. migrate 는 미리보기가 기본이고 --apply 일 때만 원본을 휴지통으로 옮긴다.
// 종료 코드: 0 성공, 1 중복·없는 후보·옮기기 실패, 2 사용법 오류.
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { ensure, pathOf } from '../lib/paths.ts'
import { isOpen, parseLegacy, render, scan, validStatus, type Field } from '../lib/feedback.ts'
import { oneLine, validSlug } from '../lib/study.ts'

const USAGE = [
  '사용법: orch feedback add --slug 이름 --title 제목 --skill 스킬 --file 스킬파일 --situation 상황 --problem 문제 --want 바라는기능 --evidence 근거 --significance 유의미한이유 --nontrivial 단순함정이아닌이유 --structural 구조로막는방법 [--repo DIR]',
  '        orch feedback list [--open] [--repo DIR]',
  '        orch feedback set --slug 이름 --status "후보 | 채택 #PR | 기각(이유) | 보류(이유)" [--repo DIR]',
  '        orch feedback migrate [--apply] [--trash DIR] [--repo DIR]',
].join('\n')
const OPTIONS = {
  ...Object.fromEntries(['slug', 'title', 'skill', 'file', 'situation', 'problem', 'want', 'evidence', 'significance', 'nontrivial', 'structural', 'status', 'repo', 'trash'].map(key => [key, { type: 'string' as const }])),
  open: { type: 'boolean' as const }, apply: { type: 'boolean' as const }, help: { type: 'boolean' as const, short: 'h' },
}
class Usage extends Error {}
class Refused extends Error {}

function migratedSlug(file: string, index: number): string {
  const name = basename(file, '.md').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45).replace(/-$/, '') || 'memo'
  const hash = createHash('sha256').update(basename(file)).digest('hex').slice(0, 8)
  return `migrated-${name}-${hash}-${index + 1}`
}

function main(): number {
  try {
    let parsed
    try { parsed = parseArgs({ args: expandArgs(process.argv.slice(2), OPTIONS, ['title', 'skill', 'file', 'situation', 'problem', 'want', 'evidence', 'significance', 'nontrivial', 'structural', 'status']), options: OPTIONS, allowPositionals: true }) }
    catch (error) { throw new Usage((error as Error).message) }
    const { values, positionals } = parsed
    if (values.help) { process.stdout.write(`${USAGE}\n`); return 0 }
    const [command, ...rest] = positionals
    if (!['add', 'list', 'set', 'migrate'].includes(command) || rest.length) throw new Usage('add, list, set, migrate 가운데 하나를 준다')
    const allowed: Record<string, string[]> = {
      add: ['slug', 'title', 'skill', 'file', 'situation', 'problem', 'want', 'evidence', 'significance', 'nontrivial', 'structural'],
      list: ['open'], set: ['slug', 'status'], migrate: ['apply', 'trash'],
    }
    for (const key of Object.keys(values)) if (!['repo', ...allowed[command]].includes(key)) throw new Usage(`${command} 에 --${key} 를 쓸 수 없다`)
    const need = (key: string): string => {
      const value = values[key]
      if (typeof value !== 'string' || !value.trim()) throw new Usage(`--${key} 를 준다`)
      return oneLine(value)
    }
    const repo = typeof values.repo === 'string' ? values.repo : process.cwd()
    const dir = pathOf('feedback', repo)
    const found = scan(dir)
    if (command === 'list') {
      for (const candidate of found.candidates) {
        if (!values.open || isOpen(candidate)) process.stdout.write(`${candidate.slug}\t${candidate.values.상태}\t${candidate.title}\n`)
      }
      for (const file of found.legacy) process.stderr.write(`옛 메모는 feedback migrate 로 미리 본다: ${file}\n`)
    } else if (command === 'add' || command === 'set') {
      const slug = need('slug')
      if (!validSlug(slug)) throw new Usage('--slug 는 영문 소문자, 숫자, 하이픈으로 80자 안이다')
      const file = join(dir, `${slug}.md`)
      if (command === 'add') {
        const title = need('title')
        const fields: Record<Field, string> = {
          스킬: `${need('skill')} (${need('file')})`, 상황: need('situation'), 문제: need('problem'),
          '바라는 기능': need('want'), 근거: need('evidence'),
          판단: `유의미한가: ${need('significance')} / 단순 함정이 아닌가: ${need('nontrivial')} / 구조로 막을 수 있는가: ${need('structural')}`,
          상태: '후보',
        }
        if (existsSync(file)) throw new Refused(`파일이 이미 있다: ${file}`)
        ensure('feedback', repo)
        writeFileSync(file, render(title, fields), { flag: 'wx' })
        process.stdout.write(`ADDED ${slug} ${file}\n`)
      } else {
        const status = need('status')
        if (!validStatus(status)) throw new Usage('--status 는 후보, 채택 #PR, 기각(이유), 보류(이유) 가운데 하나다')
        const candidate = found.candidates.find(c => c.slug === slug)
        if (!candidate) throw new Refused(`${slug} 후보가 없다. feedback list 로 이름을 본다`)
        const temp = `${file}.tmp-${process.pid}`
        writeFileSync(temp, render(candidate.title, { ...candidate.values, 상태: status }))
        renameSync(temp, file)
        process.stdout.write(`SET ${slug} ${status}\n`)
      }
    } else {
      const trash = resolve(typeof values.trash === 'string' ? values.trash : join(homedir(), '.Trash', 'orch-feedback'))
      if (trash === resolve(dir) || trash.startsWith(`${resolve(dir)}${sep}`)) throw new Usage('--trash 는 후보 폴더 밖에 둔다')
      const plans = found.legacy.map((file) => ({
        file, dest: join(trash, basename(file)),
        candidates: parseLegacy(readFileSync(file, 'utf8'), join(trash, basename(file))).map((candidate, i) => ({
          file: join(dir, `${migratedSlug(file, i)}.md`),
          text: render(candidate.title, candidate.values),
        })),
      }))
      // 쓰기 전에 모두 확인하고 기존 후보와 휴지통 파일을 덮어쓰지 않는다.
      for (const plan of plans) {
        if (existsSync(plan.dest)) throw new Refused(`휴지통에 같은 이름이 있다: ${plan.dest}`)
        for (const candidate of plan.candidates) if (existsSync(candidate.file) && readFileSync(candidate.file, 'utf8') !== candidate.text) throw new Refused(`옮길 파일이 이미 있다: ${candidate.file}`)
      }
      for (const plan of plans) {
        const created: string[] = []
        try {
          if (values.apply) mkdirSync(trash, { recursive: true })
          for (const candidate of plan.candidates) {
            if (values.apply && !existsSync(candidate.file)) {
              writeFileSync(candidate.file, candidate.text, { flag: 'wx' })
              created.push(candidate.file)
            }
          }
          if (values.apply) {
            try { renameSync(plan.file, plan.dest) }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
              copyFileSync(plan.file, plan.dest, constants.COPYFILE_EXCL)
              try { unlinkSync(plan.file) }
              catch (error) { rmSync(plan.dest); throw error }
            }
          }
        } catch (error) {
          for (const file of created) rmSync(file, { force: true })
          throw new Refused(`옮기지 못했다. 원본을 남겼으니 같은 명령으로 다시 실행한다: ${plan.file}: ${(error as Error).message}`)
        }
        for (const candidate of plan.candidates) process.stdout.write(`${values.apply ? 'MIGRATED' : 'PREVIEW'} ${plan.file} -> ${candidate.file}\n${candidate.text}`)
        if (values.apply) process.stdout.write(`TRASHED ${plan.file} ${plan.dest}\n`)
      }
      process.stdout.write(`${values.apply ? 'APPLIED' : 'DRY-RUN'} ${plans.length} files ${plans.reduce((n, p) => n + p.candidates.length, 0)} candidates\n`)
    }
    return 0
  } catch (error) {
    if (error instanceof Usage) { process.stderr.write(`${USAGE}\n${error.message}\n`); return 2 }
    if (error instanceof Refused) { process.stderr.write(`${error.message}\n`); return 1 }
    throw error
  }
}
process.exitCode = main()
