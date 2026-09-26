import type { SendResult } from '@keith/client'
import { type FormEvent, type KeyboardEvent, useState } from 'react'
import { Button } from '../ui/button.tsx'
import { Textarea } from '../ui/textarea.tsx'

const SEND_ERRORS = {
  empty: null,
  'too-long': 'The message is too long.',
  offline: 'Not connected: the message was not sent.',
} as const

/** The input: Enter sends, Shift+Enter adds a line. Cancel stops the running turn. */
export function Composer({
  onSend,
  onCancel,
  busy,
  online,
}: {
  onSend: (text: string) => SendResult
  onCancel: () => void
  /** A turn is running (the thread is not idle). */
  busy: boolean
  online: boolean
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const send = () => {
    const result = onSend(text)
    if (result.ok) {
      setText('')
      setError(null)
    } else {
      setError(SEND_ERRORS[result.reason])
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    send()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  return (
    <form className="flex flex-col gap-1" onSubmit={submit} aria-label="Message">
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message"
          placeholder={online ? 'Message Keith' : 'Waiting for the connection…'}
          className="max-h-48 min-h-10 resize-none"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={!online || text.trim() === ''}>
          Send
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  )
}
