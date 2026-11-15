/** A step-up the person dismissed: not a failure, the screens say "Not confirmed." as info (the TUI's word). */
export const isStepUpCancelled = (error: unknown): boolean =>
  error instanceof Error && error.name === 'StepUpCancelled'
