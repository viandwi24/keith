import { type Command, defineCommand, printTable, stripControl, UsageError } from '@keith/cli'
import type { GuestPeek, GuestStatus } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'
import { askFirst, yesFlag } from './prompt-helpers.ts'

const PROXY_VALUES = ['none', 'cloudflare', 'x-forwarded-for'] as const

const when = (ms: number): string => new Date(ms).toISOString().slice(11, 16)
const usd = (n: number | null): string => (n === null ? 'no limit' : `${Number(n.toFixed(4))} USD`)

/** The lines `guests status` prints (pure, for the test). */
export function statusLines(s: GuestStatus): string[] {
  const { settings: c, model, budget } = s
  const state = s.killed ? 'KILLED (enable to lift)' : c.enabled ? 'on' : 'off'
  return [
    `guests: ${state}${s.blocked === null ? ', open for entry' : `, entry blocked: ${s.blocked}`}`,
    `model: ${model.ref === null ? '(none: pick one with `keith-core model set guest <connection:model>`)' : `${model.ref}${model.priced ? '' : ' (UNPRICED: refused)'}`}`,
    `sessions: ${s.active} open of ${c.maxConcurrent}; ${c.maxTurns} turns each; idle ${Math.round(c.idleMs / 60_000)} min, at most ${Math.round(c.absoluteMs / 60_000)} min`,
    `zones: ${c.zones.join(', ')}; port ${c.port}; ${c.sessionsPerIpPerWindow} starts per IP per 10 min`,
    `budget: today ${usd(budget.daily.spentUsd)} of ${usd(budget.daily.limitUsd)}; month ${usd(budget.monthly.spentUsd)} of ${usd(budget.monthly.limitUsd)}; per session ${usd(c.sessionUsd)}${
      budget.ownerRemaining === null
        ? ''
        : `; owner budget left ${Math.round(budget.ownerRemaining * 100)}%`
    }`,
  ]
}

/**
 * The lines `guests peek` prints (pure, for the test). A message's continuation lines are indented, so a visitor line
 * that starts with `keith:` cannot pose as a speaker; no line holds a control byte.
 */
export function peekLines(peek: GuestPeek): string[] {
  const out = [`session ${peek.id}: ${peek.turns} turn(s), ends ${when(peek.expiresAt)}`]
  if (peek.truncated) out.push('(older messages not shown)')
  for (const m of peek.messages) {
    const tools = m.tools === undefined ? '' : ` [${m.tools.join(', ')}]`
    const [first = '', ...rest] = m.text.split('\n')
    out.push(`${m.role === 'user' ? 'visitor' : 'keith'}${tools}: ${first}`)
    for (const line of rest) out.push(`  ${line}`)
  }
  return out
}

/** `keith-core guests ...`: anonymous visitors (docs/specs/guests.md), owner only, over the socket. */
export function guestsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'guests',
    summary: 'Guest mode: status, enable, disable, kill switch, live sessions (owner only)',
    subcommands: [
      defineCommand({
        name: 'status',
        summary: 'Whether guests are on, the model, caps, spending and sessions open',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          for (const line of statusLines(await client.rpc.admin.guests.get()))
            ctx.io.stdout.write(`${line}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'enable',
        summary: 'Turn guests on (needs a priced guest model); also lifts the kill switch',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const s = await client.rpc.admin.guests.set({ enabled: true })
          for (const line of statusLines(s)) ctx.io.stdout.write(`${line}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'disable',
        summary: 'Turn guests off and end every session',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const before = await client.rpc.admin.guests.get()
          await client.rpc.admin.guests.set({ enabled: false })
          ctx.io.stdout.write(`guests are off; ${before.active} session(s) ended\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'set',
        summary: 'Trusted reverse proxy of the guest listener (audited; owner, step-up)',
        flags: {
          'trusted-proxy': {
            type: 'string',
            placeholder: 'value',
            description: 'none, cloudflare or x-forwarded-for',
          },
          'proxy-addr': {
            type: 'string',
            multiple: true,
            placeholder: 'cidr',
            description: 'Address or CIDR of the proxy (repeat for each one)',
          },
        },
        run: async (ctx) => {
          const trusted = ctx.string('trusted-proxy')
          const addrs = ctx.values['proxy-addr']
          if (trusted === undefined && addrs === undefined)
            throw new UsageError('give --trusted-proxy and/or --proxy-addr')
          if (trusted !== undefined && !(PROXY_VALUES as readonly string[]).includes(trusted))
            throw new UsageError('--trusted-proxy must be none, cloudflare or x-forwarded-for')
          const proxyAddrs = Array.isArray(addrs)
            ? addrs.filter((v): v is string => typeof v === 'string')
            : undefined
          const { client } = await connectLocal(deps)
          const status = await client.rpc.admin.guests.set({
            ...(trusted === undefined
              ? {}
              : { trustedProxy: trusted as (typeof PROXY_VALUES)[number] }),
            ...(proxyAddrs === undefined ? {} : { proxyAddrs }),
          })
          const { trustedProxy, proxyAddrs: now } = status.settings
          ctx.io.stdout.write(
            `trusted proxy: ${trustedProxy}${now.length === 0 ? '' : ` (${now.join(', ')})`}\n`,
          )
          return 0
        },
      }),
      defineCommand({
        name: 'kill',
        summary: 'Kill switch: end every guest session now and refuse entry until `enable`',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const { ended } = await client.rpc.admin.guests.killswitch({ on: true })
          ctx.io.stdout.write(
            `kill switch on; ${ended} session(s) ended. \`guests enable\` lifts it\n`,
          )
          return 0
        },
      }),
      defineCommand({
        name: 'list',
        summary: 'Live guest sessions (random id, zone, IP hash, turns, cost; never text)',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const rows = await client.rpc.admin.guests.list()
          if (rows.length === 0) ctx.io.stdout.write('no guest sessions open\n')
          else
            printTable(
              ctx.io,
              rows.map((r) => [
                r.id,
                r.zone,
                r.ipHash,
                String(r.turns),
                usd(r.costUsd),
                when(r.startedAt),
                when(r.expiresAt),
              ]),
              { header: ['ID', 'ZONE', 'IP HASH', 'TURNS', 'COST', 'STARTED', 'ENDS (UTC)'] },
            )
          return 0
        },
      }),
      defineCommand({
        name: 'peek',
        summary:
          'Read the live transcript of one guest session (audited; the visitor is told an owner can watch)',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined)
            throw new UsageError('missing session id (see `keith-core guests list`)')
          const { client } = await connectLocal(deps)
          const peek = await client.rpc.admin.guests.peek({ id })
          for (const line of peekLines(peek)) ctx.io.stdout.write(`${line}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'end',
        summary: 'End one guest session',
        usage: '<id> [--yes]',
        positionals: true,
        flags: yesFlag,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined)
            throw new UsageError('missing session id (see `keith-core guests list`)')
          await askFirst(
            ctx.io,
            'guests end',
            `end guest session ${stripControl(id)}? The visitor is cut off at once.`,
            ctx.bool('yes'),
          )
          const { client } = await connectLocal(deps)
          await client.rpc.admin.guests.end({ id })
          ctx.io.stdout.write(`session ${id} ended\n`)
          return 0
        },
      }),
    ],
  })
}
