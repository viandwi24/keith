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
 * the user quits with Ctrl+C.
 */

export type Credentials = { username: string; password: string }

export type LoginPromptOptions = {
  url: string
  username?: string | undefined
  /** Shown above the form, e.g. the previous attempt's error. */
  message?: string | undefined
}

export function promptLogin(renderer: CliRenderer, opts: LoginPromptOptions): Promise<Credentials | null> {
  return new Promise((resolve) => {
    const form = new BoxRenderable(renderer, {
      id: 'login',
      flexDirection: 'column',
      border: true,
      title: ' Keith: sign in ',
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
      placeholder: 'owner',
      flexGrow: 1,
    })
    username.on(InputRenderableEvents.ENTER, () => {
      if (username.value.trim().length > 0) setStage('password')
    })
    const passRow = new BoxRenderable(renderer, { flexDirection: 'row', height: 1 })
    const passLabel = new TextRenderable(renderer, { content: 'password ', width: 9 })
    const passField = new TextRenderable(renderer, { content: '', flexGrow: 1 })
    const help = new TextRenderable(renderer, {
      content: 'Enter next · Esc back · Ctrl+C quit',
      fg: '#9aa0a6',
    })

    userRow.add(userLabel)
    userRow.add(username)
    passRow.add(passLabel)
    passRow.add(passField)
    form.add(server)
    form.add(message)
    form.add(userRow)
    form.add(passRow)
    form.add(help)
    renderer.root.add(form)

    let stage: 'username' | 'password' = 'username'
    let password = ''

    const setStage = (next: 'username' | 'password') => {
      stage = next
      if (next === 'password') {
        username.blur()
        passField.content = '▏'
      } else {
        password = ''
        passField.content = ''
        username.focus()
      }
    }

    const finish = (result: Credentials | null) => {
      renderer.keyInput.off('keypress', onKey)
      renderer.root.remove(form)
      form.destroyRecursively()
      resolve(result)
    }

    const onKey = (key: KeyEvent) => {
      if (key.ctrl && key.name === 'c') {
        key.preventDefault()
        finish(null)
        return
      }
      if (stage !== 'password') return
      key.preventDefault()
      if (key.name === 'return' || key.name === 'kpenter') {
        if (password.length > 0) finish({ username: username.value.trim(), password })
        return
      }
      if (key.name === 'escape') {
        setStage('username')
        return
      }
      if (key.name === 'backspace') {
        password = password.slice(0, -1)
      } else if (!key.ctrl && !key.meta && isPrintable(key.sequence)) {
        password += key.sequence
      }
      passField.content = `${'•'.repeat(password.length)}▏`
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
