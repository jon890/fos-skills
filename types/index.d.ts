export type BoardSchedule = {
  id: string
  cron: string
  prompt: string
  schedule: string
  recurring: boolean
  next: number
  offset: number
  expires: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'fos-skills': {
      'board-schedules': BoardSchedule[]
    }
  }
}
