import {
  applicationServerKeyOf,
  browserNameOf,
  listPush,
  localStorageClientIdStore,
  pushPublicKey,
  subscribePush,
  unsubscribePush,
} from '@keith/client/browser'
import type { PushRecord } from '@keith/contracts'
import { appBase, getClient } from '../session/index.ts'
import { toasts } from '../toasts/index.ts'
import {
  availabilityOf,
  type DeviceRow,
  deviceRowsOf,
  failureText,
  type PushAvailability,
  type PushPermission,
  type PushPlatform,
  toggleStep,
} from './push-model.ts'
import { registerServiceWorker } from './register.ts'

const platformNow = (): PushPlatform => {
  const nav = globalThis.navigator as Navigator & { standalone?: boolean }
  const ios =
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  const standalone =
    nav.standalone === true ||
    globalThis.matchMedia?.('(display-mode: standalone)').matches === true
  return {
    secureContext: globalThis.isSecureContext === true,
    serviceWorker: 'serviceWorker' in nav,
    pushManager: 'PushManager' in globalThis,
    notification: typeof Notification !== 'undefined',
    ios,
    standalone,
    permission:
      typeof Notification === 'undefined' ? 'default' : (Notification.permission as PushPermission),
  }
}

/**
 * Web Push of this browser (docs/specs/web.md, "Push"): the toggle, the person's devices and the preview switch. The page asks
 * for permission only on a click (`enable`), registers the worker, subscribes with the core's VAPID key and tells the core.
 */
class DevicePush {
  availability = $state<PushAvailability>('unsupported')
  subscribed = $state(false)
  busy = $state(false)
  records = $state<PushRecord[]>([])
  preview = $state(false)
  loaded = $state(false)
  error = $state<string | undefined>()
  now = $state(Date.now())

  rows = $derived<DeviceRow[]>(
    deviceRowsOf(this.records, localStorageClientIdStore().read(), this.now),
  )

  /** Read what this browser holds and what the core knows. Safe to call again. */
  async init(): Promise<void> {
    this.availability = availabilityOf(platformNow())
    this.subscribed = (await this.subscription()) !== undefined
    await this.refresh()
  }

  async refresh(): Promise<void> {
    this.now = Date.now()
    try {
      const client = getClient()
      const [records, preview] = await Promise.all([
        listPush(client),
        client.rpc.presence.push.preview.get(),
      ])
      this.records = records
      this.preview = preview.preview
      this.error = undefined
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.loaded = true
    }
  }

  async toggle(): Promise<void> {
    const step = toggleStep({
      availability: this.availability,
      subscribed: this.subscribed,
      busy: this.busy,
    })
    if (step === 'subscribe') await this.enable()
    else if (step === 'unsubscribe') await this.disable()
  }

  /** Must run in the click: the permission prompt wants the gesture, so nothing awaits before it. */
  private async enable(): Promise<void> {
    this.busy = true
    try {
      const permission = (await Notification.requestPermission()) as PushPermission
      this.availability = availabilityOf(platformNow())
      if (permission !== 'granted') {
        toasts.push(
          permission === 'denied'
            ? 'Notifications are blocked: allow them in the browser settings.'
            : 'Notifications were not allowed.',
          { level: 'warning' },
        )
        return
      }
      const registration = await registerServiceWorker()
      if (registration === undefined) throw new Error('the service worker is not available here')
      await navigator.serviceWorker.ready
      const key = applicationServerKeyOf(await pushPublicKey(getClient()))
      const options = { userVisibleOnly: true, applicationServerKey: key }
      let subscription: PushSubscription
      try {
        subscription = await registration.pushManager.subscribe(options)
      } catch (e) {
        // a subscription made with another key (the core's key changed) blocks a new one: drop it and subscribe again
        if (!(e instanceof Error) || e.name !== 'InvalidStateError') throw e
        await (await registration.pushManager.getSubscription())?.unsubscribe()
        subscription = await registration.pushManager.subscribe(options)
      }
      try {
        const browser = browserNameOf(navigator)
        const clientId = localStorageClientIdStore().read()
        await subscribePush(
          getClient(),
          subscription,
          browser === undefined ? 'web browser' : `${browser} (web)`,
          {
            ...(clientId === undefined ? {} : { clientId }),
            userAgent: navigator.userAgent,
          },
        )
      } catch (e) {
        // the core did not take it: do not leave a subscription it does not know
        await subscription.unsubscribe().catch(() => undefined)
        throw e
      }
      this.subscribed = true
      toasts.push('notifications on for this device', { level: 'success' })
      await this.refresh()
    } catch (e) {
      toasts.push(failureText(e), { level: 'error' })
    } finally {
      this.busy = false
    }
  }

  private async disable(): Promise<void> {
    this.busy = true
    try {
      const subscription = await this.subscription()
      if (subscription !== undefined) {
        await unsubscribePush(getClient(), { endpoint: subscription.endpoint })
        await subscription.unsubscribe()
      }
      this.subscribed = false
      toasts.push('notifications off for this device', { level: 'info' })
      await this.refresh()
    } catch (e) {
      toasts.push(`Failed to turn off: ${e instanceof Error ? e.message : String(e)}`, {
        level: 'error',
      })
    } finally {
      this.busy = false
    }
  }

  /** Remove one of the person's devices; when it is this browser, its subscription goes too. */
  async remove(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    try {
      await unsubscribePush(getClient(), { id })
      if (row?.here === true) {
        await (await this.subscription())?.unsubscribe()
        this.subscribed = false
      }
      await this.refresh()
    } catch (e) {
      toasts.push(`Failed to remove: ${e instanceof Error ? e.message : String(e)}`, {
        level: 'error',
      })
    }
  }

  async setPreview(on: boolean): Promise<void> {
    try {
      const saved = await getClient().rpc.presence.push.preview.set({ preview: on })
      this.preview = saved.preview
    } catch (e) {
      toasts.push(`Failed to change: ${e instanceof Error ? e.message : String(e)}`, {
        level: 'error',
      })
    }
  }

  private async subscription(): Promise<PushSubscription | undefined> {
    if (!('serviceWorker' in navigator)) return undefined
    try {
      const registration = await navigator.serviceWorker.getRegistration(`${appBase()}/`)
      return (await registration?.pushManager.getSubscription()) ?? undefined
    } catch {
      return undefined
    }
  }
}

export const devicePush = new DevicePush()
