const KEY = 'keith.rail'

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'collapsed'
  } catch {
    return false
  }
}

/** Whether the desktop rail is collapsed to icons (remembered per browser; a blocked storage keeps it for the tab). */
class Rail {
  collapsed = $state(read())
  inspectorOpen = $state(false)
  /** The command palette (it lives in the palette feature; the top bar button only asks for it). */
  paletteOpen = $state(false)

  toggle(): void {
    this.collapsed = !this.collapsed
    try {
      if (this.collapsed) globalThis.localStorage?.setItem(KEY, 'collapsed')
      else globalThis.localStorage?.removeItem(KEY)
    } catch {
      // not remembered
    }
  }
}

export const rail = new Rail()
