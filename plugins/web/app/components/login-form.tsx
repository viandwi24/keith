import { ClientError } from '@keith/client'
import { type FormEvent, useState } from 'react'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'

export type Credentials = { username: string; password: string }

/** Username and password, used for the first sign-in and to sign in again after a rejected token. */
export function LoginForm({
  onSubmit,
  submitLabel = 'Sign in',
  initialUsername = '',
}: {
  onSubmit: (credentials: Credentials) => Promise<void>
  submitLabel?: string
  initialUsername?: string
}) {
  const [username, setUsername] = useState(initialUsername)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ username: username.trim(), password })
    } catch (err) {
      setError(err instanceof ClientError ? err.message : 'sign-in failed')
      setBusy(false)
      return
    }
    setBusy(false)
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label="Sign in">
      <div className="flex flex-col gap-2">
        <Label htmlFor="keith-username">Username</Label>
        <Input
          id="keith-username"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="keith-password">Password</Label>
        <Input
          id="keith-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={busy || username.trim() === '' || password === ''}>
        {busy ? 'Signing in…' : submitLabel}
      </Button>
    </form>
  )
}
