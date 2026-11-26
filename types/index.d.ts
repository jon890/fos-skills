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
      /** /board 창의 시작 폴더. Claude 를 띄운 폴더로 한 번 정한다 */
      'board-start': string
    }
  }
}
