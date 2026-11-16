import { DARK, type Token } from '@keith/ui/tokens'

/**
 * The dark colour tokens as an inline style (`--k-<token>:<hex>;…`). A window sets it on its body, so an old screen drawn inside
 * reads dark over the stage whatever the page theme is.
 */
export const darkTokenStyle = (): string =>
  `${(Object.keys(DARK) as Token[]).map((t) => `--k-${t}:${DARK[t].hex}`).join(';')};color-scheme:dark`
