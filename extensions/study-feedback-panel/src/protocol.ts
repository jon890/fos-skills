import type { Choice } from './choices.ts'
import type { ChoiceResult, Screen } from './state.ts'

declare module 'orca' {
  interface PluginRequests {
    'studyPanel.get': { output: Screen }
    'studyPanel.choose': { input: Choice; output: ChoiceResult }
  }
  interface PluginPanelEvents {
    'studyPanel.changed': Screen
  }
}
