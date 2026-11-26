export const ANSWERS = {
  choose_study_candidate: ['write', 'later', 'drop'],
  choose_feedback_bundle: ['apply', 'hold', 'reject']
} as const
export type Action = keyof typeof ANSWERS
export type Answer = typeof ANSWERS[Action][number]
export type Choice = { item: string; revision: number; action: Action; answer: Answer; reason?: string }

export const needsReason = (answer: Answer) => answer === 'drop' || answer === 'hold' || answer === 'reject'
export const validReason = (reason: string) => Boolean(reason.trim()) && !/[\r\n\u0085\u2028\u2029]/.test(reason.trim())
