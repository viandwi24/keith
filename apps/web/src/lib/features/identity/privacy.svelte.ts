import { getClient } from '../session/index.ts'

/**
 * Whether this person has to be told how Keith treats their things (`admin.audit.notice.get`). Any failure (offline, an older core)
 * counts as seen: the notice never blocks a person from the app (same rule as the TUI).
 */
class PrivacyNotice {
  text = $state<string | undefined>(undefined)
  private asked = false

  async check(): Promise<void> {
    if (this.asked) return
    this.asked = true
    try {
      const notice = await getClient().rpc.admin.audit.notice.get()
      this.text = notice.seen ? undefined : notice.text
    } catch {
      this.text = undefined
    }
  }

  /** Recorded on the core once per person; a failure only means it shows again next time. */
  ack(): void {
    this.text = undefined
    getClient()
      .rpc.admin.audit.notice.ack()
      .catch(() => undefined)
  }

  reset(): void {
    this.asked = false
    this.text = undefined
  }
}

export const privacy = new PrivacyNotice()
