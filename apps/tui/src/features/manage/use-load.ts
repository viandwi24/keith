import { useCallback, useEffect, useRef, useState } from 'react'

export interface Loaded<T> {
  data: T | undefined
  error: string | undefined
  /** The RPC code of the failure (`NOT_FOUND`, ...), when the error carries one. */
  errorCode: string | undefined
  loading: boolean
  reload(): void
}

/** Load a value at mount and again on `reload()`. A failure keeps the last good data. */
export function useLoad<T>(load: () => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [errorCode, setErrorCode] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const latest = useRef(load)
  latest.current = load
  const alive = useRef(true)
  // only the newest read may write: an older one that settles later must not overwrite it
  const seq = useRef(0)
  const reload = useCallback(() => {
    const mine = ++seq.current
    setLoading(true)
    latest.current().then(
      (value) => {
        if (!alive.current || mine !== seq.current) return
        setData(value)
        setError(undefined)
        setErrorCode(undefined)
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive.current || mine !== seq.current) return
        setError(e instanceof Error ? e.message : String(e))
        setErrorCode(codeOf(e))
        setLoading(false)
      },
    )
  }, [])
  useEffect(() => {
    alive.current = true
    reload()
    return () => {
      alive.current = false
    }
  }, [reload])
  return { data, error, errorCode, loading, reload }
}

const codeOf = (e: unknown): string | undefined => {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}
