import type { KeithClient } from '@keith/client/browser'
import {
  isDeadEnd,
  isLegacyRefusal,
  isStepUpRequired,
  LEGACY_TEXT,
  StepUpCancelled,
  stepUpFailure,
} from './step-up-state.ts'

export type StepUpMethod = 'pin' | 'password'

export interface StepUpPrompt {
  method: StepUpMethod
  /** A failed attempt (danger row); the prompt stays open. */
  error: string | undefined
  /** The request is on its way to the core. */
  busy: boolean
  /** No secret can help (legacy token, no PIN set): only a close is offered. */
  deadEnd: boolean
}

export interface StepUpSnapshot {
  /** The prompt, or `undefined` while none is open. */
  prompt: StepUpPrompt | undefined
  /** Epoch ms until which this session is stepped up (known only after a step-up in this run). */
  elevatedUntil: number | undefined
}

interface Waiter {
  resolve(): void
  reject(error: unknown): void
}

/**
 * Step-up for a whole app, without a framework: one prompt at a time, several actions may wait on it.
 * `guard(act)` runs `act`; when the core refuses it with `KEITH_STEP_UP_REQUIRED` the prompt opens and
 * `act` runs once more after a successful step-up (a second refusal is the caller's error). Cancelling
 * rejects every waiter with `StepUpCancelled`. The TUI wraps it in a hook, the web in a rune class.
 */
export class StepUpController {
  private snapshot: StepUpSnapshot = { prompt: undefined, elevatedUntil: undefined }
  private readonly waiters: Waiter[] = []
  private readonly listeners = new Set<() => void>()

  /**
   * `preferMethod` picks the tab the prompt opens on; a session made with a PIN cannot step up with it, so a
   * client that knows the session's methods passes `password` for it. Absent opens on the PIN, as before.
   */
  constructor(
    private readonly client: Pick<KeithClient, 'stepUp'>,
    private readonly options: { preferMethod?: () => StepUpMethod } = {},
  ) {}

  /** The current state; a new object after every change (for `useSyncExternalStore` and runes alike). */
  getSnapshot = (): StepUpSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  guard = async <T>(act: () => Promise<T>): Promise<T> => {
    try {
      return await act()
    } catch (error) {
      if (!isStepUpRequired(error)) throw error
      await this.ask(isLegacyRefusal(error))
      return act()
    }
  }

  /** Open the prompt with nothing to retry. Resolves once stepped up. */
  elevate = (): Promise<void> => this.ask(false)

  submit = (secret: string): void => {
    const prompt = this.snapshot.prompt
    if (prompt === undefined || prompt.busy || secret === '') return
    const method = prompt.method
    this.setPrompt({ ...prompt, busy: true, error: undefined })
    const body = method === 'pin' ? { pin: secret } : { password: secret }
    this.client.stepUp(body).then(
      ({ elevatedUntil }) => {
        const done = this.waiters.splice(0)
        this.snapshot = { prompt: undefined, elevatedUntil }
        this.emit()
        for (const w of done) w.resolve()
      },
      (error: unknown) => {
        const current = this.snapshot.prompt
        if (current === undefined) return
        const reason = (error as { reason?: unknown }).reason
        this.setPrompt({
          ...current,
          // a PIN session cannot confirm with its PIN: say so and move to the password
          method: reason === 'pin_session' ? 'password' : current.method,
          busy: false,
          error: stepUpFailure(error),
          deadEnd: isDeadEnd(error),
        })
      },
    )
  }

  toggleMethod = (): void => {
    const p = this.snapshot.prompt
    if (p === undefined || p.busy || p.deadEnd) return
    this.setPrompt({ ...p, method: p.method === 'pin' ? 'password' : 'pin', error: undefined })
  }

  setMethod = (method: StepUpMethod): void => {
    const p = this.snapshot.prompt
    if (p === undefined || p.busy || p.deadEnd || p.method === method) return
    this.setPrompt({ ...p, method, error: undefined })
  }

  cancel = (): void => {
    const dropped = this.waiters.splice(0)
    this.snapshot = { ...this.snapshot, prompt: undefined }
    this.emit()
    for (const w of dropped) w.reject(new StepUpCancelled())
  }

  private ask(legacy: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      if (this.snapshot.prompt !== undefined) return
      this.setPrompt({
        method: this.options.preferMethod?.() ?? 'pin',
        error: legacy ? LEGACY_TEXT : undefined,
        busy: false,
        deadEnd: legacy,
      })
    })
  }

  private setPrompt(prompt: StepUpPrompt): void {
    this.snapshot = { ...this.snapshot, prompt }
    this.emit()
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }
}
