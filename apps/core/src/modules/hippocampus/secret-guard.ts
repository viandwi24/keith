import { definePlugin, type HarnessPlugin } from 'eharness'

/** Shown to the model (and logged) when a memory write is refused. */
export const SECRET_REFUSAL =
  'Refused: this memory content looks like a secret (token, API key, private key, or a long random string). Keith does not store secrets in memory. Say that it was not saved, and keep the secret out of the chat.'

const PATTERNS: RegExp[] = [
  /keith_[A-Za-z0-9_-]{6,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /\bsk-or-v1-[A-Za-z0-9_-]{6,}/i,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*-----/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
]
const LONG_RUN = /[A-Za-z0-9_\-+/=]{32,}/g

function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / text.length) * Math.log2(n / text.length)
  return h
}

/** A 32+ char run with lower, upper and digit characters and high entropy (not a file path). */
function highEntropy(text: string): boolean {
  for (const run of text.match(LONG_RUN) ?? []) {
    if (run.split('/').length > 3) continue // looks like a path
    if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/\d/.test(run)) continue
    if (entropy(run) >= 3.5) return true
  }
  return false
}

/** True when the text looks like a credential. Pure: used by the `tool.approve` hook. */
export function looksLikeSecret(text: string): boolean {
  return PATTERNS.some((p) => p.test(text)) || highEntropy(text)
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value !== null && typeof value === 'object')
    for (const v of Object.values(value)) strings(v, out)
  return out
}

const WRITE_TOOLS = new Set(['memory_create', 'memory_str_replace', 'memory_insert'])

/**
 * Refuses every memory write whose input looks like a secret. Decides from the input only
 * (`tool.approve` is re-run on re-validation).
 */
export function secretGuard(): HarnessPlugin {
  return definePlugin({
    name: 'keith-memory-secret-guard',
    setup: () => ({
      hooks: {
        'tool.approve': (_ctx, e) => {
          if (!WRITE_TOOLS.has(e.toolName)) return
          if (strings(e.input).some(looksLikeSecret))
            return { type: 'denied', reason: SECRET_REFUSAL }
        },
      },
    }),
  })
}
