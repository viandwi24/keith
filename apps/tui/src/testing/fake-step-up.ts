import type { FakeStepUp } from './fake-core-types.ts'

type Body = { pin?: string; password?: string }

/** The step-up half of the fake core: which calls it refuses until a step-up, and `/auth/step-up`. */
export function createStepUp(options: FakeStepUp = {}) {
  let elevated = false
  const requests: Body[] = []
  return {
    requests,
    /** A refusal in the shape of an oRPC error (`rpc`) or an HTTP one, while a step-up is due. */
    refuse(rpc: boolean): Response | undefined {
      if (options.required !== true || elevated) return undefined
      const message =
        options.fail === 'legacy'
          ? 'a legacy token cannot step up: replace it with `keith-core token create`'
          : 'confirm with your PIN or password first (step-up)'
      return rpc
        ? Response.json(
            { json: { defined: false, code: 'KEITH_STEP_UP_REQUIRED', status: 403, message } },
            { status: 403 },
          )
        : Response.json({ error: { code: 'KEITH_STEP_UP_REQUIRED', message } }, { status: 403 })
    },
    handle(body: Body): Response {
      requests.push(body)
      if (options.fail === 'throttled')
        return Response.json(
          { error: 'throttled', retryAfter: 42 },
          { status: 429, headers: { 'retry-after': '42' } },
        )
      if (options.fail === 'no_method')
        return Response.json(
          { error: 'no_step_up_method', hint: 'keith-core people pin ana' },
          { status: 403 },
        )
      if (options.fail === 'legacy')
        return Response.json({ error: 'legacy_credential' }, { status: 409 })
      const ok =
        body.pin !== undefined
          ? body.pin === (options.pin ?? '1234')
          : options.password !== undefined && body.password === options.password
      if (!ok) return Response.json({ error: 'invalid' }, { status: 401 })
      elevated = true
      return Response.json({ elevatedUntil: Date.now() + 600_000 })
    },
  }
}
