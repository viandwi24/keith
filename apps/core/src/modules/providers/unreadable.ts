/**
 * Stored provider keys that the secret key cannot open (lost or changed `KEITH_SECRET_KEY`,
 * restored data folder). The sealed store skips such a row (`onUnreadable`) instead of failing
 * the whole start; this tracker logs it, writes one audit row and remembers the id so the provider
 * list and `doctor` can say "key needs re-entry". Only ids are kept: never a value.
 */
export interface UnreadableKeys {
  /** Pass to `sealedProfileStore({ onUnreadable })`. */
  onUnreadable(row: { kind: string; id: string; error: unknown }): void
  /** Ids of the unreadable provider connections. */
  ids(): string[]
  /** The owner re-entered or removed this connection. */
  forget(id: string): void
}

export function createUnreadableKeys(options: {
  warn?: (message: string) => void
  /** One audit row per newly found key (`settings.unreadable`, detail `{ keys }`). */
  record?: (keys: string[]) => void
}): UnreadableKeys {
  const seen = new Set<string>()
  const other = new Set<string>()
  return {
    onUnreadable(row) {
      const key = `${row.kind}:${row.id}`
      if (row.kind !== 'provider') {
        if (other.has(key)) return
        other.add(key)
        options.warn?.(
          `stored ${row.kind} "${row.id}" cannot be opened with the secret key: skipped`,
        )
        options.record?.([key])
        return
      }
      if (seen.has(row.id)) return
      seen.add(row.id)
      options.warn?.(
        `provider "${row.id}": the stored key cannot be opened with this secret key (lost or changed KEITH_SECRET_KEY); re-enter it with keith-core provider add`,
      )
      options.record?.([key])
    },
    ids: () => [...seen],
    forget: (id) => void seen.delete(id),
  }
}
