// The person's workspace in this tab (P40.2, ADR-0037): the document lives in the core; this tab shows it, applies a change at once
// (optimistic) and sends it as `workspace.apply` on the version it last had from the core. A conflict applies the change again on the
// newest document; another device's change arrives as `workspace-changed` and is read again. The view (mode, desktop shown) is
// this browser's own, kept in localStorage and reported with the presence heartbeat (`view`).

import {
  type ClientView,
  WORKSPACE_CHANGED,
  WorkspaceChangedRecordSchema,
  type WorkspaceShowInput,
} from '@keith/contracts'
import { getClient } from '../session/index.ts'
import { appOf, BUILTIN_APPS, mergeApps, openAppOp, setKnownApps, type WindowApp } from './apps.ts'
import { cycleWindow, type KeyAction, movedIndex, stepDesktop } from './keys.ts'
import {
  emptyWorkspace,
  firstDesktop,
  focusedOf,
  type LayoutPreset,
  MAX_DESKTOPS,
  type WorkspaceDoc,
  type WorkspaceOp,
  type WorkspaceOpError,
} from './model.ts'
import { replayPending, settleApply } from './sync.ts'

export type WorkspaceMode = ClientView['mode']
const MODES: readonly WorkspaceMode[] = ['ambient', 'workspace', 'overview']

export const VIEW_KEY = 'keith.workspace.view.v1'
/** Times a change is applied again after a conflict before this tab gives it up. */
const RETRIES = 3

interface StoredView {
  desktopId: string
  mode: WorkspaceMode
}

function readView(): StoredView | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed = JSON.parse(raw) as Partial<StoredView>
    return {
      desktopId: typeof parsed.desktopId === 'string' ? parsed.desktopId : 'd1',
      mode: MODES.includes(parsed.mode as WorkspaceMode)
        ? (parsed.mode as WorkspaceMode)
        : 'ambient',
    }
  } catch {
    return undefined
  }
}

let seq = 0
const newId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

class Workspace {
  /** What this tab shows: the core's document with this tab's changes that are still on their way. */
  doc = $state<WorkspaceDoc>(emptyWorkspace())
  desktopId = $state('d1')
  mode = $state<WorkspaceMode>('ambient')
  /** The core's document has been read once. */
  loaded = $state(false)
  /** The last refused change, for a short note in the dock. */
  refused = $state<WorkspaceOpError | undefined>(undefined)
  /** What Keith asked this screen to show while the person was busy: a chip in the dock until they open or dismiss it. */
  held = $state<WorkspaceShowInput | undefined>(undefined)
  /** Keith changed the workspace and nothing changed after it: the dock offers to take it back. */
  keithChanged = $state(false)
  /** The window apps this person may open (`workspace.apps`), the built-in fallback until the core answers. */
  apps = $state.raw<readonly WindowApp[]>(BUILTIN_APPS)

  readonly desktop = $derived(
    this.doc.desktops.find((d) => d.id === this.desktopId) ?? firstDesktop(this.doc),
  )
  /** What this tab shows, as the presence heartbeat reports it. */
  readonly view: ClientView = $derived.by(() => {
    if (this.mode === 'ambient') return { mode: 'ambient' }
    const focus = this.mode === 'workspace' ? focusedOf(this.desktop) : undefined
    return {
      mode: this.mode,
      desktopId: this.desktop.id,
      ...(focus === undefined ? {} : { focusWindowId: focus.id }),
    }
  })

  /** The last document the core answered. */
  private confirmed: WorkspaceDoc = emptyWorkspace()
  /** Changes applied here and not yet answered, oldest first. */
  private pending: WorkspaceOp[][] = []
  private sending = false
  private started = false
  /** This tab's tag on its changes: its own `workspace-changed` records are dropped. */
  private readonly tab = newId('t')

  constructor() {
    const stored = readView()
    if (stored !== undefined) {
      this.desktopId = stored.desktopId
      this.mode = stored.mode
    }
  }

  /** Reads the core's workspace and follows its changes; calling it again does nothing. */
  start(): void {
    if (this.started) return
    this.started = true
    const feed = getClient().feed()
    feed.subscribeEvents((record) => {
      if (record.type !== WORKSPACE_CHANGED) return
      const parsed = WorkspaceChangedRecordSchema.safeParse(record.payload)
      if (!parsed.success || parsed.data.clientId === this.tab) return
      this.keithChanged = parsed.data.by === 'keith'
      if (parsed.data.version > this.confirmed.version) void this.refetch()
    })
    feed.subscribeResync(() => {
      void this.refetch()
      void this.loadApps()
    })
    void this.refetch()
    void this.loadApps()
  }

  /** Reads the apps this person may open; a failed call keeps the built-in fallback (`mergeApps`). */
  async loadApps(): Promise<void> {
    const listed = await getClient()
      .rpc.workspace.apps()
      .catch(() => undefined)
    // a failure after a good answer keeps that answer
    if (listed === undefined && this.apps !== BUILTIN_APPS) return
    const apps = mergeApps(listed)
    setKnownApps(apps)
    this.apps = apps
  }

  private saveView(): void {
    try {
      globalThis.localStorage?.setItem(
        VIEW_KEY,
        JSON.stringify({ desktopId: this.desktopId, mode: this.mode }),
      )
    } catch {
      // the view then lasts until the page reloads
    }
  }

  /** Shows the core's document with this tab's unanswered changes on top. */
  private showConfirmed(doc: WorkspaceDoc): void {
    this.confirmed = doc
    const replayed = replayPending(doc, this.pending)
    this.pending = replayed.pending
    this.doc = replayed.doc
    this.keepDesktop()
  }

  private keepDesktop(): void {
    if (!this.doc.desktops.some((d) => d.id === this.desktopId))
      this.desktopId = firstDesktop(this.doc).id
  }

  /** The workspace has this desktop. */
  has(desktopId: string): boolean {
    return this.doc.desktops.some((d) => d.id === desktopId)
  }

  /** Reads the core's workspace now. */
  sync(): Promise<void> {
    return this.refetch()
  }

  private async refetch(): Promise<void> {
    try {
      const doc = await getClient().rpc.workspace.get()
      this.loaded = true
      if (doc.version >= this.confirmed.version) this.showConfirmed(doc)
    } catch {
      // signed out or the core is down: the feed's resync reads it again
    }
  }

  /** Sends the pending changes one after the other, each on the newest version this tab knows. */
  private async flush(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      let tries = 0
      while (this.pending.length > 0) {
        const ops = this.pending[0] as WorkspaceOp[]
        const result = await getClient()
          .rpc.workspace.apply({ baseVersion: this.confirmed.version, ops, clientId: this.tab })
          .catch(() => undefined)
        if (result === undefined) {
          // the core did not take it: drop the change and show the core's document again
          this.pending.shift()
          await this.refetch()
          continue
        }
        const step = settleApply(result, tries, RETRIES)
        if (step.drop) this.pending.shift()
        tries = step.drop ? 0 : tries + 1
        if (step.refused !== undefined) this.refused = step.refused
        this.showConfirmed(result.doc)
      }
    } finally {
      this.sending = false
    }
  }

  /** Applies operations here at once and sends them to the core; false (and a note) when they break a rule. */
  applyAll(ops: WorkspaceOp[]): boolean {
    const replayed = replayPending(this.doc, [ops])
    if (replayed.pending.length === 0) {
      this.refused = replayed.refused
      return false
    }
    this.refused = undefined
    this.keithChanged = false
    this.pending.push(ops)
    this.doc = replayed.doc
    this.keepDesktop()
    void this.flush()
    return true
  }

  apply(op: WorkspaceOp): boolean {
    return this.applyAll([op])
  }

  setMode(mode: WorkspaceMode): void {
    this.mode = mode
    this.saveView()
  }

  show(desktopId: string): void {
    if (!this.doc.desktops.some((d) => d.id === desktopId)) return
    this.desktopId = desktopId
    this.mode = 'workspace'
    this.saveView()
  }

  /**
   * Keith's `workspace.show` (ADR-0037 §6): shown at once, or held as a dock chip while the person types or the tab is hidden, so
   * the screen never jumps under them. `busy` is decided by the caller (the presence handler reads the page).
   */
  deliverShow(input: WorkspaceShowInput, busy: boolean): 'shown' | 'held' {
    // going back to the orb hides the workspace: nothing jumps under the person, so it is never held
    if (busy && !('ambient' in input)) {
      this.held = input
      return 'held'
    }
    this.showTarget(input)
    return 'shown'
  }

  /** Opens what a held chip points at. */
  openHeld(): void {
    const target = this.held
    this.held = undefined
    if (target !== undefined) this.showTarget(target)
  }

  dismissHeld(): void {
    this.held = undefined
  }

  private showTarget(input: WorkspaceShowInput): void {
    if ('ambient' in input) {
      this.held = undefined
      this.setMode('ambient')
      return
    }
    if ('overview' in input) {
      this.setMode('overview')
      return
    }
    this.show(input.desktopId)
    if (input.windowId !== undefined) {
      const window = this.desktop.windows.find((w) => w.id === input.windowId)
      if (window !== undefined && focusedOf(this.desktop)?.id !== window.id)
        this.apply({ op: 'window.focus', id: window.id })
    }
  }

  /** Takes back Keith's latest change (`workspace.undoKeith`); a refusal leaves a note in the dock. */
  async undoKeith(): Promise<void> {
    this.keithChanged = false
    const result = await getClient()
      .rpc.workspace.undoKeith()
      .catch(() => undefined)
    if (result === undefined) return
    if (result.status === 'refused') this.refused = result.error
    if (result.doc.version >= this.confirmed.version) this.showConfirmed(result.doc)
  }

  /** Opens (or focuses) an app on the desktop shown, and shows the workspace. */
  openApp(appId: string): void {
    const app = appOf(appId, this.apps)
    if (app === undefined) return
    if (this.apply(openAppOp(this.doc, this.desktop.id, app, newId('w')))) this.setMode('workspace')
  }

  addDesktop(): void {
    if (this.doc.desktops.length >= MAX_DESKTOPS) {
      this.refused = 'desktop-limit'
      return
    }
    const id = newId('d')
    const used = new Set(this.doc.desktops.map((d) => d.name))
    let n = this.doc.desktops.length + 1
    while (used.has(`Desktop ${n}`)) n++
    if (this.apply({ op: 'desktop.add', id, name: `Desktop ${n}` })) this.show(id)
  }

  removeDesktop(id: string): void {
    this.apply({ op: 'desktop.remove', id })
  }

  /** Puts a desktop at `index` in the list (overview, Alt+Shift+Arrow). */
  moveDesktop(id: string, index: number): void {
    const at = this.doc.desktops.findIndex((d) => d.id === id)
    if (at < 0 || at === index) return
    this.apply({ op: 'desktop.move', id, index })
  }

  renameDesktop(id: string, name: string): void {
    const clean = name.trim().slice(0, 40)
    const desktop = this.doc.desktops.find((d) => d.id === id)
    if (clean === '' || desktop === undefined || desktop.name === clean) return
    this.apply({ op: 'desktop.rename', id, name: clean })
  }

  /** Runs a keyboard shortcut (`keys.ts`); false when it does nothing here, so the key goes on to the page. */
  runKey(action: KeyAction): boolean {
    const desktop = this.desktop
    switch (action.kind) {
      case 'desktop': {
        const target = this.doc.desktops[action.index]
        if (target === undefined) return false
        this.show(target.id)
        return true
      }
      case 'desktop-step':
        this.show(stepDesktop(this.doc, desktop.id, action.step))
        return true
      case 'desktop-move': {
        const to = movedIndex(this.doc, desktop.id, action.step)
        if (to === undefined) return false
        this.moveDesktop(desktop.id, to)
        return true
      }
      case 'window-cycle': {
        if (this.mode !== 'workspace') return false
        const id = cycleWindow(desktop, action.step)
        if (id === undefined) return false
        this.apply({ op: 'window.focus', id })
        return true
      }
      case 'close-window': {
        const top = this.mode === 'workspace' ? focusedOf(desktop) : undefined
        if (top === undefined) return false
        this.apply({ op: 'window.close', id: top.id })
        return true
      }
      case 'overview':
        this.setMode(this.mode === 'overview' ? 'workspace' : 'overview')
        return true
      case 'new-desktop':
        this.addDesktop()
        return true
      case 'ambient':
        this.setMode(this.mode === 'ambient' ? 'workspace' : 'ambient')
        return true
    }
  }

  setLayout(layout: LayoutPreset): void {
    this.apply({ op: 'desktop.layout', id: this.desktop.id, layout })
  }
}

export const workspace = new Workspace()
