/**
 * P31 step P31.4.4: a worker asked to run Python. With a sandbox node online the worker runs the code with `sandbox.run`
 * and nobody is asked (no network). With no sandbox node the worker is told code cannot run, and a call that still asks
 * the core to run code is refused: the core never runs code for a worker (ADR-0021 §3; docs/specs/motor.md, Instructions).
 * Real core and socket, scripted models, a test node whose executor answers `sandbox.run`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import type { NodeManifest } from '@keith/contracts'
import { cleanup } from './testing/core-harness.ts'
import { ask, attentionItems, motorCall, scenario } from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const SANDBOX_MANIFEST: NodeManifest = {
  manifestVersion: 2,
  name: 'sbx-1',
  os: 'testos',
  arch: 'x64',
  version: '0.0.0-test',
  policy: { allowShell: false },
  drivers: [
    {
      name: 'sandbox',
      version: '0.1.0',
      capabilities: [{ id: 'sandbox.run', schemaVersion: 1 }],
    },
  ],
}

/** Runs the code in its (fake) container: prints what it was given, no network. */
const sandboxExecutor = async ({ invoke }: { invoke: { capability: string } }) =>
  invoke.capability === 'sandbox.run'
    ? {
        ok: true as const,
        output: { stdout: '1\n', stderr: '', exitCode: 0, timedOut: false, truncated: false },
      }
    : {
        ok: false as const,
        error: { code: 'unknown-capability' as const, message: `no ${invoke.capability}` },
      }

/** The owner's turn: the front delegates to one worker, which then acts and reports. */
const frontDelegates = [
  {
    toolCalls: [
      {
        toolName: 'agent',
        toolCallId: 'c1',
        input: {
          subagent_type: 'cortex.general',
          description: 'python',
          prompt: 'Run this Python: print(1)',
          run_in_background: true,
        },
      },
    ],
  },
  { text: 'Okay, I will run it.' },
  { text: 'Done: it printed 1.' },
]

describe('a worker runs code through sandbox.run', () => {
  test('with a sandbox node online the worker picks sandbox.run and nobody is asked', async () => {
    const s = await scenario({
      nodes: [{ name: 'sbx-1', manifest: SANDBOX_MANIFEST, executor: sandboxExecutor }],
      front: frontDelegates,
      worker: [
        {
          toolCalls: [
            motorCall('p1', 'sbx-1', 'sandbox.run', { language: 'python', code: 'print(1)' }),
          ],
        },
        { text: 'It printed 1.' },
      ],
    })
    await ask(s.r, 'run this python: print(1)')
    await until(
      'the sandbox node ran the code',
      () => s.nodes['sbx-1']?.invokes ?? [],
      (invokes) => invokes.some((i) => i.capability === 'sandbox.run'),
      20_000,
    )
    const run = s.nodes['sbx-1']?.invokes.find((i) => i.capability === 'sandbox.run')
    expect(run?.input).toEqual({ language: 'python', code: 'print(1)' })
    // no network: `write` runs without the owner's approval
    expect(await attentionItems(s.r)).toEqual([])
    // the worker was told that code goes to sandbox.run
    expect(s.workerPrompts().join('\n')).toContain('Code (sandbox.run, a sandbox node is online)')
  }, 60_000)
})

describe('no sandbox node: the worker says code cannot run, and the core runs nothing', () => {
  test('the worker is told so, and a sandbox.run aimed at the core is refused', async () => {
    const s = await scenario({
      nodes: [],
      front: frontDelegates,
      worker: [
        // a model that still aims the code at the core: the core must refuse, not run it
        {
          toolCalls: [
            motorCall('p2', 'core', 'sandbox.run', { language: 'python', code: 'print(1)' }),
          ],
        },
        { text: 'Code cannot run here: no sandbox node is online.' },
      ],
    })
    await ask(s.r, 'run this python: print(1)')
    await until(
      'the core refused the call and the worker saw it',
      () => s.workerPrompts(),
      (prompts) => prompts.some((p) => p.includes('unknown-capability')),
      20_000,
    )
    const prompts = s.workerPrompts().join('\n')
    expect(prompts).toContain('Code: no sandbox node is online, so code cannot run now')
    expect(prompts).toContain('never offer to run it on the core')
    expect(prompts).not.toContain('Code (sandbox.run, a sandbox node is online)')
    // the refusal of the core is the tool result the worker saw: nothing ran
    expect(prompts).toContain('unknown-capability')
    expect(await attentionItems(s.r)).toEqual([])
  }, 60_000)
})
