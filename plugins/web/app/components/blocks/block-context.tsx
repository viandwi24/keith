import { createContext, useContext } from 'react'
import type { FileFetchDeps } from '../../lib/images.ts'

/** A click on an `actions` button: what the app sends as `ui.action`. */
export type BlockAction = { messageId: string; blockId: string; actionId: string; value?: unknown }

export type BlockEnv = {
  /** Sends `ui.action`. Returns an error text to show, or null when it was sent. */
  sendAction: (action: BlockAction) => string | null
  /** How to fetch `/v1/files/…` images. Null when signed out: such images show their alt text. */
  files: FileFetchDeps | null
}

const noEnv: BlockEnv = { sendAction: () => 'not connected', files: null }

export const BlockEnvContext = createContext<BlockEnv>(noEnv)

export function useBlockEnv(): BlockEnv {
  return useContext(BlockEnvContext)
}
