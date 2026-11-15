import { goto } from '$app/navigation'
import { appBase, getClient, session } from '../session/index.ts'
import { ChatController } from './chat.svelte.ts'

/**
 * The person's front chat, one controller for the whole app: the chat page, Home's quick ask and the orb all read it, so a turn that
 * runs while the person is on another page is still known (the orb thinks, the inspector shows it).
 */
class FrontChat {
  ctl = $state.raw<ChatController | undefined>(undefined)

  start(): void {
    const me = session.me
    if (this.ctl !== undefined || me === undefined) return
    const base = appBase()
    const ctl = new ChatController({
      client: getClient(),
      personId: me.personId,
      navigate: (path) => void goto(`${base}${path}`),
      whoami: () => [
        `${me.name}${me.username ? ` (${me.username})` : ''} · ${me.role}`,
        `connected ${me.via === 'tcp' ? 'over the network' : 'locally'}${me.elevated ? ' · elevated' : ''}`,
      ],
    })
    this.ctl = ctl
    ctl.start()
  }

  stop(): void {
    this.ctl?.stop()
    this.ctl = undefined
  }
}

export const frontChat = new FrontChat()
