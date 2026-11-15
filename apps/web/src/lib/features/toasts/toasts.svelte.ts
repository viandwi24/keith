import { TOAST_MS, type Toast, type ToastLevel, withoutToast, withToast } from './toasts.ts'

class Toasts {
  items = $state<Toast[]>([])
  private next = 1
  private timers = new Map<number, ReturnType<typeof setTimeout>>()

  /** Show a short message; returns its id for `dismiss`. */
  push(
    text: string,
    options: { level?: ToastLevel; ms?: number; link?: Toast['link'] } = {},
  ): number {
    const id = this.next++
    const ms = options.ms ?? TOAST_MS
    const before = this.items
    this.items = withToast(before, {
      id,
      text,
      level: options.level ?? 'info',
      ms,
      ...(options.link === undefined ? {} : { link: options.link }),
    })
    for (const gone of before) {
      if (!this.items.some((t) => t.id === gone.id)) this.clear(gone.id)
    }
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), ms),
    )
    return id
  }

  dismiss(id: number): void {
    this.clear(id)
    this.items = withoutToast(this.items, id)
  }

  private clear(id: number): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(id)
  }
}

export const toasts = new Toasts()
