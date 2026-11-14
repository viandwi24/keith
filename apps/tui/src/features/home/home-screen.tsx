import {
  BRACKET_COLUMNS,
  BracketBox,
  BrainFrame,
  type BrainTrace,
  type ConnectionKind,
  cells,
  G,
  GUTTER,
  KeyLegend,
  type LegendKey,
  Notice,
  type NoticeLevel,
  OrbCanvas,
  onWheel,
  Reveal,
  Rich,
  Subtitle,
  TextInput,
  Txt,
  useFooterContent,
  useFrameClock,
  useMotion,
  useTheme,
} from '@keith/ui'
import { Box, type Key } from 'ink'
import { type ReactNode, useEffect, useState } from 'react'
import { useGuardedInput as useInput, useLink } from '../activity/index.ts'
import type { AuthKind } from '../identity/index.ts'
import { type RoomBanner, RoomBannerRow } from '../room/index.ts'
import { alertCaption, CAPTION_MAX, type CaptionRow } from './home-caption.ts'
import { HomeHeader } from './home-header.tsx'
import { HomeMenu } from './home-menu.tsx'
import { DEFAULT_HOME_MOTION, type HomeMotion } from './home-motion.ts'
import {
  FRAME_GRAPH_ROWS,
  homeLegend,
  homeSize,
  orbModeOf,
  SUBTITLE_ROWS,
  TOP_ROWS,
} from './home-state.ts'
import { levelOf, MENU_START, type MenuNav, menuKey } from './menu-nav.ts'
import {
  type MenuTarget,
  menuTree,
  opensDirectly,
  type SummaryData,
  summaryOf,
  type ViewEntry,
} from './menu-state.ts'
import { useHomeMotion } from './use-home-motion.ts'
import { useSubtitle } from './use-subtitle.ts'

/** What the front chat reports: a turn runs, text streams, and the words of the turn. */
export interface TurnState {
  busy: boolean
  speaking: boolean
  text: string
}

export const IDLE_TURN: TurnState = { busy: false, speaking: false, text: '' }

/** Frames per second of the one clock Home shares between the orb, the brain frame and the subtitle. */
const FPS = 12
/** Width of the dialogs and notices over the bottom of the screen. */
const OVERLAY_MAX = 76

export interface HomeScreenProps {
  columns: number
  rows: number
  /** Cell width over cell height (detected at start, `[` `]` adjust): keeps the orb round. */
  cellAspect: number
  /** A memory dream runs (the caption says `dreaming…` while no alert or notice holds the slot). */
  dreaming?: boolean
  /** Home is on screen: the clock runs and the animations step. */
  running?: boolean
  /** The intro and the idle hide (default: intro on, hide after 60 s). */
  motion?: HomeMotion
  /** An approval, step-up or other dialog needs the person: nothing hides while it is there. */
  attention?: boolean
  /** Home owns `enter`, `space`, the arrows and `esc` (off while a dialog has the keys). */
  active: boolean
  trace: BrainTrace
  connection: ConnectionKind
  turn: TurnState
  /** The chat draft is not empty. */
  typing: boolean
  /** Logged out, core down or offline. */
  alert: boolean
  /** The heir's succession line (grace or claimable), drawn in the caption slot after an alert (`heirCaptionOf`). */
  heir?: CaptionRow | undefined
  /** Set when the sign-in (or core-down) panel replaces the subtitle. */
  auth?: { kind: AuthKind; core: string; detail?: string | undefined } | undefined
  chatEnabled: boolean
  /** `tab` may open the quick ask: signed in, core up, no approval waiting for `tab`. */
  askEnabled?: boolean
  /** The manage sections the role may read. */
  sections: readonly { id: string; title: string }[]
  /** The plugin views the core lists for this person: entries under a `plugins` caption of the menu. */
  views?: readonly ViewEntry[]
  /** The room banner: one row in the caption slot while nothing else holds it and no turn runs (`bannerOf`). */
  banner?: RoomBanner | undefined
  /** An invitation waits (its notice is the first of `notices`): `enter` accepts, `d` declines. */
  invite?: { onAccept(): void; onDecline(): void } | undefined
  /** A person is signed in: the menu ends with Logout (it works without the core). */
  logout?: boolean
  summary: SummaryData
  /** App notices and failed approvals, above the legend. */
  notices: readonly { level: NoticeLevel; rows: readonly string[] }[]
  /**
   * The login panel, drawn over the lower orb at the given width while signed out. It owns the
   * keys and the legend (the hints its step set with `useFooter`); Home's own keys and the alert
   * caption step aside.
   */
  panel?: ((width: number) => ReactNode) | undefined
  /** The approval and step-up dialogs, drawn at the given width. */
  dialogs: (width: number) => ReactNode
  onChat(): void
  /** Enter in the quick ask: send the line to the front session (the chat history keeps it). */
  onAsk?(text: string): void
  /** A quick-ask line starting with `/`: open the chat and run it as the chat would. */
  onAskCommand?(line: string): void
  onLogin(): void
  /** `esc` on Home while a turn runs: interrupt it. */
  onStop(): void
  onOpen(target: MenuTarget): void
}

/**
 * The Home screen (tui-design 5.16): the orb, the brain frame, the subtitle and two keys. The orb
 * mode is real state; the menu is a read-only HUD whose full screens are the ones `/manage`,
 * `/tasks`, `/brain trace` and `/help` already open.
 */
export function HomeScreen({
  columns,
  dreaming = false,
  rows,
  cellAspect,
  running = true,
  motion = DEFAULT_HOME_MOTION,
  attention = false,
  active,
  trace,
  connection,
  turn,
  typing,
  alert,
  auth,
  heir,
  chatEnabled,
  askEnabled = false,
  sections,
  views = [],
  banner,
  invite,
  logout = false,
  summary,
  notices,
  panel,
  dialogs,
  onChat,
  onAsk,
  onAskCommand,
  onLogin,
  onStop,
  onOpen,
}: HomeScreenProps) {
  const theme = useTheme()
  // `--disable-orb`: the orb is still (it appears at once, no intro)
  const { orbStatic } = useMotion()
  const link = useLink()
  const footer = useFooterContent()
  // no colour: no animation, but the trace still steps (slowly) so a lit region fades
  const clock = useFrameClock({ fps: theme.depth === 'none' ? 2 : FPS, running })
  const [askOpen, setAskOpen] = useState(false)
  const [askDraft, setAskDraft] = useState('')
  // an approval or a lost core takes the prompt away
  const askShown = askOpen && askEnabled
  const mode = orbModeOf({
    alert,
    busy: turn.busy,
    speaking: turn.speaking,
    typing: typing || (askShown && askDraft !== ''),
  })
  const words = useSubtitle(turn.text, turn.busy)
  const tree = menuTree(sections, summary.budget, views, { logout })
  const [menuOpen, setMenuOpen] = useState(false)
  const [nav, setNav] = useState<MenuNav>(MENU_START)
  const level = levelOf(tree, nav)
  const item = level.item

  const overlayWidth = Math.min(columns - 4, OVERLAY_MAX)
  // the caption slot: exactly one thing under the orb, up to four rows (an alert that wraps takes them from the orb).
  // Alert state > the first notice (the app puts the failed approvals refresh first) > dreaming… > the subtitle
  // the login panel says what the caption would (signed out), so the caption steps aside
  const caption =
    auth === undefined || panel !== undefined
      ? undefined
      : alertCaption(auth.kind, auth.core, columns)
  const size = homeSize(columns, rows, cellAspect, caption?.length ?? 0)
  // the heir's line holds the slot while no alert or panel does: it stays until the claim state changes
  const heirRows =
    caption === undefined && panel === undefined && !alert && heir !== undefined
      ? [heir]
      : undefined
  const notice = notices[0]

  const { part, shown, skipIntro, touch } = useHomeMotion({
    motion,
    // anything that needs the person keeps everything shown and the idle timer reset
    blocked:
      attention ||
      panel !== undefined ||
      auth !== undefined ||
      alert ||
      notices.length > 0 ||
      askOpen ||
      menuOpen ||
      turn.busy ||
      typing,
  })

  const closeMenu = () => {
    setMenuOpen(false)
    // the position lives only while the menu is open: the next one starts at the top
    setNav(MENU_START)
  }
  const closeAsk = () => {
    setAskOpen(false)
    setAskDraft('')
  }
  const submitAsk = (text: string) => {
    const line = text.trim()
    if (line === '') return
    setAskDraft('')
    if (line.startsWith('/')) {
      setAskOpen(false)
      onAskCommand?.(line)
    } else onAsk?.(line)
  }
  const act = (input: string, key: Key) => {
    if (askShown) {
      // the prompt types; `esc` closes only the prompt (a second `esc` stops a running turn)
      if (key.escape) closeAsk()
      return
    }
    if (menuOpen) {
      const r = menuKey(tree, nav, input, key, link !== undefined)
      setNav(r.nav)
      if (r.action?.kind === 'close') return closeMenu()
      if (r.action?.kind === 'blocked') return link?.block()
      if (r.action?.kind === 'open') return onOpen(r.action.target)
      return
    }
    // an invitation takes enter and d (its notice names them)
    if (invite !== undefined) {
      if (key.return) return invite.onAccept()
      if (input === 'd') return invite.onDecline()
    }
    // leaving the chat never stops a turn; on Home `esc` does, and nothing else
    if (key.escape) return turn.busy ? onStop() : undefined
    if (input === ' ') return setMenuOpen(true)
    if (key.tab) return askEnabled ? setAskOpen(true) : undefined
    if (key.return) {
      if (auth?.kind === 'logged-out') return onLogin()
      if (chatEnabled) return onChat()
    }
  }
  // one handler sees every key: it feeds the idle veil and the intro, then (unless that key only
  // woke a hidden screen) hands the key to Home's own actions
  useInput(
    (input, key) => {
      skipIntro()
      const woke = touch()
      // ctrl+c is never swallowed: the app's own exit handling must always see it
      if (woke && !(key.ctrl && input === 'c')) return
      if (active && panel === undefined) act(input, key)
    },
    {
      allow: (input, key) =>
        input === ' ' || (menuOpen && (key.return || input === 'j' || input === 'k')),
    },
  )
  // the wheel is activity too (the app reads it in front of Ink)
  useEffect(() => onWheel(() => void touch()), [touch])

  const legend = homeLegend({
    menuOpen,
    chatEnabled,
    loggedOut: auth?.kind === 'logged-out',
    busy: turn.busy,
    askEnabled,
    askOpen: askShown,
    offline: link !== undefined,
  })
  // the panel's step sets the footer (hints are `{ key, action }`; a sentence is not a legend)
  const panelLegend: readonly LegendKey[] = Array.isArray(footer)
    ? (footer as readonly { key: string; action: string }[]).map((h) => ({
        key: h.key,
        label: h.action,
      }))
    : []
  const askWidth = Math.max(10, Math.min(columns - GUTTER * 2, CAPTION_MAX))
  const askRow = (
    <Box width={columns} height={1} justifyContent="center" overflow="hidden">
      <BracketBox width={askWidth}>
        <TextInput
          focus={active}
          value={askDraft}
          width={askWidth - BRACKET_COLUMNS}
          maxRows={1}
          placeholder="ask keith…"
          onChange={setAskDraft}
          onSubmit={submitAsk}
        />
      </BracketBox>
    </Box>
  )
  const detail =
    menuOpen && nav.detail && item !== undefined && !opensDirectly(item)
      ? { title: item.title, lines: summaryOf(item, summary) }
      : undefined

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box height={2} flexShrink={0} />
      <Box height={1} flexShrink={0} />
      {/* the orb slot: a fixed box (never flexGrow/flexShrink), so nothing below or above resizes the orb */}
      <Box
        width={columns}
        height={size.areaRows}
        flexShrink={0}
        flexDirection="column"
        alignItems="flex-start"
        overflow="hidden"
      >
        <Box height={size.orbTop - TOP_ROWS} flexShrink={0} />
        <Box
          marginLeft={size.orbLeft}
          width={size.orbWidth}
          height={size.orbHeight}
          flexShrink={0}
          flexGrow={0}
        >
          <Reveal {...part('orb', true)} {...(orbStatic ? { instant: true } : {})}>
            <OrbCanvas
              mode={mode}
              width={size.orbWidth}
              height={size.orbHeight}
              cellAspect={cellAspect}
              running={running}
              clock={clock}
            />
          </Reveal>
        </Box>
      </Box>
      <Box width={columns} height={size.captionRows} flexDirection="column" flexShrink={0}>
        {askShown && !size.subtitle ? (
          askRow
        ) : (caption ?? heirRows) !== undefined ? (
          (caption ?? heirRows ?? []).slice(0, size.captionRows).map((row, i) => (
            <Box key={i} width={columns} height={1} justifyContent="center" overflow="hidden">
              <Rich text={row.text} tone={row.tone} />
            </Box>
          ))
        ) : notice !== undefined ? (
          <Box width={columns} justifyContent="center">
            {/* one short line sits on the axis of the orb and the legend; a longer block keeps its left edge */}
            <Box
              {...(notice.rows.length === 1 && cells(notice.rows[0] ?? '') < overlayWidth - 2
                ? {}
                : { width: overlayWidth })}
              height={size.captionRows}
              overflow="hidden"
            >
              {/* only the rows the slot holds: a longer notice would have its middle rows squeezed out */}
              <Notice level={notice.level} rows={notice.rows.slice(0, size.captionRows)} />
            </Box>
          </Box>
        ) : banner !== undefined && !alert && !turn.busy ? (
          <Box width={columns} height={1} justifyContent="center" overflow="hidden">
            <RoomBannerRow banner={banner} width={Math.min(columns - GUTTER * 2, CAPTION_MAX)} />
          </Box>
        ) : dreaming && !turn.busy ? (
          <Box width={columns} height={1} justifyContent="center" overflow="hidden">
            <Txt tone="muted">{`dreaming${G.ellipsis}`}</Txt>
          </Box>
        ) : (
          size.subtitle && (
            <Subtitle
              text={words}
              width={columns}
              maxRows={SUBTITLE_ROWS}
              running={running}
              clock={clock}
            />
          )
        )}
      </Box>
      {/* the blank row before the legend holds the prompt: the reply keeps both subtitle rows */}
      {size.subtitle && (
        <Box width={columns} height={1} flexShrink={0}>
          {askShown && askRow}
        </Box>
      )}
      <Box width={columns} height={1} justifyContent="center" flexShrink={0} overflow="hidden">
        {/* a dialog that has the keys lists them itself: the page legend stays quiet (tui-design 5.7) */}
        <Reveal {...part('legend', shown)}>
          <KeyLegend
            keys={panel !== undefined ? panelLegend : active ? legend : []}
            width={columns}
          />
        </Reveal>
      </Box>
      <Box height={1} flexShrink={0} />
      {/* drawn after the orb: later cells win, so the frame and the title sit on top of it */}
      <Box position="absolute" top={1} left={0} width={columns} height={1}>
        {size.frame && (
          <Box position="absolute" top={0} left={2}>
            <Reveal {...part('graph', shown)}>
              <BrainFrame
                trace={trace}
                width={size.frameWidth}
                status={mode}
                graphRows={FRAME_GRAPH_ROWS}
                running={running}
                clock={clock}
              />
            </Reveal>
          </Box>
        )}
        <Reveal {...part('title', shown)}>
          <HomeHeader columns={columns} connection={connection} />
        </Reveal>
      </Box>
      <Box
        position="absolute"
        bottom={3}
        left={0}
        width={columns}
        flexDirection="column"
        alignItems="center"
      >
        {panel?.(overlayWidth)}
        {dialogs(overlayWidth)}
      </Box>
      {menuOpen && (
        <Box position="absolute" bottom={2} left={2}>
          <HomeMenu
            items={level.entries}
            selected={level.selected}
            title={level.title}
            detail={detail}
            columns={columns}
            offline={link !== undefined}
            maxRows={rows - 2}
          />
        </Box>
      )}
    </Box>
  )
}
