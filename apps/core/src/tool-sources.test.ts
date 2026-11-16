// Every tool of the front agent and of the workers declares where its result comes from (ADR-0036 §3, docs/specs/amygdala.md
// "Consent"): a Keith-owned tool must carry `metadata.source`; a tool of eharness is known by name (`@keith/eh-ext`); anything else counts
// as `outside`. The agents are built with their real plugins over stub collaborators and every plugin is resolved with `resolvePlugin`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  declaresSource,
  EHARNESS_TOOL_TRAITS,
  effectOfRisk,
  eharnessConsentRisk,
  toolEffect,
  toolReversible,
  toolSource,
} from '@keith/eh-ext'
import type { HarnessAgent, HarnessPlugin } from 'eharness'
import { inMemoryMessages, inMemoryState } from 'eharness/storage/memory'
import { resolvePlugin } from 'eharness/testing'
import { consentDecision } from './modules/amygdala/consent-table.ts'
import { createConsent, createUndoPlugin } from './modules/amygdala/index.ts'
import { createRoomPostPlugin } from './modules/corpus-callosum/index.ts'
import { createCortex } from './modules/cortex/index.ts'
import { protocolToolSlot } from './modules/hypothalamus/tools.ts'
import { motorConsentEffect } from './modules/motor/index.ts'
import {
  clientCallConsentEffect,
  clientCallTool,
  presenceTool,
  workspaceConsentEffect,
  workspaceTool,
} from './modules/parietal/index.ts'
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
  effect: string | undefined
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
          effect:
            toolEffect(metadata, tool) ??
            effectOfRisk(
              eharnessConsentRisk(tool) ??
                ((metadata as { risk?: string } | undefined)?.risk as string | undefined),
            ),
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
    workspaceTool: workspaceTool({ workspace: stub, parietal: stub, actors: stub }),
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
  'front workspace trusted reversible',
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

// ADR-0039 §6: the consent outcome of every tool, clean and after outside content. A tool whose effect depends on its input is listed
// per input below. A change that starts asking, or a new tool, fails here until this table is updated on purpose.
const OUTCOME = (d: ReturnType<typeof consentDecision>): string =>
  d === undefined
    ? '-'
    : d.status === 'approved'
      ? 'runs'
      : d.tier === 'conversation'
        ? 'ask'
        : 'device'
const outcomes = (
  effect: Parameters<typeof consentDecision>[0]['effect'],
  reversible: boolean,
  fromPerson = false,
) =>
  `${effect ?? 'no-effect'} clean:${OUTCOME(consentDecision({ effect, reversible, context: 'clean', fromPerson }))} tainted:${OUTCOME(consentDecision({ effect, reversible, context: 'tainted', fromPerson }))}`

const BY_INPUT = new Set(['workspace', 'client_call', 'motor_remote'])

describe('the consent outcome of every tool (ADR-0039)', () => {
  test('each tool, clean and tainted', async () => {
    const { front, cortex } = build()
    const agents: Array<[string, HarnessAgent]> = [
      ['front', front],
      ['cortex.research', cortex.worker('cortex.research') as HarnessAgent],
      ['cortex.general', cortex.worker('cortex.general') as HarnessAgent],
    ]
    const lines: string[] = []
    for (const [label, agent] of agents) {
      const { rows } = await inventory(label, agent)
      for (const r of rows)
        lines.push(
          `${r.agent} ${r.tool} ${BY_INPUT.has(r.tool) ? 'by-input' : outcomes(r.effect as never, r.reversible)}`,
        )
    }
    expect(lines).toEqual(OUTCOMES)
  })

  test('tools whose effect depends on the input', () => {
    const motor = motorConsentEffect()
    const cases: Array<[string, string, unknown]> = [
      ['workspace look', 'workspace', { action: 'look' }],
      [
        'workspace open map',
        'workspace',
        { action: 'open', app: 'maps:map', params: { lat: 1, lon: 2 } },
      ],
      [
        'workspace params map',
        'workspace',
        { action: 'params', windowId: 'w', params: { lat: 1, lon: 2, zoom: 9 } },
      ],
      ['workspace focus', 'workspace', { action: 'focus', windowId: 'w' }],
      ['workspace move', 'workspace', { action: 'move', windowId: 'w', desktopId: 'd' }],
      ['workspace close', 'workspace', { action: 'close', windowId: 'w' }],
      ['workspace arrange', 'workspace', { action: 'arrange', desktopId: 'd', layout: 'grid' }],
      ['workspace desktop', 'workspace', { action: 'desktop', name: 'Two' }],
      ['workspace show', 'workspace', { action: 'show', overview: true }],
      ['workspace show orb', 'workspace', { action: 'show', orb: true }],
      ['workspace remove', 'workspace', { action: 'remove', desktopId: 'd2' }],
      [
        'workspace open browser url',
        'workspace',
        { action: 'open', app: 'web:browser', params: { url: 'https://x.example' } },
      ],
      ['client_call notify', 'client_call', { capability: 'notify', input: {} }],
      ['client_call open.view', 'client_call', { capability: 'open.view', input: {} }],
      ['client_call location.share', 'client_call', { capability: 'location.share', input: {} }],
      [
        'motor_remote system.info',
        'motor_remote',
        { node: 'n', capability: 'system.info', input: {} },
      ],
      [
        'motor_remote shell.exec',
        'motor_remote',
        { node: 'n', capability: 'shell.exec', input: { command: 'ls' } },
      ],
    ]
    const lines = cases.map(([label, tool, input]) => {
      const e =
        workspaceConsentEffect(tool, input) ??
        clientCallConsentEffect(tool, input) ??
        motor(tool, input)
      return `${label}: ${outcomes(e?.effect, tool === 'workspace')}`
    })
    expect(lines).toEqual(BY_INPUT_OUTCOMES)
    // a URL the person typed: the browser opens after outside content too
    expect(outcomes('egress', false, true)).toBe('egress clean:runs tainted:runs')
  })
})

// `-`: consent gives no opinion (a local write that cannot be undone: the tool's own rules decide; room_post confirms itself)
const OUTCOMES: string[] = [
  'front presence none clean:runs tainted:runs',
  'front presence_status_set local clean:runs tainted:runs',
  'front client_call by-input',
  'front workspace by-input',
  'front protocol_propose local clean:- tainted:-',
  'front protocol_list none clean:runs tainted:runs',
  'front protocol_pause local clean:- tainted:-',
  'front agenda_add local clean:- tainted:-',
  'front agenda_list none clean:runs tainted:runs',
  'front agenda_done local clean:- tainted:-',
  'front protocol_answer local clean:- tainted:-',
  'front style_get none clean:runs tainted:runs',
  'front style_set local clean:runs tainted:runs',
  'front persona_get none clean:runs tainted:runs',
  'front persona_template behavior clean:runs tainted:ask',
  'front persona_edit behavior clean:runs tainted:ask',
  'front persona_restore behavior clean:runs tainted:ask',
  'front model_roles_get none clean:runs tainted:runs',
  'front model_role_set behavior clean:runs tainted:ask',
  'front undo_last local clean:runs tainted:runs',
  'front room_post local clean:- tainted:-',
  'front document_save local clean:- tainted:-',
  'front datetime none clean:runs tainted:runs',
  'front nodes_status none clean:runs tainted:runs',
  'front agent none clean:runs tainted:runs',
  'front agent_output none clean:runs tainted:runs',
  'front agent_stop none clean:runs tainted:runs',
  'cortex.research datetime none clean:runs tainted:runs',
  'cortex.research web_search none clean:runs tainted:runs',
  'cortex.research web_fetch none clean:runs tainted:runs',
  'cortex.general datetime none clean:runs tainted:runs',
  'cortex.general web_search none clean:runs tainted:runs',
  'cortex.general web_fetch none clean:runs tainted:runs',
  'cortex.general list_files none clean:runs tainted:runs',
  'cortex.general read_file none clean:runs tainted:runs',
  'cortex.general write_file local clean:- tainted:-',
  'cortex.general edit_file local clean:- tainted:-',
  'cortex.general grep none clean:runs tainted:runs',
  'cortex.general glob none clean:runs tainted:runs',
  'cortex.general todo_write local clean:- tainted:-',
  'cortex.general nodes_status none clean:runs tainted:runs',
  'cortex.general motor_remote by-input',
]

const BY_INPUT_OUTCOMES: string[] = [
  'workspace look: none clean:runs tainted:runs',
  'workspace open map: none clean:runs tainted:runs',
  'workspace params map: none clean:runs tainted:runs',
  'workspace focus: none clean:runs tainted:runs',
  'workspace move: none clean:runs tainted:runs',
  'workspace close: none clean:runs tainted:runs',
  'workspace arrange: none clean:runs tainted:runs',
  'workspace desktop: none clean:runs tainted:runs',
  'workspace show: none clean:runs tainted:runs',
  'workspace show orb: none clean:runs tainted:runs',
  'workspace remove: none clean:runs tainted:runs',
  'workspace open browser url: egress clean:runs tainted:ask',
  'client_call notify: none clean:runs tainted:runs',
  'client_call open.view: none clean:runs tainted:runs',
  'client_call location.share: egress clean:runs tainted:ask',
  'motor_remote system.info: none clean:runs tainted:runs',
  'motor_remote shell.exec: destructive clean:ask tainted:device',
]
