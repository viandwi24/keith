import type { KeithClient } from '@keith/client'
import type { Node } from '@keith/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { mergeNodes, sortNodes } from './nodes-state.ts'

export interface Nodes {
  nodes: readonly Node[]
  /** The list could not be loaded (the feed still updates it). */
  error: string | undefined
  /** Apply a changed node (a `node-changed` event). */
  apply(node: Node): void
  /** Refetch from the core: at mount, on a feed resync, after a revoke. */
  reload(): void
}

/** The node registry: `rpc.nodes.list` as the base, `node-changed` events on top. */
export function useNodes(client: KeithClient): Nodes {
  const [nodes, setNodes] = useState<readonly Node[]>([])
  const [error, setError] = useState<string | undefined>()
  // nodes changed by events while a list request is in flight (the response may be older)
  const touched = useRef(new Map<string, Node>())
  const inflight = useRef(0)
  const reload = useCallback(() => {
    inflight.current++
    touched.current = new Map()
    client.rpc.nodes
      .list()
      .then((rows) => {
        setError(undefined)
        setNodes(mergeNodes(rows, touched.current))
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        inflight.current--
        if (inflight.current === 0) touched.current = new Map()
      })
  }, [client])
  const apply = useCallback((node: Node) => {
    if (inflight.current > 0) touched.current.set(node.id, node)
    setNodes((current) => sortNodes([...current.filter((n) => n.id !== node.id), node]))
  }, [])
  useEffect(reload, [reload])
  return { nodes, error, apply, reload }
}
