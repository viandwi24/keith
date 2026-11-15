// Every tool of the front agent and of the workers declares where its result comes from (ADR-0036 §3, docs/specs/amygdala.md
// "Consent"): a Keith-owned tool must carry `metadata.source`; a tool of eharness is known by name (`@keith/eh-ext`); anything else counts
// as `outside`. The agents are built with their real plugins over stub collaborators and every plugin is resolved with `resolvePlugin`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaresSource, EHARNESS_TOOL_TRAITS, toolReversible, toolSource } from '@keith/eh-ext'
import type { HarnessAgent, HarnessPlugin } from 'eharness'
import { inMemoryMessages, inMemoryState } from 'eharness/storage/memory'
import { resolvePlugin } from 'eharness/testing'
import { createConsent, createUndoPlugin } from './modules/amygdala/index.ts'
import { createRoomPostPlugin } from './modules/corpus-callosum/index.ts'
import { createCortex } from './modules/cortex/index.ts'
import { protocolToolSlot } from './modules/hypothalamus/tools.ts'
import { clientCallTool, presenceTool } from './modules/parietal/index.ts'
import { createPersonaToolsPlugin } from './modules/prefrontal/index.ts'
import { createModelToolsPlugin } from './modules/providers/index.ts'
import { createFrontAgent } from './modules/wernicke-broca/index.ts'
import { createUndoLog } from './platform/undo-log.ts'

interface Row {
  agent: string
  plugin: string
  tool: string
  risk: unknown
  source: string
  reversible: boolean
  declared: boolean
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'keith-tool-sources-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const stub = {} as never

/** Resolves every plugin of an agent and lists its tools; a plugin that cannot resolve alone is listed apart. */
async function inventory(label: string, agent: HarnessAgent) {
  const plugins = (agent.config as unknown as { plugins: HarnessPlugin[] }).plugins
  const rows: Row[] = []
  const unresolved: string[] = []
  for (const plugin of plugins) {
    try {
      const resolved = await resolvePlugin(plugin, {
        plugins: plugins.filter((p) => p !== plugin),
        ctx: { principal: { id: 'owner' } },
      })
      for (const [tool, def] of Object.entries(resolved.tools)) {
        const metadata = (def as { metadata?: unknown }).metadata
        rows.push({
          agent: label,
          plugin: plugin.name,
          tool,
          risk: (metadata as { risk?: unknown } | undefined)?.risk,
          source: toolSource(metadata, tool),
          reversible: toolReversible(metadata),
          declared: declaresSource(metadata),
        })
      }
    } catch (error) {
      unresolved.push(`${plugin.name}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return { rows, unresolved }
}

const consent = createConsent()
const undo = createUndoLog()

function build() {
  let lead: HarnessAgent | undefined
  const nodes = { list: () => [], find: () => undefined } as never
  const cortex = createCortex({
    providers: { catalog: () => [] } as never,
    storage: { messages: inMemoryMessages(), state: inMemoryState(), inbox: stub },
    consent: consent.plugin('worker'),
    store: stub,
    tasks: stub,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    lead: () => lead as HarnessAgent,
    nodes,
    dataDir: dir,
    timezone: 'UTC',
    inboxPollMs: 20,
  })
  const front = createFrontAgent({
    providers: { catalog: () => [] } as never,
    storage: { messages: inMemoryMessages(), state: inMemoryState(), inbox: stub },
    personaTools: createPersonaToolsPlugin({ persona: stub, styles: stub, undo }),
    modelTools: createModelToolsPlugin({
      providers: stub,
      audit: stub,
      isOwner: async () => true,
      undo,
    }),
    undoTool: createUndoPlugin(undo),
    consent: consent.plugin('front'),
    presence: presenceTool({
      parietal: {
        disclosedFor: async () => ({ level: 'none', line: null }),
        setStatus: stub,
        status: stub,
      },
      people: stub,
      actors: stub,
      undo,
    }),
    clientCall: clientCallTool({ parietal: stub, actors: stub }),
    protocolTools: protocolToolSlot(stub).plugin,
    roomPost: createRoomPostPlugin({ rooms: stub, service: stub }),
    dataDir: dir,
    delegation: { cortex, tasks: stub, store: stub, self: () => lead as HarnessAgent, nodes },
  })
  lead = front
  return { front, cortex }
}

const EXPECTED = [
  'front presence trusted',
  'front presence_status_set trusted reversible',
  'front client_call trusted',
  'front protocol_propose trusted',
  'front protocol_list trusted',
  'front protocol_pause trusted',
  'front agenda_add trusted',
  'front agenda_list trusted',
  'front agenda_done trusted',
  'front protocol_answer trusted',
  'front style_get trusted',
  'front style_set trusted reversible',
  'front persona_get trusted',
  'front persona_template trusted reversible',
  'front persona_edit trusted reversible',
  'front persona_restore trusted reversible',
  'front model_roles_get trusted',
  'front model_role_set trusted reversible',
  'front undo_last trusted reversible',
  'front room_post trusted',
  'front document_save trusted',
  'front datetime trusted',
  'front nodes_status trusted',
  'front agent outside',
  'front agent_output outside',
  'front agent_stop trusted',
  'cortex.research datetime trusted',
  'cortex.research web_search outside',
  'cortex.research web_fetch outside',
  'cortex.general datetime trusted',
  'cortex.general web_search outside',
  'cortex.general web_fetch outside',
  'cortex.general list_files outside',
  'cortex.general read_file outside',
  'cortex.general write_file trusted',
  'cortex.general edit_file trusted',
  'cortex.general grep outside',
  'cortex.general glob outside',
  'cortex.general todo_write trusted',
  'cortex.general nodes_status trusted',
  'cortex.general motor_remote outside',
]

describe('the tools of the front agent and the workers', () => {
  test('every Keith-owned tool declares its source; the table lists each one', async () => {
    const { front, cortex } = build()
    const agents: Array<[string, HarnessAgent]> = [
      ['front', front],
      ['cortex.research', cortex.worker('cortex.research') as HarnessAgent],
      ['cortex.general', cortex.worker('cortex.general') as HarnessAgent],
    ]
    const all: Row[] = []
    for (const [label, agent] of agents) {
      const { rows, unresolved } = await inventory(label, agent)
      all.push(...rows)
      expect(unresolved).toEqual([])
    }
    const keithOwned = all.filter((r) => !Object.hasOwn(EHARNESS_TOOL_TRAITS, r.tool))
    expect(keithOwned.filter((r) => !r.declared).map((r) => `${r.agent}/${r.tool}`)).toEqual([])
    // the table: a new tool must be added here with its source on purpose (the memory tools exist only with hardening; they are
    // eharness' and known by name, see `EHARNESS_TOOL_TRAITS`)
    expect(
      all.map((r) => `${r.agent} ${r.tool} ${r.source}${r.reversible ? ' reversible' : ''}`),
    ).toEqual(EXPECTED)
  })
})
