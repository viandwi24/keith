import {
  browserNameOf,
  createPresenceReporter,
  detectBrowserEnvironment,
  localStorageClientIdStore,
  type PresenceReporter,
  UnsupportedDelivery,
  WEB_CAPABILITIES,
} from '@keith/client/browser'
import { type ClientView, parseWorkspaceShowName } from '@keith/contracts'
import { goto } from '$app/navigation'
import { appBase, getClient } from '../session/index.ts'
import { toasts } from '../toasts/index.ts'
import { workspace } from '../workspace/index.ts'
import { electLeader } from './leader.ts'
import { notifications } from './notifications.svelte.ts'
import { decideNotify, shouldTouch, viewPath } from './notify-decision.ts'

const WEB_VERSION = '0.1.0'
const TOUCH_CHANNEL = 'keith.presence.touch'
const TOUCH_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

/** The person is typing in a field with text, or does not see the tab: Keith's `workspace.show` waits as a chip. */
function isBusy(): boolean {
  if (document.hidden) return true
  const active = document.activeElement
  return (
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
    active.value.trim() !== ''
  )
}

/**
 * Presence kind `web`: this browser is one of the person's clients. Only one tab reports (the election in `leader.ts`); it
 * registers, heartbeats, marks input as `touch`, takes `notify` (a toast, plus a system notification when the tab is hidden and
 * the person opted in) and `open.view` (a route), and says goodbye when the page goes away.
 */
class PresenceState {
  /** This tab is the one that reports. */
  leading = $state(false)
  private reporter: PresenceReporter | undefined
  private leave: (() => void) | undefined
  private lastTouch = 0
  private viewReader: (() => ClientView | undefined) | undefined

  /** What the heartbeat reports as this tab's workspace view (ADR-0037 §4); the app layout wires it to the workspace. */
  setView(read: () => ClientView | undefined): void {
    this.viewReader = read
  }

  /** The view changed (the person or Keith switched between the orb, a desktop and the overview): tell the core now, not at the next beat. */
  reportView(): void {
    this.reporter?.reportNow()
  }

  start(): void {
    if (this.leave !== undefined) return
    const stopElection = electLeader({ onLead: () => this.lead(), onFollow: () => this.follow() })
    // input in any tab counts: a tab that does not report tells the one that does
    const channel =
      typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(TOUCH_CHANNEL)
    if (channel !== undefined) channel.onmessage = () => this.reporter?.touch()
    const touch = (): void => {
      const now = Date.now()
      if (!shouldTouch(this.lastTouch, now)) return
      this.lastTouch = now
      if (this.reporter !== undefined) this.reporter.touch()
      else channel?.postMessage('touch')
    }
    // the page is going away (a close, a reload, the back-forward cache): say goodbye now, with a keepalive request
    const onHide = (): void => this.follow()
    // back from the back-forward cache: take part again
    const onShow = (event: PageTransitionEvent): void => {
      if (event.persisted) this.restart()
    }
    for (const type of TOUCH_EVENTS) window.addEventListener(type, touch, { passive: true })
    window.addEventListener('pagehide', onHide)
    window.addEventListener('pageshow', onShow)
    this.leave = () => {
      for (const type of TOUCH_EVENTS) window.removeEventListener(type, touch)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('pageshow', onShow)
      stopElection()
      channel?.close()
    }
  }

  stop(): void {
    const leave = this.leave
    this.leave = undefined
    leave?.()
    this.follow()
  }

  private restart(): void {
    const leave = this.leave
    this.leave = undefined
    leave?.()
    this.start()
  }

  private lead(): void {
    if (this.reporter !== undefined) return
    const browser = browserNameOf(globalThis.navigator)
    const reporter = createPresenceReporter(getClient(), {
      kind: 'web',
      label: (browser === undefined ? 'web browser' : `${browser} (web)`).slice(0, 40),
      capabilities: [...WEB_CAPABILITIES],
      version: WEB_VERSION,
      store: localStorageClientIdStore(),
      environment: () => detectBrowserEnvironment(),
      view: () => this.viewReader?.(),
    })
    reporter.onNotify((delivery) => {
      const decision = decideNotify({
        text: delivery.text,
        name: delivery.name,
        hidden: document.hidden,
        permission: notifications.permission,
        optedIn: notifications.optedIn,
      })
      toasts.push(decision.toast, { level: 'info' })
      if (decision.system !== undefined) {
        try {
          const shown = new Notification(decision.system.title, {
            body: decision.system.body,
            tag: delivery.deliveryId,
          })
          shown.onclick = () => {
            window.focus()
            shown.close()
          }
        } catch {
          // the toast stands in for it
        }
      }
      return undefined
    })
    reporter.onDeliver('open.view', async (delivery) => {
      const path = viewPath(delivery.name)
      if (path === undefined) throw new UnsupportedDelivery()
      // a plugin view the person may not open (not in their menu) is as unknown as a name nobody has
      if (path.startsWith('/apps/')) {
        const viewId = path.slice('/apps/'.length).replace('/', '.')
        const menu = await getClient()
          .viewMenu()
          .catch(() => undefined)
        if (menu?.items.some((i) => i.viewId === viewId) !== true) throw new UnsupportedDelivery()
      }
      void goto(`${appBase()}${path}`)
      return undefined
    })
    // Keith asks this screen to show a desktop, a window or the overview: held as a dock chip while the person types or the tab
    // is hidden (ADR-0037 §6); a target this tab does not have is unsupported
    reporter.onDeliver('workspace.show', async (delivery) => {
      const target = parseWorkspaceShowName(delivery.name)
      if (target === undefined) throw new UnsupportedDelivery()
      // Keith may have just added the desktop: read the workspace again before calling it unknown
      if ('desktopId' in target && !workspace.has(target.desktopId)) await workspace.sync()
      if ('desktopId' in target && !workspace.has(target.desktopId)) throw new UnsupportedDelivery()
      return workspace.deliverShow(target, isBusy())
    })
    this.reporter = reporter
    this.leading = true
    reporter.start()
  }

  private follow(): void {
    const reporter = this.reporter
    this.reporter = undefined
    this.leading = false
    void reporter?.stop()
  }
}

export const presence = new PresenceState()
