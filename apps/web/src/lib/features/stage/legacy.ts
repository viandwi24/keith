// While the web is redesigned, the old screens (rail, top bar, tab bar, palette, inspector and every screen behind them) are switched
// off: their code stays in place as the backup, and the app layout sends any of their paths to the stage. Turn this on to get them back.
export const LEGACY_SCREENS = false

/** Whether `pathname` is the stage itself (`<base>` or `<base>/`). */
export const isStagePath = (base: string, pathname: string): boolean =>
  pathname === base || pathname === `${base}/`

/** Where the app layout sends `pathname`: nowhere (stay) or to the stage. */
export const legacyRedirect = (
  base: string,
  pathname: string,
  legacy = LEGACY_SCREENS,
): string | undefined => (legacy || isStagePath(base, pathname) ? undefined : `${base}/`)
