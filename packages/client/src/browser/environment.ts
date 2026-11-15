// The environment of a browser client (docs/specs/client.md, "Browser entry"): what the presence contract asks for and no
// more. The time zone and locale come from `Intl`; the OS and the browser from `navigator`. No fingerprinting: no canvas, no
// fonts, no screen size, no high-entropy client hints, no IP.
import {
  type ClientCapability,
  type ClientDevice,
  type ClientEnvironment,
  ClientEnvironmentSchema,
  type ClientOs,
} from '@keith/contracts'

/** What the web app declares on register: the same four as the terminal (chat, notice, a view it can open, Markdown). */
export const WEB_CAPABILITIES: readonly ClientCapability[] = [
  'chat',
  'notify',
  'open.view',
  'render.markdown',
]

/** The part of `navigator` that detection reads; tests pass a stub. */
export interface NavigatorLike {
  userAgent?: string
  platform?: string
  language?: string
  userAgentData?: {
    platform?: string
    mobile?: boolean
    brands?: ReadonlyArray<{ brand: string; version?: string }>
  }
}

export function browserOsOf(nav: NavigatorLike): ClientOs {
  const ua = nav.userAgent ?? ''
  const platform = nav.userAgentData?.platform ?? nav.platform ?? ''
  const text = `${platform} ${ua}`
  // phones and Chromebooks say Mac or Linux in their UA, but are not those systems
  if (/iPhone|iPad|iPod|Android|CrOS/i.test(text)) return 'other'
  if (/Win/i.test(text)) return 'windows'
  if (/Mac/i.test(text)) return 'macos'
  if (/Linux|X11/i.test(text)) return 'linux'
  return 'other'
}

export function browserNameOf(nav: NavigatorLike): string | undefined {
  const brands = nav.userAgentData?.brands ?? []
  const real = brands.filter((b) => !/not.?a.?brand/i.test(b.brand))
  const named = real.find((b) => !/chromium/i.test(b.brand)) ?? real[0]
  if (named !== undefined) return named.brand.replace(/^Microsoft /, '')
  const ua = nav.userAgent ?? ''
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return undefined
}

const deviceOf = (nav: NavigatorLike): ClientDevice => {
  // only a phone is told apart; a laptop and a desktop look the same to a page, and a guess is never made
  if (nav.userAgentData?.mobile === true) return 'phone'
  return /iPhone|iPod|Android.*Mobile/i.test(nav.userAgent ?? '') ? 'phone' : 'unknown'
}

/** The environment of this browser, or undefined when the time zone (required) cannot be read. Never throws. */
export async function detectBrowserEnvironment(
  nav: NavigatorLike | undefined = globalThis.navigator,
): Promise<ClientEnvironment | undefined> {
  try {
    const n = nav ?? {}
    const intl = Intl.DateTimeFormat().resolvedOptions()
    const browser = browserNameOf(n)
    const locale = (n.language ?? intl.locale ?? '').trim().slice(0, 20)
    const checked = ClientEnvironmentSchema.safeParse({
      host: browser === undefined ? 'web browser' : `${browser} browser`,
      os: browserOsOf(n),
      device: deviceOf(n),
      timezone: intl.timeZone,
      ...(locale === '' ? {} : { locale }),
    })
    return checked.success ? checked.data : undefined
  } catch {
    return undefined
  }
}
