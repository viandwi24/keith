// Whether a stage panel is expanded: a per-browser convenience in localStorage (guarded). Nothing depends on it; a browser that keeps
// no storage just opens every panel collapsed.

export const panelKey = (id: string): string => `keith.stage.${id}.expanded`

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const platform = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readPanelExpanded(
  id: string,
  storage: StorageLike | undefined = platform(),
): boolean {
  try {
    return storage?.getItem(panelKey(id)) === 'on'
  } catch {
    return false
  }
}

export function writePanelExpanded(
  id: string,
  on: boolean,
  storage: StorageLike | undefined = platform(),
): void {
  try {
    if (on) storage?.setItem(panelKey(id), 'on')
    else storage?.removeItem(panelKey(id))
  } catch {
    // the choice then lasts until the page reloads
  }
}
