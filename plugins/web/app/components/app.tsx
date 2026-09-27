import { createAuth, type Fetch, type SessionStore, type StoredSession } from '@keith/client'
import { useEffect, useMemo, useState } from 'react'
import { browserVoice, type VoiceEnv } from '../lib/voice.ts'
import { ChatScreen } from './chat/chat-screen.tsx'
import { type Credentials, LoginForm } from './login-form.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.tsx'

export type AppProps = {
  /** The core's normalized base URL. In the browser, the page's own origin. */
  baseUrl: string
  /** Where the session (token, nodeId) is kept: `localStorage` in the browser. */
  store: SessionStore
  fetch?: Fetch | undefined
  /** The mic and speaker. Default: the browser's (`browserVoice()`); tests pass a fake. */
  voice?: VoiceEnv | undefined
}

type Screen = { kind: 'loading' } | { kind: 'login' } | { kind: 'chat'; session: StoredSession }

/** The browser Node: sign in, then the main thread. */
export function App({ baseUrl, store, fetch, voice }: AppProps) {
  const auth = useMemo(() => createAuth({ baseUrl, store, fetch }), [baseUrl, store, fetch])
  const voiceEnv = useMemo(() => voice ?? browserVoice(), [voice])
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })

  useEffect(() => {
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
  }, [auth])

  const login = async (credentials: Credentials) => {
    const session = await auth.login(credentials)
    setScreen({ kind: 'chat', session })
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
