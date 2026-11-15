import {
  type BrainState,
  FADE_MS,
  initialBrain,
  mergeNodes,
  mergeTasks,
  nodeChangedOf,
  type RegionView,
  reduceBrain,
  regionOf,
  resyncBrain,
  strengthOf,
  taskChangedOf,
  viewOf,
} from '@keith/app-model'
import { brainEventOf, type KeithClient } from '@keith/client/browser'
import type { BudgetStatus, Node, Task } from '@keith/contracts'
import { BrainTrace } from '@keith/ui/orb'
import { getClient } from '../session/index.ts'

const POLL_MS = 60_000
const LAMP_TICK_MS = 300
const TRACE_TICK_MS = 100

/**
 * What the core says is going on, from the activity feed: brain events (lamps, trace, dreaming), tasks, nodes and the budget.
 * One store for Home and the inspector. The feed sends no history, so listeners are added before the feed starts and every
 * resync reads the lists again.
 */
class Live {
  brain = $state.raw<BrainState>(initialBrain)
  tasks = $state.raw<readonly Task[]>([])
  nodes = $state.raw<readonly Node[]>([])
  budget = $state.raw<BudgetStatus | undefined>(undefined)
  /** The clock of the lamp fade (epoch ms). */
  now = $state(Date.now())
  /** The brain wave. Home steps it every frame (`driveTrace`); otherwise a coarse timer keeps its energy decaying. */
  readonly trace = new BrainTrace()
  driveTrace = false

  lamps: RegionView[] = $derived(viewOf(this.brain, this.now, FADE_MS))
  dreaming = $derived(this.brain.dreaming !== undefined)

  private client: KeithClient | undefined
  private offs: (() => void)[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private touchedNodes = new Map<string, Node>()
  private nodeReads = 0

  start(): void {
    if (this.client !== undefined) return
    const client = getClient()
    this.client = client
    const feed = client.feed()
    this.offs.push(
      feed.subscribeEvents((record) => {
        const event = brainEventOf(record)
        if (event !== undefined) {
          this.brain = reduceBrain(this.brain, event, Date.now())
          this.trace.fire(regionOf(event), strengthOf(event))
        }
        const task = taskChangedOf(record)
        if (task !== undefined) this.tasks = mergeTasks(this.tasks, [task])
        const node = nodeChangedOf(record)
        if (node !== undefined) this.applyNode(node)
        if (record.type === 'budget-changed') this.readBudget()
      }),
      feed.subscribeResync(() => {
        this.brain = resyncBrain(this.brain)
        this.reload()
      }),
    )
    this.timers.push(
      setInterval(() => {
        this.now = Date.now()
      }, LAMP_TICK_MS),
      setInterval(() => {
        if (!this.driveTrace && !document.hidden) this.trace.step(TRACE_TICK_MS / 1000)
      }, TRACE_TICK_MS),
      setInterval(() => this.readBudget(), POLL_MS),
    )
    this.reload()
  }

  stop(): void {
    for (const off of this.offs) off()
    for (const timer of this.timers) clearInterval(timer)
    this.offs = []
    this.timers = []
    this.client = undefined
    this.brain = initialBrain
    this.tasks = []
    this.nodes = []
    this.budget = undefined
  }

  reload(): void {
    const client = this.client
    if (client === undefined) return
    void client.rpc.tasks.list({ limit: 20 }).then(
      (rows) => {
        this.tasks = mergeTasks(this.tasks, rows)
      },
      () => undefined,
    )
    this.nodeReads += 1
    this.touchedNodes = new Map()
    void client.rpc.nodes
      .list()
      .then(
        (rows) => {
          this.nodes = mergeNodes(rows, this.touchedNodes)
        },
        () => undefined, // a person without access to the registry sees no nodes
      )
      .finally(() => {
        this.nodeReads -= 1
        if (this.nodeReads === 0) this.touchedNodes = new Map()
      })
    this.readBudget()
  }

  private applyNode(node: Node): void {
    if (this.nodeReads > 0) this.touchedNodes.set(node.id, node)
    this.nodes = mergeNodes(
      this.nodes.filter((n) => n.id !== node.id),
      new Map([[node.id, node]]),
    )
  }

  private readBudget(): void {
    void this.client?.rpc.budget.get().then(
      (budget) => {
        this.budget = budget
      },
      () => undefined,
    )
  }
}

export const live = new Live()
