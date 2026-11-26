import { defineCheck } from 'orca/testing'
import { exampleScreen } from '../tests/fixtures.ts'

export default defineCheck({
  fresh: {},
  sample: { requests: { 'studyPanel.get': () => exampleScreen() } }
})
