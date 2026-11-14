/**
 * P25.3.3 step of the smoke test (docs/plans/active/P25-delivery-service.md, phase 3): a reminder for the owner a few
 * seconds ahead fires once through the delivery service. The owner's front session holds exactly one `reminder`
 * event message (the `eh.event` data part), and `keith-core doctor` shows no pending delivery row.
 *
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. The reminder text is built at runtime.
 * The scheduler ticks every 15 s, so the fire can take up to one tick after the due time.
 */
import { until } from './proc.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface DeliveryContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  coreUrl: string
  output(): string
}

interface Part {
  type?: string
  data?: { name?: string; data?: { reminder?: unknown } }
}

export async function deliverySteps(c: DeliveryContext): Promise<void> {
  await c.step(
    'delivery: a reminder for the owner fires once into the front session; doctor shows no pending row',
    async () => {
      const cred = /(keith_s_\S+)/.exec(
        await c.ok(c.admin('token', 'create', '--label', 'delivery'), 'token create'),
      )?.[1]
      assert(cred !== undefined, 'no owner credential')
      const headers = { authorization: `Bearer ${cred}`, 'content-type': 'application/json' }
      const at = new Date(Date.now() + 2_000).toISOString()
      const made = await fetch(`${c.coreUrl}/plugins/reminders/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: `delivery-${crypto.randomUUID()}`, at }),
      })
      const madeBody = await made.text()
      assert(made.status === 200, `reminders/create answered ${made.status} ${madeBody}`)
      const id = (JSON.parse(madeBody) as { id: string }).id

      await until(
        async () =>
          (await c.admin('audit', '--limit', '300')).out
            .split('\n')
            .some((l) => l.includes('plugin.reminders.fired') && l.includes(id)),
        25_000,
        'the owner reminder to fire',
        c.output,
      )

      const page = (await (
        await fetch(
          `${c.coreUrl}/sessions/${encodeURIComponent('front:owner')}/messages?limit=200`,
          {
            headers,
          },
        )
      ).json()) as { messages: Array<{ parts?: Part[] }> }
      const events = page.messages
        .flatMap((m) => m.parts ?? [])
        .filter(
          (p) =>
            p.type === 'data-eh.event' &&
            p.data?.name === 'reminder' &&
            p.data.data?.reminder === id,
        )
      assert(
        events.length === 1,
        `the front session holds ${events.length} reminder events, expected 1`,
      )

      // doctor exits non-zero on warnings: its exit code is not the assertion, the delivery line is
      const doctor = (await c.admin('doctor', '--offline')).out
      assert(doctor.includes('database'), `doctor printed no checks:\n${doctor}`)
      assert(
        !doctor.includes('pending delivery'),
        `doctor warns about a pending delivery:\n${doctor}`,
      )
    },
  )
}
