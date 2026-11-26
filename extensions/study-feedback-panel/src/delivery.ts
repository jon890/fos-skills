import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Choice } from './choices.ts'

export type DeliverySettings = { botHome: string; automationId: string; executable: string }
export type DeliveryError = 'queue_write_failed' | 'wake_failed'
const run = promisify(execFile)

export async function deliver(
  settings: DeliverySettings, choice: Choice, round: number, at: number
): Promise<{ sentAt: string } | { error: DeliveryError }> {
  const queue = join(settings.botHome, 'inbox-study-panel')
  const staging = join(queue, '.staging')
  const sentAt = new Date(at).toISOString()
  const requestId = randomUUID()
  const filename = sentAt.replace(/[:.]/g, '-') + '-' + requestId + '.json'
  const prepared = join(staging, filename)
  const message = { ...choice, round, sentAt, requestId }
  let error: DeliveryError = 'queue_write_failed'
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 })
    await writeFile(prepared, JSON.stringify(message) + '\n', { mode: 0o600, flag: 'wx' })
    error = 'wake_failed'
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')))
    const { stdout } = await run(settings.executable, ['automations', 'run', settings.automationId, '--json'], {
      env, timeout: 30_000, killSignal: 'SIGKILL'
    })
    if (JSON.parse(stdout)?.ok !== true) return { error }
    error = 'queue_write_failed'
    await rename(prepared, join(queue, filename))
    return { sentAt }
  } catch {
    return { error }
  } finally {
    // If cleanup itself fails, the preparation directory is still invisible to the consumer.
    await unlink(prepared).catch(() => {})
  }
}
