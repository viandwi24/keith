import { StepUpController, type StepUpPrompt } from '@keith/app-model'
import type { KeithClient } from '@keith/client'
import { useMemo, useSyncExternalStore } from 'react'

export type { StepUpMethod, StepUpPrompt } from '@keith/app-model'

export interface StepUp {
  /** The prompt, or `undefined` while none is open. */
  prompt: StepUpPrompt | undefined
  /** Epoch ms until which this session is stepped up (known only after a step-up in this run). */
  elevatedUntil: number | undefined
  /**
   * Run `act`; when the core refuses it with `KEITH_STEP_UP_REQUIRED`, ask for the PIN and run it
   * once more. Rejects with `StepUpCancelled` when the prompt is dismissed.
   */
  guard<T>(act: () => Promise<T>): Promise<T>
  /** Open the prompt with nothing to retry (`/stepup`). Resolves once stepped up. */
  elevate(): Promise<void>
  submit(secret: string): void
  toggleMethod(): void
  cancel(): void
}

/** Step-up for the whole app: the shared `StepUpController` (app-model) read as React state. */
export function useStepUp(client: KeithClient): StepUp {
  const controller = useMemo(() => new StepUpController(client), [client])
  const { prompt, elevatedUntil } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  )
  return {
    prompt,
    elevatedUntil,
    guard: controller.guard,
    elevate: controller.elevate,
    submit: controller.submit,
    toggleMethod: controller.toggleMethod,
    cancel: controller.cancel,
  }
}
