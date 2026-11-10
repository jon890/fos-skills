import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BOARD = fileURLToPath(new URL('../bin/board.ts', import.meta.url))
export type Result = { code: number | null; stdout: string; stderr: string }
export function tempBoard(): { dir: string; file: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'board-test-'))
  return { dir, file: join(dir, 'board.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
export function run(file: string, args: string[], env: Record<string, string> = {}): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BOARD, ...args, '--file', file], { encoding: 'utf8', env: { ...process.env, ...env } })
  if (done.error) throw done.error
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}
export function runAsync(file: string, args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BOARD, ...args, '--file', file], { env: { ...process.env, ...env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
export function write(file: string, ...items: Record<string, unknown>[]): void { writeFileSync(file, JSON.stringify({ items })) }
export function item(file: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')).items.find((row: Record<string, unknown>) => row.id === id)
}
