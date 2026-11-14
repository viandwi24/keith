import {
  BrainTrace,
  ChatHeader,
  FooterProvider,
  FooterRow,
  GUTTER,
  type ToastLevel,
  Txt,
  useMotion,
  useTheme,
  useToast,
} from '@keith/ui'
import { Box, useApp, useWindowSize } from 'ink'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityStrip } from './activity-strip.tsx'
import { ChatAbove } from './app-above.tsx'
import { ChatFrame } from './app-chat-frame.tsx'
import { ChatMain } from './app-chat-main.tsx'
import { runCommand } from './app-commands.ts'
import { FramedScreens, isFramed } from './app-framed.tsx'
import { hintsOf, shorten } from './app-hints.ts'
import { homePanelOf } from './app-panel.tsx'
import type { AppProps } from './app-props.ts'
import { AppScreens, type Screen } from './app-screens.tsx'
import { SessionScreens } from './app-session.tsx'
import { statusOf } from './app-status.ts'
import { chatOrbBox } from './chat-orb-box.ts'
import {
  LinkProvider,
  OfflineKeys,
  useConnection,
  useLinkValue,
} from './features/activity/index.ts'
import { approvalsError, useApprovals } from './features/approvals/index.ts'
import { useBrain } from './features/brain/index.ts'
import { useBudget } from './features/budget/index.ts'
import { parseContextCommand, runContextCommand } from './features/chat/context-commands.ts'
import { pendingKindOf } from './features/chat/context-pending.ts'
import { HistoryScreen } from './features/chat/history-screen.tsx'
import type { ChatNotice } from './features/chat/index.ts'
import { useContextPending } from './features/chat/use-context-pending.ts'
import {
  type FlightDirection,
  IDLE_TURN,
  type MenuTarget,
  OrbFlight,
  orbModeOf,
  type TurnState,
} from './features/home/index.ts'
import { AuthPanel, authRows, usePrivacyNotice, useWhoami } from './features/identity/index.ts'
import { capsOf, SECTIONS, useHeirSuccession, visibleSections } from './features/manage/index.ts'
import { parseDreamCommand, runDreamCommand, useDreamActivity } from './features/memory/index.ts'
import { countNodes, useNodes } from './features/nodes/index.ts'
import { parsePersonaCommand, runPersonaCommand } from './features/persona/index.ts'
import { openTargetOf, PluginViewScreen, useViewMenu } from './features/plugin-view/index.ts'
import { usePresenceTouch, usePresenceViewOpener } from './features/presence/index.ts'
import { RoomBannerRow, useRoomApp } from './features/room/index.ts'
import { useStepUp } from './features/stepup/index.ts'
import { isActive, useTasks } from './features/tasks/index.ts'
import { HomeHost } from './home-host.tsx'
import { layoutOf, MIN_COLUMNS, sidebarBox } from './layout.ts'
import { DEFAULT_CELL_ASPECT } from './platform/cell-size.ts'
import { kittyKeys } from './platform/terminal-input.ts'
import { SidebarColumn } from './sidebar-column.tsx'
import { signOut } from './sign-out.ts'
import { useAppFeed, useCoreFacts } from './use-app-feed.ts'
import { useAppKeys } from './use-app-keys.ts'
import { sessionActionsOf } from './use-session-actions.ts'

export type { AppProps } from './app-props.ts'

export function App({
  client,
  core,
  columns,
  rows: rowsProp,
  brain: tuning,
  budgetPollMs,
  nodesPollMs = 30_000,
  header = true,
  cellAspect: aspectProp = DEFAULT_CELL_ASPECT,
  start = 'home',
  configPath,
  signInTuning,
  connection: swappable,
  switchConnection,
  enterGuest,
  guestFetch,
  mouse,
  motion,
}: AppProps) {
  const { exit } = useApp()
  const standalone = start === 'manage'
  const size = useWindowSize()
  const width = columns ?? size.columns
  const rows = rowsProp ?? size.rows
  const [screen, setScreen] = useState<Screen>(start)
  const [logoutOpen, setLogoutOpen] = useState(false)
  // `/succession`: the heir's panel over Home (the panel reads the state itself)
  const [successionOpen, setSuccessionOpen] = useState(false)
  // where Esc goes back to from a screen opened from Home or from the chat
  const [origin, setOrigin] = useState<'home' | 'chat'>(start === 'chat' ? 'chat' : 'home')
  const go = useCallback(
    (next: Screen) => {
      if (screen === 'home' || screen === 'chat') setOrigin(screen)
      setScreen(next)
    },
    [screen],
  )
  const [manageAt, setManageAt] = useState(0)
  // the plugin view the screen `view` shows (opened from Home's menu)
  const [viewTarget, setViewTarget] = useState<{ viewId: string; label: string } | undefined>()
  const [turn, setTurn] = useState<TurnState>(IDLE_TURN)
  const [typing, setTyping] = useState(false)
  const onDraftChange = useCallback((draft: string) => setTyping(draft !== ''), [])
  const trace = useRef<BrainTrace | null>(null)
  trace.current ??= new BrainTrace()
  const brainTrace = trace.current
  const [notice, setNotice] = useState<ChatNotice | undefined>()
  const [showBrain, setShowBrain] = useState(true)
  const [showTasks, setShowTasks] = useState(true)
  const [sidebarPref, setSidebarPref] = useState<boolean | undefined>()
  const [chatBusy, setChatBusy] = useState(false)
  const theme = useTheme()
  const { orbStatic } = useMotion()
  const [cellAspect, setCellAspect] = useState(aspectProp)
  // the orb flying between Home and the chat header (a few frames; never holds a key)
  const [flight, setFlight] = useState<FlightDirection | undefined>()
  const endFlight = useCallback(() => setFlight(undefined), [])

  const brain = useBrain(tuning)
  const tasks = useTasks(client)
  const nodes = useNodes(client)
  const stepUp = useStepUp(client)
  const approvals = useApprovals(client, stepUp.guard)
  const budget = useBudget(client, budgetPollMs)
  const connection = useConnection(client)
  // while the link is down every screen that needs the core is inactive (features/activity/offline.tsx)
  const offline = useLinkValue(
    connection,
    shorten(core),
    (rows) => setNotice({ level: 'info', rows }),
    () => setNotice(undefined),
  )
  const { identity, reload: reloadIdentity } = useWhoami(client)
  // the first-login notice: a panel over Home's orb until `enter` (never blocks the app)
  const privacy = usePrivacyNotice(client)
  const loggedOut = connection.loggedOut || identity.status === 'logged-out'
  const { push } = useToast()
  const toast = useCallback((text: string, level: ToastLevel) => void push(text, { level }), [push])
  // a `/new` or `/compact` in progress: this TUI's own and the person's (the feed), for the chat's row and held sends
  const contextPending = useContextPending(
    client,
    identity.status === 'ready' ? identity.me.personId : undefined,
  )
  // a memory dream in progress and its dividers (the chat's line and divider; the Home caption's `dreaming…`)
  const dream = useDreamActivity(
    client,
    identity.status === 'ready' ? identity.me.personId : undefined,
  )
  // the rooms: the banner, the invitation, the room view and `/room` (features/room)
  const roomApp = useRoomApp({
    client,
    me: identity.status === 'ready' && !loggedOut ? identity.me.personId : undefined,
    toast,
    say: (level, rows) => setNotice({ level, rows: [...rows] }),
    showRoom: () => go('room'),
    goHome: () => setScreen('home'),
  })
  // the heir's line under the orb (grace or claimable); a member who is neither gets nothing
  const heir = useHeirSuccession(
    client,
    identity.status === 'ready' && !loggedOut && identity.me.role !== 'owner',
  )
  const viewMenu = useViewMenu(client, {
    ready: identity.status === 'ready' && !loggedOut,
    refreshKey: connection.kind,
  })
  // the local socket idle-locked itself (423): the owner's PIN opens it (Home's unlock panel)
  const locked = identity.status === 'locked'
  const role = identity.status === 'ready' ? identity.me.role : undefined
  const isMember = role !== undefined && role !== 'owner'
  const stepUpOpen = stepUp.prompt !== undefined
  const [barFocus, setBarFocus] = useState(false)
  const { reload: reloadNodes } = nodes
  const touch = usePresenceTouch()
  useAppFeed({
    client,
    trace,
    push: brain.push,
    resyncBrain: brain.resync,
    applyTask: tasks.apply,
    applyNode: nodes.apply,
    reloadTasks: tasks.reload,
    reloadNodes,
    reloadBudget: budget.reload,
    reloadIdentity,
    connection: connection.kind,
  })

  // the chat has nothing to show while locked: Home carries the unlock panel
  useEffect(() => {
    if (locked && screen !== 'home' && screen !== 'login') setScreen('home')
  }, [locked, screen])

  const { health, roles } = useCoreFacts(client)

  // the dialog keeps the keys only while it is on screen (chat or Home) with something to answer
  const barHasKeys =
    barFocus &&
    (screen === 'chat' || screen === 'home') &&
    approvals.answerable.length > 0 &&
    !stepUpOpen
  const layout = layoutOf(width, {
    rows,
    sidebar: screen === 'manage' || screen === 'home' ? false : sidebarPref,
  })
  // the header replaces the status line and the Brain panel on the chat; the orb flies to it
  const framed = isFramed(screen)
  const headerOn = header && layout.header && screen === 'chat'
  // `--disable-orb`: the orb does not fly; the screens switch at once
  const flies = header && layout.header && theme.depth !== 'none' && !orbStatic
  const kitty = useSyncExternalStore(kittyKeys.subscribe, kittyKeys.get)
  const stopRef = useRef<(() => void) | undefined>(undefined)
  const sendRef = useRef<((text: string) => void) | undefined>(undefined)
  // a `/command` typed in Home's quick ask: the chat opens first, the command runs on that screen
  const [askCommand, setAskCommand] = useState<string | undefined>()
  const { canSwitch, guest, openLogin, openLogout, signedIn, signedOut, quit } = sessionActionsOf({
    client,
    core,
    swappable,
    switchConnection,
    enterGuest,
    guestFetch,
    configPath,
    origin,
    go,
    setScreen,
    openLogoutPanel: () => {
      setLogoutOpen(true)
      setScreen('home')
    },
    say: setNotice,
  })
  const goHome = useCallback(() => {
    setScreen('home')
    if (flies) setFlight('out')
  }, [flies])
  useAppKeys({
    screen,
    origin,
    chatBusy,
    barHasKeys,
    stepUpOpen,
    loggedOut,
    sidebarHidden: layout.sidebar === 0,
    setScreen,
    goHome,
    openLogin,
    setCellAspect,
    setSidebarPref,
    toggleTasks: () => setShowTasks((v) => !v),
    touch,
  })

  // an `open.view` delivery opens the plugin view or the Tasks screen it names; anything else is `unsupported`
  usePresenceViewOpener((name) => {
    const target = openTargetOf(name, viewMenu.items)
    if (target === undefined) return false
    if (target.kind === 'tasks') {
      go('tasks')
    } else {
      setViewTarget({ viewId: target.viewId, label: target.label })
      go('view')
    }
    return true
  })

  // members get no node events: read the list again when the screen opens and while the sidebar shows it
  const sidebarShown = layout.sidebar > 0
  useEffect(() => {
    if (screen === 'nodes' || screen === 'manage') reloadNodes()
  }, [screen, reloadNodes])
  useEffect(() => {
    if (!isMember || !sidebarShown) return undefined
    const timer = setInterval(reloadNodes, nodesPollMs)
    return () => clearInterval(timer)
  }, [isMember, sidebarShown, reloadNodes, nodesPollMs])

  const command = (line: string) =>
    runCommand(line, {
      exit: () => quit(exit),
      go,
      resetManage: () => setManageAt(0),
      openLogin,
      openLogout,
      toggleBrain: () => setShowBrain((v) => !v),
      openSuccession: () => {
        setSuccessionOpen(true)
        setScreen('home')
      },
      say: (level, noticeRows) => setNotice({ level, rows: noticeRows }),
      clearNotice: () => setNotice(undefined),
      isMember,
      identity,
      core,
      health,
      roles,
      stepUp,
      offline: offline?.reason,
      mouse,
      setStatus: (input) => client.rpc.presence.setStatus(input),
      room: roomApp.command,
      dream: (args) =>
        runDreamCommand(parseDreamCommand(args), {
          dreaming: client.dreaming,
          say: (level, rows) => setNotice({ level, rows: [...rows] }),
          toast,
          // on the chat screen the outcome is the chat's divider, so no toast repeats it
          ...(screen === 'chat'
            ? { inChat: { finish: dream.finish, refused: dream.refused } }
            : {}),
        }),
      context: (name, args) =>
        runContextCommand(parseContextCommand(name, args), {
          chatContext: client.chatContext,
          toast,
          say: (level, rows) => setNotice({ level, rows: [...rows] }),
          pending: contextPending,
        }),
      persona: (args) =>
        runPersonaCommand(parsePersonaCommand(args), {
          isMember,
          persona: client.persona,
          guard: stepUp.guard,
          say: (level, rows) => setNotice({ level, rows: [...rows] }),
          toast,
          openStyle: () => go('me'),
          openEdit: () => {
            // the Persona section's place in the sections the role may read (the owner's list)
            const at =
              identity.status === 'ready'
                ? visibleSections(SECTIONS, capsOf(identity.me)).findIndex(
                    (s) => s.id === 'persona',
                  )
                : -1
            setManageAt(Math.max(0, at))
            go('manage')
          },
        }),
    })

  useEffect(() => {
    if (askCommand === undefined || screen !== 'chat') return
    setAskCommand(undefined)
    command(askCommand)
  })

  if (!layout.supported) {
    return (
      <Box paddingLeft={GUTTER} paddingTop={1}>
        <Txt tone="muted">keith needs at least {MIN_COLUMNS} columns</Txt>
      </Box>
    )
  }

  const target = shorten(core)
  // the blank row under the legend; the first to go when rows are tight
  const margin = layout.footer ? 1 : 0
  const counts = countNodes(nodes.nodes)
  const running = tasks.tasks.filter(isActive).length

  const status = statusOf({
    loggedOut,
    identityError: identity.status === 'error',
    connection,
    target,
    elevatedUntil: stepUp.elevatedUntil,
  })
  const connectionKind = status.connection

  const hints = hintsOf({
    stepUpOpen,
    barHasKeys,
    notReady: loggedOut || identity.status !== 'ready',
    approvalsWaiting: approvals.answerable.length > 0,
    chatBusy,
    kitty,
  })

  const failed = approvalsError(approvals)
  const stripNode = layout.strip ? (
    <ActivityStrip
      cortex={brain.state.cortexActive.length}
      running={running}
      online={counts.online}
      total={counts.total}
    />
  ) : undefined
  const above = ChatAbove({
    approvals,
    stepUp,
    stepUpHere: stepUpOpen && screen === 'chat',
    barHasKeys,
    onBarFocus: setBarFocus,
    failed,
    strip: stripNode,
    width: layout.left,
  })
  const mode = orbModeOf({
    alert: loggedOut || identity.status === 'error' || connectionKind === 'offline',
    busy: turn.busy,
    speaking: turn.speaking,
    typing,
  })

  const blockDetail = identity.status === 'error' ? identity.message : undefined
  // the one problem panel of Home and the chat, inside the same margins as the dialogs
  const authPanel = (kind: 'logged-out' | 'core-down', detail?: string) => (
    <Box paddingLeft={GUTTER}>
      <AuthPanel
        kind={kind}
        rows={authRows(kind, target, detail)}
        width={Math.max(10, layout.left - GUTTER * 2)}
      />
    </Box>
  )
  // with the sidebar the chat view owns the upper area (header and conversation left, sidebar right)
  // so the input's rules and the legend span the whole terminal under it
  const inChat = layout.sidebar > 0 && identity.status === 'ready' && !standalone
  // the input sits between two bare rules; the one legend is its own row below them
  const legend = <FooterRow fallback={hints} width={inChat ? layout.left : width} />
  const headInChat = inChat && headerOn
  // beside the conversation the sidebar spans the header rows too; the input band, two rules, the
  // legend and the two blank rows above the top rule stay below it. Without the chat view (no
  // session yet) it sits under the header as before.
  // wide mode: the orb and the wave graph head the sidebar, the header keeps its title row
  const orbSide = headerOn && layout.orbInSidebar
  const box = sidebarBox(layout, { rows, margin, headerOn, inChat })
  const sidebar =
    layout.sidebar > 0 ? (
      <SidebarColumn
        top={box.top}
        width={layout.sidebar}
        height={box.height}
        view={brain.view}
        brain={brain.state}
        waiting={approvals.items.length}
        tasks={tasks.tasks}
        nodes={nodes.nodes}
        showBrain={showBrain && (!headerOn || orbSide)}
        showTasks={showTasks}
        {...(orbSide
          ? { orb: { mode, trace: trace.current, cellAspect, running: flight === undefined } }
          : {})}
      />
    ) : undefined
  // the flight starts and ends where the chat's orb is (the sidebar's top in the wide mode), also
  // while Home is the screen on view and hides the sidebar
  const flightChat = chatOrbBox(width, {
    rows,
    sidebarPref: screen === 'manage' ? false : sidebarPref,
    header,
    margin,
    cellAspect,
    showBrain,
    showTasks,
  })
  const headerWidth = (w: number) => (
    <ChatHeader
      variant={layout.orbInSidebar ? 'title' : 'orb'}
      cellAspect={cellAspect}
      mode={mode}
      trace={brainTrace}
      width={w}
      running={flight === undefined}
      status={status}
    />
  )
  const main = (
    <ChatMain
      client={client}
      identity={identity}
      layout={layout}
      width={width}
      contextPending={pendingKindOf(contextPending)}
      compacted={contextPending.compacted}
      dream={dream}
      standalone={standalone}
      onChat={screen === 'chat'}
      keysTaken={barHasKeys || stepUpOpen}
      loggedOut={loggedOut}
      inChat={inChat}
      veiled={headInChat && flight !== undefined}
      head={headInChat ? headerWidth(layout.left) : null}
      loggedOutPanel={authPanel('logged-out')}
      noSession={
        identity.status === 'logged-out'
          ? authPanel('logged-out')
          : authPanel('core-down', blockDetail)
      }
      above={screen === 'home' ? undefined : above}
      legend={legend}
      side={sidebar}
      stopRef={stopRef}
      sendRef={sendRef}
      notice={notice}
      tasks={tasks.tasks}
      roles={roles}
      tabCompletes={approvals.answerable.length === 0}
      onCommand={command}
      onSend={() => {
        setNotice(undefined)
        touch()
      }}
      onBusyChange={setChatBusy}
      onTurn={setTurn}
      onDraftChange={onDraftChange}
    />
  )

  // esc and ctrl+g both end at Home: a view is always opened from there
  const goHomeFromView = () => setScreen('home')
  const openFromHome = (menu: MenuTarget) => {
    if (menu.kind === 'section') {
      setManageAt(menu.index)
      return go('manage')
    }
    if (menu.kind === 'logout') return openLogout()
    if (menu.kind === 'view') {
      setViewTarget({ viewId: menu.viewId, label: menu.label })
      return go('view')
    }
    go(menu.kind)
  }

  const panel = homePanelOf({
    locked,
    loggedOut,
    canSwitch,
    standalone,
    core,
    swappable,
    switchConnection,
    configPath,
    signInTuning,
    signedIn,
    guest,
    logout: logoutOpen
      ? {
          client,
          onDone: () => {
            setLogoutOpen(false)
            signedOut()
          },
          onCancel: () => {
            setLogoutOpen(false)
            setScreen(origin)
          },
        }
      : undefined,
    succession: successionOpen
      ? {
          client,
          guard: stepUp.guard,
          onClaimed: () => {
            setSuccessionOpen(false)
            // the core revoked both sessions (a hand-over's transfer): sign this device out as /logout does (a 401
            // from the revoke is fine), then Home opens signed out with the sign-in panel and the notice
            void signOut(client, configPath, core).finally(() => signedOut())
          },
          onClose: () => setSuccessionOpen(false),
        }
      : undefined,
    privacy:
      privacy.state.status === 'show'
        ? { text: privacy.state.text, onAck: privacy.ack }
        : undefined,
  })

  return (
    <LinkProvider value={offline}>
      <FooterProvider>
        <OfflineKeys />
        {flight !== undefined && (
          <OrbFlight
            direction={flight}
            columns={width}
            rows={rows}
            cellAspect={cellAspect}
            mode={mode}
            {...(flightChat === undefined ? {} : { chat: flightChat })}
            onDone={endFlight}
          />
        )}
        {screen === 'home' && trace.current !== null && (
          <Box display={flight === undefined ? 'flex' : 'none'} flexDirection="column">
            <HomeHost
              {...(motion === undefined ? {} : { motion })}
              width={width}
              rows={rows}
              cellAspect={cellAspect}
              trace={trace.current}
              connection={connectionKind}
              identity={identity}
              loggedOut={loggedOut}
              standalone={standalone}
              target={target}
              health={health}
              roles={roles}
              budget={budget.budget}
              nodes={nodes.nodes}
              tasks={tasks.tasks}
              brain={brain.state}
              dreaming={dream.running !== undefined}
              turn={turn}
              typing={typing}
              notice={notice}
              failed={failed}
              stepUp={stepUp}
              approvals={approvals}
              barHasKeys={barHasKeys}
              onBarFocus={setBarFocus}
              onChat={() => {
                setScreen('chat')
                if (flies) setFlight('in')
              }}
              onLogin={openLogin}
              locked={locked}
              panel={panel}
              heir={heir.view}
              onAsk={(text) => sendRef.current?.(text)}
              onAskCommand={(line) => {
                setAskCommand(line)
                setScreen('chat')
                if (flies) setFlight('in')
              }}
              onStop={() => stopRef.current?.()}
              onOpen={openFromHome}
              views={viewMenu.items.map((i) => ({ viewId: i.viewId, label: i.label }))}
              banner={roomApp.banner}
              invite={
                roomApp.invite === undefined
                  ? undefined
                  : { notice: roomApp.invite, onAccept: roomApp.accept, onDecline: roomApp.decline }
              }
            />
          </Box>
        )}
        <AppScreens
          screen={screen}
          client={client}
          me={identity.status === 'ready' ? identity.me : undefined}
          stepUp={stepUp}
          nodes={nodes}
          width={width}
          rows={rows}
          status={status}
          loggedOut={loggedOut}
          manageAt={manageAt}
          onLeaveManage={() => (standalone ? exit() : setScreen(origin))}
        />
        {(screen === 'login' || screen === 'logout') && (
          <SessionScreens
            screen={screen}
            client={client}
            core={core}
            configPath={configPath}
            tuning={signInTuning}
            width={width}
            onCancel={() => setScreen(origin)}
            onSignedIn={signedIn}
            onSignedOut={signedOut}
          />
        )}
        {screen === 'history' && (
          <HistoryScreen
            client={client}
            width={width}
            rows={rows}
            status={status}
            onClose={() => setScreen(origin)}
          />
        )}
        {screen === 'view' && viewTarget !== undefined && (
          <PluginViewScreen
            client={client}
            view={viewTarget}
            width={width}
            rows={rows}
            status={status}
            onLeave={goHomeFromView}
            onHome={goHomeFromView}
          />
        )}
        {framed && (
          <FramedScreens
            screen={screen}
            client={client}
            role={role}
            stepUp={stepUp}
            tasks={tasks}
            nodes={nodes}
            budget={budget.budget}
            brain={brain.state}
            width={width}
            rows={rows}
            status={status}
            onBack={() =>
              setScreen(screen === 'room' ? 'home' : screen === 'memory' ? 'me' : origin)
            }
            onMemory={() => go('memory')}
            room={
              roomApp.target === undefined
                ? undefined
                : {
                    roomId: roomApp.target.roomId,
                    ask: roomApp.target.ask,
                    me: identity.status === 'ready' ? identity.me.personId : undefined,
                  }
            }
          />
        )}
        <ChatFrame
          width={width}
          rows={rows}
          hidden={
            screen === 'home' ||
            framed ||
            screen === 'manage' ||
            screen === 'login' ||
            screen === 'logout' ||
            screen === 'view' ||
            screen === 'history' ||
            flight !== undefined
          }
          headerOn={headerOn}
          headInChat={headInChat}
          header={headerWidth(width)}
          status={status}
          margin={margin}
          main={main}
          sidebar={inChat ? null : sidebar}
          banner={
            roomApp.banner === undefined ? undefined : (
              <RoomBannerRow banner={roomApp.banner} width={layout.left} />
            )
          }
        />
      </FooterProvider>
    </LinkProvider>
  )
}
