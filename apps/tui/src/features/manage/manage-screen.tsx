import type { KeithClient } from '@keith/client'
import type { Whoami } from '@keith/contracts'
import {
  GUTTER,
  type Hint,
  NavList,
  SCREEN_CHROME_ROWS,
  ScreenFrame,
  type StatusInfo,
  TwoPane,
  Txt,
} from '@keith/ui'
import { useMemo, useState } from 'react'
import { offlineHints, useGuardedInput as useInput, useLink } from '../activity/index.ts'
import type { Nodes } from '../nodes/index.ts'
import type { StepUp } from '../stepup/index.ts'
import { NAV_HINTS } from './legend.ts'
import {
  capsOf,
  NAV_WIDTH,
  type Nav,
  type NavKey,
  navReduce,
  TWO_PANE_COLUMNS,
  visibleSections,
} from './manage-state.ts'
import type { ManageEnv } from './manage-types.ts'
import { SectionHost } from './section-host.tsx'
import { MANAGE_SECTIONS } from './sections.ts'

export interface ManageScreenProps {
  client: KeithClient
  me: Whoami
  guard: StepUp['guard']
  nodes: Nodes
  /** Width and rows of the whole screen, margins and title row included (it is a `ScreenFrame`). */
  width: number
  height: number
  /** The connection and countdown of the title row. */
  status?: StatusInfo
  /** On screen, and not covered by the step-up prompt. */
  active: boolean
  /** The section the screen opens on (an index in the sections the role may read; default 0). */
  initialSection?: number
  /** Esc from the top level: back to the chat, or quit when `keith manage` opened it. */
  onClose(): void
}

/**
 * `/manage` and `keith manage`: the sections a role may read, a section list on the left (100
 * columns or more) or one pane with a switcher below, and the actions of each section. Every
 * action is a procedure `keith-core` also calls; the server decides again what a role may do.
 */
export function ManageScreen({
  client,
  me,
  guard,
  nodes,
  width,
  height,
  active,
  status,
  initialSection = 0,
  onClose,
}: ManageScreenProps) {
  const caps = useMemo(() => capsOf(me), [me])
  const sections = useMemo(() => visibleSections(MANAGE_SECTIONS, caps), [caps])
  const [nav, setNav] = useState<Nav>({ section: initialSection, pane: 'nav' })
  const wide = width >= TWO_PANE_COLUMNS
  const pane = wide ? nav.pane : 'content'
  const section = sections[Math.min(nav.section, sections.length - 1)]
  const env: ManageEnv = { client, guard, me, caps, nodes }

  const press = (key: NavKey): void =>
    setNav((n) => navReduce(wide ? n : { ...n, pane: 'content' }, key, sections.length, wide))
  useInput(
    (_input, key) => {
      if (key.escape) return onClose()
      if (key.upArrow) return press('up')
      if (key.downArrow) return press('down')
      if (key.return) return press('enter')
      if (key.rightArrow) return press('right')
      if (key.tab) return press('tab')
    },
    { isActive: active && wide && pane === 'nav' },
  )
  const [sectionLegend, setSectionLegend] = useState<readonly Hint[]>([])
  const link = useLink()
  const shown = pane === 'content' ? sectionLegend : NAV_HINTS
  const legend = link === undefined ? shown : offlineHints(shown)
  const frameProps = {
    width,
    height,
    label: 'Manage',
    ...(status === undefined ? {} : { status }),
  }
  if (section === undefined)
    return (
      <ScreenFrame {...frameProps} legend={[{ key: 'esc', action: 'back' }]}>
        <Txt tone="muted">Nothing here for your role.</Txt>
      </ScreenFrame>
    )

  const at = sections.indexOf(section)
  const inner = width - GUTTER
  const rows = height - SCREEN_CHROME_ROWS
  const paneWidth = wide ? inner - NAV_WIDTH - 1 : inner
  const shared = {
    env,
    width: paneWidth,
    height: rows,
    count: `${at + 1}/${sections.length}`,
    ...(me.role === 'owner' ? {} : { bottom: me.role }),
    wide,
    focus: pane === 'content',
    active,
    onLegend: setSectionLegend,
    onNav: press,
    onClose,
  }
  const host =
    'pane' in section ? (
      <section.pane key={section.id} {...shared} />
    ) : (
      <SectionHost key={section.id} section={section} {...shared} />
    )
  return (
    <ScreenFrame {...frameProps} legend={legend}>
      {wide ? (
        <TwoPane
          side={
            <NavList
              items={sections.map((s) => ({ id: s.id, label: s.title }))}
              current={at}
              focused={pane === 'nav'}
              width={NAV_WIDTH}
            />
          }
          sideWidth={NAV_WIDTH}
          width={inner}
          framed={false}
        >
          {host}
        </TwoPane>
      ) : (
        host
      )}
    </ScreenFrame>
  )
}
