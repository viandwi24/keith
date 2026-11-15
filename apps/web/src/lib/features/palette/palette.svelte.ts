import { goto } from '$app/navigation'
import { frontChat } from '../chat/index.ts'
import { notifications } from '../presence/index.ts'
import { appBase, loginUrl, session } from '../session/index.ts'
import { motion, rail, theme } from '../shell/index.ts'
import { stepUp } from '../stepup/index.ts'
import { toasts } from '../toasts/index.ts'
import type { PaletteAction } from './model.ts'

/** Run what a palette item stands for. The palette is already closed. */
export async function runAction(action: PaletteAction): Promise<void> {
  const base = appBase()
  switch (action.kind) {
    case 'goto':
      await goto(action.path === '/' ? `${base}/` : `${base}${action.path}`)
      return
    case 'new':
    case 'compact': {
      // the chat controller runs the slash form exactly as typed; the draft the person had is put back
      const ctl = frontChat.ctl
      if (ctl === undefined) return
      const keep = ctl.draft
      ctl.draft = `/${action.kind}`
      ctl.submit()
      ctl.draft = keep
      await goto(`${base}/chat`)
      return
    }
    case 'theme':
      theme.cycle()
      toasts.push(`theme: ${theme.mode}`, { level: 'info' })
      return
    case 'still-orb':
      motion.setStill(!motion.setting)
      return
    case 'notifications':
      await notifications.toggle()
      return
    case 'step-up':
      await stepUp.elevate()
      return
    case 'sign-out':
      await session.signOut()
      toasts.push('signed out', { level: 'info' })
      await goto(loginUrl(base, `${base}/`), { replaceState: true })
      return
  }
}

export const openPalette = (): void => {
  rail.paletteOpen = true
}
