import { ClientError } from '@keith/client'
import { PASSWORD_MIN_CHARS } from '@keith/protocol'
import { type FormEvent, useState } from 'react'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'

export type SignUp = { username: string; password: string }

const MISMATCH = 'The passwords do not match.'

/**
 * Phase 5: sign-up from an invite link. The person picks a username and a password (typed twice).
 * `onSubmit` accepts the invite; an `INVITE_INVALID` error is `onInvalid`'s to show, any other
 * error shows under the form (e.g. a username someone else has).
 */
export function InviteForm({
  onSubmit,
  onInvalid,
}: {
  onSubmit: (signUp: SignUp) => Promise<void>
  onInvalid: (message: string) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = password.length < PASSWORD_MIN_CHARS

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (password !== repeat) {
      setError(MISMATCH)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ username: username.trim(), password })
    } catch (err) {
      setBusy(false)
      if (err instanceof ClientError && err.code === 'INVITE_INVALID') {
        onInvalid(err.message)
        return
      }
      setError(err instanceof ClientError ? err.message : 'sign-up failed')
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label="Sign up">
      <div className="flex flex-col gap-2">
        <Label htmlFor="keith-new-username">Username</Label>
        <Input
          id="keith-new-username"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="keith-new-password">Password</Label>
        <Input
          id="keith-new-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_CHARS}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <p className="text-xs text-muted-foreground">At least {PASSWORD_MIN_CHARS} characters.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="keith-repeat-password">Repeat password</Label>
        <Input
          id="keith-repeat-password"
          name="repeat"
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(e) => setRepeat(e.currentTarget.value)}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={busy || username.trim() === '' || tooShort || repeat === ''}>
        {busy ? 'Signing up…' : 'Sign up'}
      </Button>
    </form>
  )
}
