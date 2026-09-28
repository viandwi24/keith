/**
 * Phase 5: invite links. The owner's link is `<publicUrl>/#invite=<code>`, a URL fragment so the
 * code never reaches a server log (protocol.md, "Invite links"). The app reads it once at start,
 * shows the sign-up form, and removes it from the address bar once it is used.
 */

/** The page address, injected so tests don't touch the real `window.location`. */
export type AddressBar = {
  /** The fragment, `#` included (as `location.hash`), or `''`. */
  hash(): string
  /** Removes the fragment without a reload and without a new history entry. */
  clearHash(): void
}

/** The browser's address bar. */
export function browserAddressBar(): AddressBar {
  return {
    hash: () => window.location.hash,
    clearHash() {
      const { pathname, search } = window.location
      window.history.replaceState(window.history.state, '', `${pathname}${search}`)
    },
  }
}

/**
 * The invite in a fragment: `null` when the fragment is not an invite, otherwise the code (`''`
 * when the link carries none, which the app shows as an invalid link).
 */
export function inviteFromHash(hash: string): { code: string } | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(fragment)
  if (!params.has('invite')) return null
  return { code: (params.get('invite') ?? '').trim() }
}
