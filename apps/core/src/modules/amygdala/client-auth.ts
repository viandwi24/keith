// Whether the client a person last wrote from had stepped up (docs/specs/permissions.md "Step-up matrix"): the consent hook reads
// it to decide whether a step-up tool (persona, model switch) may run on the person's word alone. In memory; a person never seen
// since the start is unknown, which counts as not stepped up.
export interface ClientAuth {
  /** Records the client of the person's newest chat message. */
  note(personId: string, elevated: boolean): void
  /** `undefined` when no message of the person was seen since the start. */
  elevatedOf(personId: string): boolean | undefined
}

export function createClientAuth(max = 1000): ClientAuth {
  const seen = new Map<string, boolean>()
  return {
    note(personId, elevated) {
      seen.delete(personId)
      seen.set(personId, elevated)
      if (seen.size > max) seen.delete(seen.keys().next().value as string)
    },
    elevatedOf: (personId) => seen.get(personId),
  }
}
