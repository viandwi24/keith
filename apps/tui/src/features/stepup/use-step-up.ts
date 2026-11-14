import type { KeithClient } from '@keith/client'
import { useCallback, useRef, useState } from 'react'
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
  /** No secret can help (legacy token, no PIN set): only esc is offered. */
  deadEnd: boolean
}

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

interface Waiter {
  resolve(): void
  reject(error: unknown): void
}

/**
 * Step-up for the whole app: one prompt at a time, several actions may wait on it. The retry is
 * the caller's `act` run again once; a second refusal is the caller's error.
 */
export function useStepUp(client: KeithClient): StepUp {
  const [prompt, setPrompt] = useState<StepUpPrompt | undefined>()
  const [elevatedUntil, setElevatedUntil] = useState<number | undefined>()
  const waiters = useRef<Waiter[]>([])
  const open = useRef(false)

  const close = useCallback(() => {
    open.current = false
    setPrompt(undefined)
  }, [])

  const ask = useCallback((legacy: boolean): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      waiters.current.push({ resolve, reject })
      if (open.current) return
      open.current = true
      setPrompt({
        method: 'pin',
        error: legacy ? LEGACY_TEXT : undefined,
        busy: false,
        deadEnd: legacy,
      })
    })
  }, [])

  const guard = useCallback(
    async <T>(act: () => Promise<T>): Promise<T> => {
      try {
        return await act()
      } catch (error) {
        if (!isStepUpRequired(error)) throw error
        await ask(isLegacyRefusal(error))
        return act()
      }
    },
    [ask],
  )

  const methodRef = useRef<StepUpMethod>('pin')
  methodRef.current = prompt?.method ?? 'pin'

  const submit = useCallback(
    (secret: string) => {
      if (!open.current || secret === '') return
      setPrompt((p) => (p === undefined ? p : { ...p, busy: true, error: undefined }))
      const body = methodRef.current === 'pin' ? { pin: secret } : { password: secret }
      client.stepUp(body).then(
        ({ elevatedUntil: until }) => {
          setElevatedUntil(until)
          const done = waiters.current.splice(0)
          close()
          for (const w of done) w.resolve()
        },
        (error: unknown) =>
          setPrompt((p) =>
            p === undefined
              ? p
              : { ...p, busy: false, error: stepUpFailure(error), deadEnd: isDeadEnd(error) },
          ),
      )
    },
    [client, close],
  )

  const toggleMethod = useCallback(
    () =>
      setPrompt((p) =>
        p === undefined || p.busy || p.deadEnd
          ? p
          : { ...p, method: p.method === 'pin' ? 'password' : 'pin', error: undefined },
      ),
    [],
  )

  const cancel = useCallback(() => {
    const dropped = waiters.current.splice(0)
    close()
    for (const w of dropped) w.reject(new StepUpCancelled())
  }, [close])

  const elevate = useCallback(() => ask(false), [ask])

  return { prompt, elevatedUntil, guard, elevate, submit, toggleMethod, cancel }
}
