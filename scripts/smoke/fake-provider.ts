/**
 * A tiny OpenAI-compatible chat-completions endpoint (streaming) the core reaches through
 * `DEEPSEEK_BASE_URL`. It answers with plain text, or with a `motor_remote shell.exec` tool call
 * when the last user message asks to run something ("run").
 */

export interface FakeProvider {
  url: string
  /** Number of chat-completions requests seen. */
  calls(): number
  /** Summary of the last request (roles, tool count), for failure output. */
  last(): string
  /** The raw body of every chat-completions request, in order (P33.6.2 reads the style lines in them). */
  requests(): string[]
  stop(): void
}

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-smoke',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'smoke',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

interface Message {
  role: string
  content?: unknown
}

/** A turn reminder (`<system-reminder>`): the front agent puts it after the newest message (turnPlacement 'end'). */
function isReminder(m: Message): boolean {
  return m.role === 'user' && JSON.stringify(m.content ?? '').includes('<system-reminder>')
}

function lastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  if (typeof last?.content === 'string') return last.content
  if (Array.isArray(last?.content))
    return last.content.map((p: { text?: string }) => p.text ?? '').join(' ')
  return ''
}

function toolCall(name: string, args: unknown) {
  const call = {
    index: 0,
    // unique per call: a fixed id made a second delegation reuse the worker session of an earlier one (P26.4.4)
    id: `call_${name}_${crypto.randomUUID().slice(0, 8)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
  const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
  return [
    sse(chunk({ role: 'assistant', tool_calls: [call] })),
    sse(chunk({}, 'tool_calls')),
    sse({ ...chunk({}), choices: [], usage }),
  ]
}

function textOf(text: string) {
  const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
  return [
    sse(chunk({ role: 'assistant', content: '' })),
    ...text.split(' ').map((w, i) => sse(chunk({ content: `${i === 0 ? '' : ' '}${w}` }))),
    sse(chunk({}, 'stop')),
    sse({ ...chunk({}), choices: [], usage }),
  ]
}

/** The fixed system text of the dreaming judge (`apps/core/src/modules/hippocampus/dream/prompt.ts`, JUDGE_INSTRUCTIONS). */
const DREAM_JUDGE_MARK = 'You are the memory reviewer of Keith'
const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"'
const CANDIDATE_LINE = new RegExp(
  `- id: (${JSON_STRING}), day: ${JSON_STRING}, sourceMessageId: (${JSON_STRING}), text: (${JSON_STRING})`,
  'g',
)

/**
 * The judge's plan (P35.6.6): a candidate that starts with "remember this:" is promoted with importance 9 (the text
 * after the words); every other candidate is dropped. The candidates are read back from the judge's user message (the
 * lines `buildJudgePrompt` writes), so the plan names only ids the core sent.
 */
function dreamPlanFor(messages: Message[]): string | undefined {
  const system = messages.find((m) => m.role === 'system')
  if (typeof system?.content !== 'string' || !system.content.includes(DREAM_JUDGE_MARK))
    return undefined
  const candidates = [...lastUserText(messages).matchAll(CANDIDATE_LINE)].map((m) => ({
    id: JSON.parse(m[1] ?? '""') as string,
    sourceMessageId: JSON.parse(m[2] ?? '""') as string,
    text: JSON.parse(m[3] ?? '""') as string,
  }))
  const decisions = candidates.map((c) => {
    const ask = /^remember this:\s*/i
    if (ask.test(c.text))
      return {
        id: c.id,
        action: 'promote',
        target: 'profile',
        text: c.text.replace(ask, ''),
        reason: 'the person asked to keep it',
        importance: 9,
        sourceMessageId: c.sourceMessageId,
      }
    return {
      id: c.id,
      action: 'drop',
      target: 'recent',
      text: 'not a lasting fact',
      reason: 'small talk',
      importance: 1,
      sourceMessageId: c.sourceMessageId,
    }
  })
  return JSON.stringify({ candidates: decisions })
}

/**
 * The front agent (tool `agent`) delegates "run ..." to `cortex.general`; that worker (tool
 * `motor_remote`) runs `shell.exec` on the node, which waits for the owner's approval.
 */
function completion(
  body: { messages?: Message[]; tools?: Array<{ function?: { name?: string } }> },
  node: string,
): string[] {
  // the newest real messages decide the answer: a trailing turn reminder is not one
  const messages = (body.messages ?? []).filter((m) => !isReminder(m))
  const names = (body.tools ?? []).map((t) => t.function?.name)
  const afterTool = messages[messages.length - 1]?.role === 'tool'
  // the dreaming judge (P35.6.6): a plan of the candidates it was given, no tool call
  const plan = dreamPlanFor(messages)
  if (plan !== undefined) return textOf(plan)
  // a Markdown list on request (P33.6.2): a speech channel must get it back without markup
  if (!afterTool && lastUserText(messages).includes('markdown list')) {
    return textOf('Here are three fruits:\n- **apples** for breakfast\n- `pears`\n- *plums*')
  }
  if (names.includes('notes_public_list')) {
    const asked = lastUserText(messages)
    if (!afterTool && asked.includes('public notes')) return toolCall('notes_public_list', {})
    if (afterTool) {
      const tool = messages[messages.length - 1]?.content
      const result = typeof tool === 'string' ? tool : JSON.stringify(tool)
      return textOf(
        `You asked: ${asked} -- The public notes say: ${result.replaceAll(/\s+/g, ' ')}`,
      )
    }
    return textOf('I can only talk about the public notes.')
  }
  // a desktop read on a named node (P31.5.6): desktop.info is a read, so the owner is not asked
  const desktop = /desktop info on (\S+)/.exec(lastUserText(messages))?.[1]
  if (!afterTool && desktop !== undefined && names.includes('motor_remote')) {
    return toolCall('motor_remote', { node: desktop, capability: 'desktop.info', input: {} })
  }
  if (!afterTool && desktop !== undefined && names.includes('agent')) {
    return toolCall('agent', {
      subagent_type: 'cortex.general',
      description: 'desktop read',
      prompt: `desktop info on ${desktop}`,
      run_in_background: true,
    })
  }
  const wantsRun = !afterTool && lastUserText(messages).includes('run')
  if (wantsRun && names.includes('motor_remote')) {
    return toolCall('motor_remote', {
      node,
      capability: 'shell.exec',
      input: { command: 'echo smoke' },
    })
  }
  if (wantsRun && names.includes('agent')) {
    return toolCall('agent', {
      subagent_type: 'cortex.general',
      description: 'machine task',
      prompt: `run echo smoke on ${node}`,
      run_in_background: true,
    })
  }
  return textOf(afterTool ? 'The command was processed.' : 'Hello from the fake provider.')
}

/**
 * A models.dev-shaped catalog with one priced model, `deepseek-chat`: the guest role needs a priced model and
 * the real models.dev dropped that id (so the smoke must not depend on a live catalog).
 */
const SMOKE_CATALOG = {
  deepseek: {
    models: {
      'deepseek-chat': {
        cost: { input: 0.27, output: 1.1 },
        limit: { context: 64_000, output: 8_000 },
      },
    },
  },
}

export function startFakeProvider(node: string): FakeProvider {
  let calls = 0
  let last = ''
  const bodies: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: 'smoke', object: 'model' }] })
      }
      if (pathname === '/api.json') {
        // the model catalog (`KEITH_MODELS_DEV_URL`): hermetic, so the smoke never needs models.dev
        return Response.json(SMOKE_CATALOG)
      }
      if (!pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      calls++
      const raw = await request.text()
      last = raw.slice(-400)
      bodies.push(raw)
      // a non-streaming call (the memory flush of /new and /compact, a summary): a plain completion with no tool call
      if ((JSON.parse(raw) as { stream?: boolean }).stream !== true) {
        return Response.json({
          id: 'chatcmpl-smoke',
          object: 'chat.completion',
          created: 0,
          model: 'smoke',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
      }
      const parts = [
        ...completion(JSON.parse(raw) as Parameters<typeof completion>[0], node),
        'data: [DONE]\n\n',
      ]
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const part of parts) {
              controller.enqueue(encoder.encode(part))
              await Bun.sleep(5)
            }
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls: () => calls,
    last: () => last,
    requests: () => bodies.slice(),
    stop: () => server.stop(true),
  }
}
