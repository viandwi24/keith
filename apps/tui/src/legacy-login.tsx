import { type ClientConfig, isRemembered, readClientConfig } from '@keith/client'
import { Txt, useTheme, useToast } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useState } from 'react'
import { forgetSavedLogin } from './sign-out.ts'

export const LEGACY_LOGIN_NOTICE =
  'An old saved login (from before sign-in existed) is not used. Sign in below, or press ctrl+f to forget it.'
export const LEGACY_LOGIN_FORGOTTEN = 'The old saved login is forgotten.'

/**
 * The login saved in `client.json` that the app does not use because the person never chose to remember this
 * device (a `keith login`, a token, a file of an earlier version). `undefined` when there is none or it is
 * remembered (the app signed in with it already).
 */
export function legacySavedLogin(configPath: string | undefined): ClientConfig | undefined {
  const saved = readClientConfig(...(configPath === undefined ? [] : [configPath]))
  return saved === undefined || isRemembered(saved) ? undefined : saved
}

/**
 * Over a sign-in panel or screen: says that a saved login was found and not used, and offers one action to
 * forget it (`ctrl+f`: revoke it on the core when reachable, then delete the file). It is never deleted by the
 * start itself: a script or a remote device may use it through `--core` and `keith whoami`.
 */
export function LegacyLoginNotice({
  configPath,
  width,
}: {
  configPath: string | undefined
  /** Cells the lines may use (they wrap inside it and the block is centred); default: the content's own width. */
  width?: number
}) {
  const theme = useTheme()
  const { push } = useToast()
  const [saved] = useState(() => legacySavedLogin(configPath))
  const [state, setState] = useState<'found' | 'forgetting' | 'forgotten'>('found')
  useInput(
    (input, key) => {
      if (!key.ctrl || input !== 'f' || saved === undefined || state !== 'found') return
      setState('forgetting')
      void forgetSavedLogin(saved, configPath).then(() => {
        setState('forgotten')
        push(LEGACY_LOGIN_FORGOTTEN, { level: 'success' })
      })
    },
    { isActive: saved !== undefined && state === 'found' },
  )
  if (saved === undefined || state === 'forgotten') return null
  const text = state === 'forgetting' ? 'Forgetting it ...' : LEGACY_LOGIN_NOTICE
  return (
    <Box marginBottom={1} justifyContent="center" {...(width === undefined ? {} : { width })}>
      <Box flexShrink={1} paddingX={1} {...theme.bg('user-message')}>
        <Txt tone="muted" wrap="wrap">
          {text}
        </Txt>
      </Box>
    </Box>
  )
}
