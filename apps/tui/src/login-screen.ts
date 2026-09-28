import { PASSWORD_MIN_CHARS } from '@keith/protocol'
import {
  BoxRenderable,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  TextRenderable,
} from '@opentui/core'

/**
 * The login screen: username (an OpenTUI input), then password (captured key by key and shown
 * masked, since OpenTUI's input has no password mode). Resolves with the credentials, or null when
 * the user quits with Ctrl+C. With `signUp` (phase 5, `--invite`) it is the sign-up form: the
 * password is asked twice and must have `PASSWORD_MIN_CHARS` characters.
 */

export type Credentials = { username: string; password: string }

export type LoginPromptOptions = {
  url: string
  username?: string | undefined
  /** Shown above the form, e.g. the previous attempt's error. */
  message?: string | undefined
  /** Phase 5: sign up with an invite code (the password twice) instead of signing in. */
  signUp?: boolean | undefined
}

export const PASSWORD_TOO_SHORT = `The password needs at least ${PASSWORD_MIN_CHARS} characters.`
export const PASSWORDS_DIFFER = "The passwords don't match. Type them again."

type Stage = 'username' | 'password' | 'confirm'

export function promptLogin(renderer: CliRenderer, opts: LoginPromptOptions): Promise<Credentials | null> {
  return new Promise((resolve) => {
    const signUp = opts.signUp === true
    const form = new BoxRenderable(renderer, {
      id: 'login',
      flexDirection: 'column',
      border: true,
      title: signUp ? ' Keith: sign up with your invite ' : ' Keith: sign in ',
      padding: 1,
      width: 60,
    })
    const server = new TextRenderable(renderer, { content: `server   ${opts.url}`, fg: '#9aa0a6' })
    const message = new TextRenderable(renderer, { content: opts.message ?? '', fg: '#f28b82' })
    const userRow = new BoxRenderable(renderer, { flexDirection: 'row', height: 1 })
    const userLabel = new TextRenderable(renderer, { content: 'username ', width: 9 })
    const username = new InputRenderable(renderer, {
      id: 'login-username',
      value: opts.username ?? '',
      placeholder: signUp ? 'choose a username' : 'owner',
      flexGrow: 1,
    })
    username.on(InputRenderableEvents.ENTER, () => {
      if (username.value.trim().length > 0) setStage('password')
    })
    const passRow = new BoxRenderable(renderer, { flexDirection: 'row', height: 1 })
    const passLabel = new TextRenderable(renderer, { content: 'password ', width: 9 })
    const passField = new TextRenderable(renderer, { content: '', flexGrow: 1 })
    const confirmRow = new BoxRenderable(renderer, { flexDirection: 'row', height: 1 })
    const confirmLabel = new TextRenderable(renderer, { content: 'repeat   ', width: 9 })
    const confirmField = new TextRenderable(renderer, { content: '', flexGrow: 1 })
    const help = new TextRenderable(renderer, {
      content: 'Enter next · Esc back · Ctrl+C quit',
      fg: '#9aa0a6',
    })

    userRow.add(userLabel)
    userRow.add(username)
    passRow.add(passLabel)
    passRow.add(passField)
    confirmRow.add(confirmLabel)
    confirmRow.add(confirmField)
    form.add(server)
    form.add(message)
    form.add(userRow)
    form.add(passRow)
    if (signUp) form.add(confirmRow)
    form.add(help)
    renderer.root.add(form)

    let stage: Stage = 'username'
    let password = ''
    let confirm = ''

    const masked = (value: string, active: boolean) => `${'•'.repeat(value.length)}${active ? '▏' : ''}`
    const redraw = () => {
      passField.content = stage === 'username' ? '' : masked(password, stage === 'password')
      confirmField.content = stage === 'confirm' ? masked(confirm, true) : ''
    }

    const setStage = (next: Stage) => {
      stage = next
      confirm = ''
      if (next === 'username') {
        password = ''
        username.focus()
      } else {
        username.blur()
      }
      redraw()
    }

    const finish = (result: Credentials | null) => {
      renderer.keyInput.off('keypress', onKey)
      renderer.root.remove(form)
      form.destroyRecursively()
      resolve(result)
    }

    const submit = () => {
      if (stage === 'password') {
        if (password.length === 0) return
        if (!signUp) {
          finish({ username: username.value.trim(), password })
          return
        }
        if (password.length < PASSWORD_MIN_CHARS) {
          message.content = PASSWORD_TOO_SHORT
          return
        }
        message.content = ''
        setStage('confirm')
        return
      }
      if (confirm === password) {
        finish({ username: username.value.trim(), password })
        return
      }
      message.content = PASSWORDS_DIFFER
      password = ''
      setStage('password')
    }

    const onKey = (key: KeyEvent) => {
      if (key.ctrl && key.name === 'c') {
        key.preventDefault()
        finish(null)
        return
      }
      if (stage === 'username') return
      key.preventDefault()
      if (key.name === 'return' || key.name === 'kpenter') {
        submit()
        return
      }
      if (key.name === 'escape') {
        setStage(stage === 'confirm' ? 'password' : 'username')
        return
      }
      const edit = (value: string): string => {
        if (key.name === 'backspace') return value.slice(0, -1)
        if (!key.ctrl && !key.meta && isPrintable(key.sequence)) return value + key.sequence
        return value
      }
      if (stage === 'password') password = edit(password)
      else confirm = edit(confirm)
      redraw()
    }

    renderer.keyInput.on('keypress', onKey)
    if (opts.username) setStage('password')
    else setStage('username')
  })
}

function isPrintable(sequence: string): boolean {
  if (sequence.length === 0) return false
  for (const ch of sequence) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}
