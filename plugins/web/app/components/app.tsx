import { createAuth, type Fetch, type SessionStore, type StoredSession } from '@keith/client'
import { useEffect, useMemo, useState } from 'react'
import { type AddressBar, browserAddressBar, inviteFromHash } from '../lib/invite.ts'
import { browserVoice, type VoiceEnv } from '../lib/voice.ts'
import { ChatScreen } from './chat/chat-screen.tsx'
import { InviteForm, type SignUp } from './invite-form.tsx'
import { type Credentials, LoginForm } from './login-form.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Button } from './ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.tsx'

export type AppProps = {
  /** The core's normalized base URL. In the browser, the page's own origin. */
  baseUrl: string
  /** Where the session (token, nodeId) is kept: `localStorage` in the browser. */
  store: SessionStore
  fetch?: Fetch | undefined
  /** The mic and speaker. Default: the browser's (`browserVoice()`); tests pass a fake. */
  voice?: VoiceEnv | undefined
  /** The page address, read once for an invite link (`#invite=<code>`). Default: the browser's. */
  address?: AddressBar | undefined
}

type Screen =
  | { kind: 'loading' }
  | { kind: 'login' }
  /** Phase 5: sign-up from an invite link. `invalid` holds the message once the link failed. */
  | { kind: 'invite'; code: string; invalid: string | null }
  | { kind: 'chat'; session: StoredSession }

/** Shown for an invite link without a code (the core's refusal carries the same sentence). */
export const INVALID_INVITE = 'This invite link is not valid any more. Ask the owner for a new one.'

/** The browser Node: sign in (or sign up from an invite link), then the threads. */
export function App({ baseUrl, store, fetch, voice, address }: AppProps) {
  const auth = useMemo(() => createAuth({ baseUrl, store, fetch }), [baseUrl, store, fetch])
  const voiceEnv = useMemo(() => voice ?? browserVoice(), [voice])
  const bar = useMemo(() => address ?? browserAddressBar(), [address])
  const [screen, setScreen] = useState<Screen>(() => {
    const invite = inviteFromHash(bar.hash())
    if (!invite) return { kind: 'loading' }
    return { kind: 'invite', code: invite.code, invalid: invite.code === '' ? INVALID_INVITE : null }
  })
  const inviting = screen.kind === 'invite'

  useEffect(() => {
    // An invite link signs up a new person: a stored session (someone else's, maybe) is not restored.
    if (inviting) return
    let live = true
    auth.restore().then(
      (session) => {
        if (live) setScreen(session ? { kind: 'chat', session } : { kind: 'login' })
      },
      (error: unknown) => {
        console.warn('cannot restore the session', error)
        if (live) setScreen({ kind: 'login' })
      },
    )
    return () => {
      live = false
    }
  }, [auth, inviting])

  const login = async (credentials: Credentials) => {
    const session = await auth.login(credentials)
    setScreen({ kind: 'chat', session })
  }

  const signUp = async (code: string, { username, password }: SignUp) => {
    const session = await auth.acceptInvite({ code, username, password })
    bar.clearHash()
    setScreen({ kind: 'chat', session })
  }

  const leaveInvite = () => {
    bar.clearHash()
    setScreen({ kind: 'loading' })
  }

  switch (screen.kind) {
    case 'loading':
      return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
    case 'login':
      return (
        <main className="flex min-h-dvh items-center justify-center p-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Sign in to Keith</CardTitle>
              <CardDescription>Use the account your household's Keith gave you.</CardDescription>
            </CardHeader>
            <CardContent>
              <LoginForm onSubmit={login} />
            </CardContent>
          </Card>
        </main>
      )
    case 'invite':
      return (
        <main className="flex min-h-dvh items-center justify-center p-4">
          <Card className="w-full max-w-sm" data-slot="invite">
            <CardHeader>
              <CardTitle>Join Keith</CardTitle>
              <CardDescription>You were invited. Pick a username and a password.</CardDescription>
            </CardHeader>
            <CardContent>
              {screen.invalid === null ? (
                <InviteForm
                  onSubmit={(signUpData) => signUp(screen.code, signUpData)}
                  onInvalid={(message) => setScreen({ ...screen, invalid: message })}
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <Alert variant="destructive" data-slot="invite-invalid">
                    <AlertDescription>{screen.invalid}</AlertDescription>
                  </Alert>
                  <Button type="button" variant="outline" onClick={leaveInvite}>
                    Sign in instead
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </main>
      )
    case 'chat':
      return (
        <ChatScreen
          key={screen.session.token}
          baseUrl={baseUrl}
          auth={auth}
          session={screen.session}
          fetch={fetch}
          voice={voiceEnv}
          onSignedOut={() => setScreen({ kind: 'login' })}
        />
      )
  }
}
