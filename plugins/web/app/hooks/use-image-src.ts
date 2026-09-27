import { useEffect, useState } from 'react'
import { type FileFetchDeps, fetchCoreFile, imageSource } from '../lib/images.ts'

export type ImageState = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'failed' }

/**
 * The `src` for a block image. Core files are fetched with the token and shown from an object URL,
 * which is revoked when the image goes away or its URL changes.
 */
export function useImageSrc(url: string, files: FileFetchDeps | null): ImageState {
  const source = imageSource(url)
  const direct = source.kind === 'direct' ? source.src : null
  const corePath = source.kind === 'core-file' ? source.path : null
  const [state, setState] = useState<ImageState>(
    direct
      ? { status: 'ready', src: direct }
      : corePath && files
        ? { status: 'loading' }
        : { status: 'failed' },
  )
  const baseUrl = files?.baseUrl
  const token = files?.token
  const doFetch = files?.fetch

  useEffect(() => {
    if (direct) {
      setState({ status: 'ready', src: direct })
      return
    }
    if (!corePath || baseUrl === undefined || token === undefined) {
      setState({ status: 'failed' })
      return
    }
    const controller = new AbortController()
    let objectUrl: string | null = null
    setState({ status: 'loading' })
    fetchCoreFile({ baseUrl, token, fetch: doFetch }, corePath, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setState({ status: 'ready', src: objectUrl })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        console.warn('cannot load image', corePath, error)
        setState({ status: 'failed' })
      },
    )
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [direct, corePath, baseUrl, token, doFetch])

  return state
}
