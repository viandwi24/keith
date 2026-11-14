/**
 * The sign-ins of this process: a credential the person did not ask to remember lives here, in memory, and
 * nowhere else (ADR-0014 amendment of 2026-11-09). The login panel's store puts it in; the app takes it out
 * when it swaps to the signed-in connection (`signedInConnection`); signing out drops it. Nothing is written
 * to disk and the process's end ends the session on this side.
 */
const vault = new Map<string, string>()

const keyOf = (core: string): string => core.replace(/\/+$/, '')

export const rememberSession = (core: string, token: string): void => {
  vault.set(keyOf(core), token)
}
export const sessionTokenOf = (core: string): string | undefined => vault.get(keyOf(core))
export const forgetSession = (core: string): void => {
  vault.delete(keyOf(core))
}
