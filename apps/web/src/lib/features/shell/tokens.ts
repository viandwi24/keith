import { DARK, LIGHT, type Token } from '@keith/ui/tokens'

type Palette = Record<Token, { hex: string }>

const vars = (palette: Palette): string =>
  (Object.keys(palette) as Token[]).map((token) => `--k-${token}:${palette[token].hex};`).join('')

/**
 * The colour tokens of `@keith/ui` as CSS custom properties `--k-<token>`: dark by default, light under
 * `prefers-color-scheme: light`, and a `data-theme="dark|light"` override on the root element that wins over the media query.
 */
export function tokensCss(): string {
  return [
    `:root{${vars(DARK)}color-scheme:dark}`,
    `@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${vars(LIGHT)}color-scheme:light}}`,
    `:root[data-theme="light"]{${vars(LIGHT)}color-scheme:light}`,
    `:root[data-theme="dark"]{${vars(DARK)}color-scheme:dark}`,
  ].join('\n')
}

/** Put the tokens in the page once (a `<style id="k-tokens">`; the core's CSP allows inline styles). */
export function installTokens(doc: Document): void {
  if (doc.getElementById('k-tokens') !== null) return
  const style = doc.createElement('style')
  style.id = 'k-tokens'
  style.textContent = tokensCss()
  doc.head.append(style)
}
