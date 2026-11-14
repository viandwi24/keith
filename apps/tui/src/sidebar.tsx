import type { Node, Task } from '@keith/contracts'
import { Box } from 'ink'
import type { RegionView } from './features/brain/brain-state.ts'
import { BrainPanel, type BrainState } from './features/brain/index.ts'
import { NodesPanel } from './features/nodes/index.ts'
import { TasksPanel } from './features/tasks/index.ts'
import {
  SIDEBAR_GRAPH_ROWS,
  SIDEBAR_ORB_MIN_ROWS,
  SidebarHead,
  type SidebarOrb,
} from './sidebar-head.tsx'

/** Rows of the Brain panel frame: top border, six lamp rows (eleven regions in two columns), the latest event, bottom border. */
export const BRAIN_ROWS = 9
const NODES_MAX = 6
/** A Tasks frame needs its two borders and two rows between them. */
const TASKS_MIN = 4

/** Rows kept for Nodes under the orb whatever the node count (two borders and two nodes), so the orb never resizes when a node appears. */
const NODES_RESERVE = 4

/** The orb is as tall as it is wide (round at the cell aspect): `columns * cellAspect` rows, at most this many. */
const ORB_MAX_ROWS = 20

/** Most rows the orb wants in a sidebar `width` columns wide: its diameter fills the column. */
export function orbMaxRows(width: number, cellAspect: number): number {
  return Math.max(SIDEBAR_ORB_MIN_ROWS, Math.min(ORB_MAX_ROWS, Math.floor(width * cellAspect)))
}

/**
 * Rows of the orb at the top of the sidebar: the largest that fits `max` (the column's width) and
 * the rows left under orb, graph, Brain, Tasks (4) and two nodes. 0 when even the smallest does not
 * fit: the orb then stays in the chat header. At 40 rows (a column of 32) it is 8 rows, at 44 rows
 * 12, at 45 rows 13, and a 40-column sidebar gets 18 rows from 50 rows (as wide as the column allows).
 */
export function orbRowsFor(
  height: number,
  { max, brain, tasks }: { max: number; brain: boolean; tasks: boolean },
): number {
  const fixed =
    (brain ? SIDEBAR_GRAPH_ROWS + BRAIN_ROWS : 0) + (tasks ? TASKS_MIN : 0) + NODES_RESERVE
  const rows = Math.min(max, height - fixed)
  return rows >= SIDEBAR_ORB_MIN_ROWS ? rows : 0
}

export interface SidebarPlan {
  /** Rows of the orb at the top (0: the orb is not in the sidebar). */
  orb: number
  /** Rows of the wave graph frame under the orb. */
  graph: number
  brain: number
  tasks: number
  nodes: number
}

/**
 * How many rows each panel frame gets, borders included (0 hides it): Brain is fixed at 9, Nodes
 * takes up to 6, Tasks the rest and at least 4. Frames sit directly on each other. When Tasks
 * would get less than 4 rows, Nodes gives its place up.
 *
 * With `orb` (the wide mode) the column reads orb (`orbRowsFor`: 8 rows or more), wave graph (7), Brain
 * (9), Tasks, Nodes. The orb is never drawn partially: when it, the graph, Brain, 4 rows of Tasks and
 * two nodes do not fit (under a 31-row column), the plan is the one without the orb (`orb: 0`) and
 * the orb stays in the chat header.
 */
export function planSidebar(
  height: number,
  {
    brain,
    tasks,
    nodeRows,
    orb,
  }: {
    brain: boolean
    tasks: boolean
    nodeRows: number
    /** The wide mode: the most rows the orb wants (`orbMaxRows`). */
    orb?: number
  },
): SidebarPlan {
  const size = orb === undefined ? 0 : orbRowsFor(height, { max: orb, brain, tasks })
  const head = size + (brain ? SIDEBAR_GRAPH_ROWS + BRAIN_ROWS : 0)
  const inOrb = size > 0
  const orbRows = size
  const graphRows = inOrb && brain ? SIDEBAR_GRAPH_ROWS : 0
  const used = inOrb ? head : 0
  // the Brain panel gives way when the Tasks panel would not fit beside it (short terminals)
  const brainRows = inOrb
    ? brain
      ? BRAIN_ROWS
      : 0
    : brain && height >= BRAIN_ROWS + TASKS_MIN
      ? BRAIN_ROWS
      : 0
  let nodes = Math.min(NODES_MAX, 2 + Math.max(1, nodeRows))
  let rest = height - (inOrb ? used : brainRows) - nodes
  if (tasks && rest < TASKS_MIN) {
    nodes = 0
    rest = height - (inOrb ? used : brainRows)
  }
  return {
    orb: orbRows,
    graph: graphRows,
    brain: brainRows,
    tasks: tasks ? Math.max(TASKS_MIN, rest) : 0,
    nodes,
  }
}

export interface SidebarProps {
  width: number
  /** Rows between the header block and the footer. */
  height: number
  view: readonly RegionView[]
  brain: BrainState
  waiting: number
  tasks: readonly Task[]
  nodes: readonly Node[]
  showBrain: boolean
  showTasks: boolean
  /** The wide mode: the orb and the wave graph on top. Left out, the orb is in the chat header. */
  orb?: SidebarOrb
}

/** The right column: [orb] [wave graph] Brain, Tasks and Nodes frames stacked, nothing painted. */
export function Sidebar({
  width,
  height,
  view,
  brain,
  waiting,
  tasks,
  nodes,
  showBrain,
  showTasks,
  orb,
}: SidebarProps) {
  const live = nodes.filter((n) => n.status !== 'revoked').length
  const plan = planSidebar(height, {
    brain: showBrain,
    tasks: showTasks,
    nodeRows: live,
    ...(orb === undefined ? {} : { orb: orbMaxRows(width, orb.cellAspect) }),
  })
  // a frame's two sides and one column of padding on each side come off the width
  const cell = Math.floor((width - 4) / 2)
  return (
    <Box width={width} height={height} overflow="hidden" flexDirection="column" flexShrink={0}>
      {orb !== undefined && plan.orb > 0 && (
        <SidebarHead orb={orb} width={width} rows={plan.orb} graph={plan.graph > 0} />
      )}
      {plan.brain > 0 && (
        <BrainPanel view={view} state={brain} waiting={waiting} cell={cell} width={width} />
      )}
      {plan.tasks > 0 && <TasksPanel tasks={tasks} rows={plan.tasks} width={width} />}
      {plan.nodes > 0 && <NodesPanel nodes={nodes} rows={plan.nodes} width={width} />}
    </Box>
  )
}
