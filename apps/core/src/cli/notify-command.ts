// `keith-core notify <username> <text…>`: the owner's test notice through the real delivery path (docs/specs/core-cli.md). A
// TUI that declared `notify` shows it as a toast; when no client takes it, the front session stores it as a note (no turn).
// Owner only (`admin.notice.send`, audited as `delivery.test_notice` without the text).
import { type Command, defineCommand, UsageError } from '@keith/cli'
import { type AdminNoticeSent, NOTICE_TEXT_MAX } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** The username and the text of the command line; the text is every word after the username, joined with spaces. */
export function noticeInput(positionals: readonly string[]): { person: string; text: string } {
  const [person, ...words] = positionals
  if (person === undefined || person === '')
    throw new UsageError('missing username (keith-core notify <username> <text>)')
  const text = words.join(' ').trim()
  if (text === '') throw new UsageError('missing text (keith-core notify <username> <text>)')
  if (text.length > NOTICE_TEXT_MAX)
    throw new UsageError(`text is longer than ${NOTICE_TEXT_MAX} characters`)
  return { person, text }
}

/** The one line that says where the notice went: a client (its id), the front session, or why it did not arrive. */
export function noticeLines(sent: AdminNoticeSent, person: string): string[] {
  const { outcome } = sent
  if (outcome.status === 'delivered') {
    const where = outcome.route.startsWith('client:')
      ? `client ${outcome.route.slice('client:'.length)} (toast)`
      : 'the front session (no client took it; stored as a note)'
    return [`delivered to ${person} on ${where}`]
  }
  if (outcome.status === 'queued')
    return [
      `queued for ${person}: no route now, the core retries at ${when(outcome.nextAttemptAt)}`,
    ]
  return [`not delivered to ${person}: ${outcome.reason}`]
}

export function noticeCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'notify',
    summary: 'Send a test notice to a person through the real delivery path (owner only; audited)',
    usage: '<username> <text…>',
    positionals: true,
    run: async (ctx) => {
      const { person, text } = noticeInput(ctx.positionals)
      const { client } = await connectLocal(deps)
      const sent = await client.rpc.admin.notice.send({ person, text })
      for (const line of noticeLines(sent, person)) ctx.io.stdout.write(`${line}\n`)
      return 0
    },
  })
}
