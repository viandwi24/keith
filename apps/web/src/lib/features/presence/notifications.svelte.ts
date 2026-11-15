import { toasts } from '../toasts/index.ts'
import {
  canToggle,
  type NotifyPermission,
  notificationsLabel,
  readOptIn,
  writeOptIn,
} from './notify-decision.ts'

const permissionNow = (): NotifyPermission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

/** The person's choice about desktop notifications. The browser is asked only when the person clicks the toggle. */
class Notifications {
  optedIn = $state(readOptIn())
  permission = $state<NotifyPermission>(permissionNow())
  label = $derived(notificationsLabel(this.optedIn, this.permission))
  enabled = $derived(canToggle(this.permission))

  /** On: ask the browser (this click is the gesture it wants); off: just stop. */
  async toggle(): Promise<void> {
    if (this.optedIn) return this.set(false)
    if (this.permission === 'default') {
      try {
        this.permission = (await Notification.requestPermission()) as NotifyPermission
      } catch {
        this.permission = permissionNow()
      }
    }
    if (this.permission === 'granted') {
      this.set(true)
      toasts.push('desktop notifications on', { level: 'success' })
    } else {
      toasts.push(
        this.permission === 'unsupported'
          ? 'This browser has no desktop notifications.'
          : 'Desktop notifications are blocked: allow them in the browser settings.',
        { level: 'warning' },
      )
    }
  }

  private set(on: boolean): void {
    this.optedIn = on
    writeOptIn(on)
  }
}

export const notifications = new Notifications()
