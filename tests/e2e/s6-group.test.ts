// S-6, phase 5 (P5-I2): a group thread on the real core, over HTTP and WebSocket. Tony's model
// starts "Mission" with Pepper and Rhodey; Pepper joins with the invitation's Join button and
// Rhodey by saying yes. People talk to each other without an LLM turn, Keith answers when
// addressed (the rules first, then `fake:utility`), Tony talks to Keith privately while the group
// is busy, a memory written in the group is `thread`, a task started there reports back there, and
// Rhodey leaves (S-6 "Leaving", ADR-0017). A light browser check shows the group in Pepper's web
// app sidebar with author names; it is skipped with a logged reason when no browser is available.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser } from 'playwright'
import { GROUP_TONE_RULE } from '../../packages/core/src/mind/context-sections.ts'
import { INVITATION_ACTIONS_ID } from '../../packages/core/src/mind/groups.ts'
import type { MessageDto, ThreadDto, ThreadId } from '../../packages/protocol/src/index.ts'
import type { LlmRequest } from '../../packages/sdk/src/index.ts'
import { fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import { type BuiltWebApp, buildWebApp, launchChromium } from './browser.ts'
import {
  addPerson,
  afterTool,
  connectNode,
  createGate,
  createHome,
  digestOf,
  type E2eNode,
  type E2ePerson,
  e2eClock,
  e2eConfig,
  eventually,
  greet,
  type Keith,
  lastUser,
  nextEvent,
  requestText,
  routedChat,
  scriptedLlm,
  scriptedProvider,
  settle,
  signUp,
  startKeith,
  systemOf,
} from './harness.ts'

const S6_TIMEOUT_MS = 60_000
const UI_WAIT_MS = 10_000

let web: BuiltWebApp | undefined
let browser: Browser | undefined
let browserSkipReason: string | null = null

beforeAll(async () => {
  try {
    web = await buildWebApp()
    browser = await launchChromium()
  } catch (error) {
    browserSkipReason = String(error)
    console.warn(`S-6: the browser check is skipped (no browser available): ${browserSkipReason}`)
  }
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await web?.remove()
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const WEB_CAPABILITIES = ['chat.text@1', 'ui.render@1']

const CONNECT = 'Connect me with Pepper and Rhodey, mission thread.'
const PURPOSE = 'Get the suit to the gala tonight.'
const INVITED = 'Tony invites you to Mission. Want to join?'
const JOINED = 'You are in Mission now.'
const P_TO_R = 'Rhodey, are you on your way?'
const R_TO_P = 'Pepper, landing in ten.'
const STATUS_Q = "Keith, what's our status?"
const STATUS_A = 'All on track: the suit ships at six.'
const UNSURE = 'The weather looks rough over the bay.'
const PRIVATE_Q = 'Just between us: is Pepper upset with me?'
const PRIVATE_A = 'Not that I can tell, sir.'
const MEMO = 'The rendezvous is at hangar 3'
const REMEMBER = 'Keith, remember that the rendezvous is at hangar 3.'
const ROUTE_Q = 'Keith, research the fastest route to the gala and tell us.'
const ROUTE_GOAL = 'Find the fastest route from the airfield to the gala venue'
const ROUTE_RESULT = 'Fastest route: the coast road, 25 minutes.'
const ROUTE_REPORT = `The route is ready: ${ROUTE_RESULT}`
const WHERE_Q = 'Keith, where do we meet?'

type Actor = { person: E2ePerson; nodes: E2eNode[]; main: ThreadId }

const node = (a: Actor): E2eNode => a.nodes[0] as E2eNode

/** The `thread.updated` DTOs for `group` that a node got, oldest first. */
function updates(n: E2eNode, group: ThreadId): ThreadDto[] {
  return n.frames.flatMap((f) =>
    f.type === 'thread.updated' && f.data.thread.id === group ? [f.data.thread] : [],
  )
}

const idsOf = (people: { id: string }[] | undefined) => (people ?? []).map((p) => p.id).sort()

/** User lines of `group` a node was sent as `message.user`. */
function echoes(n: E2eNode, group: ThreadId): string[] {
  return n.frames.flatMap((f) =>
    f.type === 'message.user' && f.data.message.threadId === group ? [f.data.message.content] : [],
  )
}

async function openThread(
  n: E2eNode,
  threadId: ThreadId,
): Promise<{ thread: ThreadDto; messages: MessageDto[] }> {
  const id = n.send('thread.open', { threadId })
  const opened = await n.next('thread.opened', (f) => f.re === id)
  return opened.data
}

/** Group requests: section 3 names the group. */
const isGroupRequest = (r: LlmRequest) => systemOf(r).includes('This is the group thread "Mission".')

function stopLater(keith: Keith) {
  cleanups.push(() => keith.stop())
}

describe('S-6 (phase 5): collaboration in a group thread', () => {
  test(
    'start, join by button and by text, addressing, a private aside, thread memory, a group task, leaving',
    async () => {
      const home = await createHome(
        e2eConfig({
          enabled: web ? ['@keith/web'] : [],
          extra: web ? `[plugins."@keith/web"]\ndistDir = ${JSON.stringify(web.dir)}\n` : '',
        }),
      )
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const chat = routedChat()
      const utility = scriptedLlm([], fakeText(JSON.stringify({ addressed: false, confidence: 0.5 })))
      const researcher = scriptedLlm([], fakeText(ROUTE_RESULT))
      // The status turn waits at its model call, so the group is busy while Tony asks privately.
      const statusGate = createGate()
      let statusHeld = false
      const { keith } = await startKeith({
        home,
        clock,
        provider: scriptedProvider({
          chat: {
            llm: chat,
            before: async (req) => {
              if (lastUser(req) !== `Pepper: ${STATUS_Q}`) return
              statusHeld = true
              await statusGate.promise
            },
          },
          utility: { llm: utility },
          researcher: { llm: researcher },
        }),
      })
      stopLater(keith)
      cleanups.push(() => statusGate.open())

      // The cast: Tony (owner) on a laptop and a phone, Pepper (member) on a web-like node, Rhodey
      // (member), and Happy (guest), who is in no group.
      const tonyP = await addPerson(keith, clock, {
        name: 'Tony',
        tier: 'owner',
        tone: 'Dry wit. Calls him sir.',
      })
      const laptop = await connectNode(keith, tonyP)
      const phone = await connectNode(keith, tonyP)
      cleanups.push(
        () => laptop.close(),
        () => phone.close(),
      )
      const tonyMain = (await laptop.openMain()).threadId
      expect((await phone.openMain()).threadId).toBe(tonyMain)
      const tony: Actor = { person: tonyP, nodes: [laptop, phone], main: tonyMain }

      const join = async (
        name: string,
        tier: 'member' | 'guest',
        tone: string,
        capabilities?: string[],
      ): Promise<Actor> => {
        const person = await signUp(keith, home, clock, { name, tier, tone })
        const n = await connectNode(keith, person, { token: person.token, capabilities })
        cleanups.push(() => n.close())
        const main = (await n.openMain()).threadId
        await greet(n, main)
        return { person, nodes: [n], main }
      }
      const pepper = await join('Pepper', 'member', 'Warm and direct.', WEB_CAPABILITIES)
      const rhodey = await join('Rhodey', 'member', 'Military formal.')
      const happy = await join('Happy', 'guest', 'Friendly.')
      await settle(keith)
      const everyNode = [laptop, phone, node(pepper), node(rhodey)]

      // 1. Tony's model starts the group. Tony's nodes get thread.updated; the invitees get an
      //    invitation delivery (their thread.updated comes when they join, P5-I1).
      let group: ThreadId | null = null
      chat.route(
        {
          name: 'start',
          when: (r) => lastUser(r) === CONNECT,
          reply: () => [
            fakeToolCall('thread.start_group', {
              participants: ['Pepper', 'Rhodey'],
              title: 'Mission',
              purpose: PURPOSE,
            }),
          ],
        },
        {
          name: 'started',
          when: (r) => afterTool(r, 'thread.start_group'),
          reply: () => fakeText('Done, sir. I invited them.'),
        },
        {
          name: 'invitation',
          when: (r) => lastUser(r) === null && systemOf(r).includes('(invitation from Tony)'),
          reply: () => fakeText(INVITED),
          times: 2,
        },
        {
          name: 'join by button',
          when: (r) => lastUser(r) === '(clicked: Join)',
          reply: () => [fakeToolCall('thread.join', { threadId: group })],
        },
        {
          name: 'join by text',
          when: (r) => lastUser(r) === 'Yes, join.',
          reply: () => [fakeToolCall('thread.join', { threadId: group })],
        },
        { name: 'joined', when: (r) => afterTool(r, 'thread.join'), reply: () => fakeText(JOINED), times: 2 },
      )
      laptop.say(tonyMain, CONNECT)
      const created = await laptop.next('thread.updated')
      group = created.data.thread.id
      const gid = group
      expect(created.data.thread).toMatchObject({
        kind: 'group',
        title: 'Mission',
        purpose: PURPOSE,
        formerParticipants: [],
      })
      expect(idsOf(created.data.thread.participants)).toEqual([tony.person.id])
      expect((await phone.next('thread.updated', (f) => f.data.thread.id === gid)).data.thread.title).toBe(
        'Mission',
      )
      expect((await laptop.reply(tonyMain)).content).toBe('Done, sir. I invited them.')

      const invitations: Record<string, MessageDto> = {}
      for (const a of [pepper, rhodey]) {
        const invitation = await node(a).next(
          'message.completed',
          (f) => f.data.message.threadId === a.main && f.data.message.content === INVITED,
        )
        invitations[a.person.name] = invitation.data.message
        expect(JSON.stringify(invitation.data.message.ui)).toContain('"label":"Join"')
        expect(updates(node(a), gid)).toEqual([])
      }
      // Pepper's web-like node got the card as ui.render.
      const card = await node(pepper).next('ui.render', (f) => f.data.messageId === invitations.Pepper?.id)
      expect(JSON.stringify(card.data.block)).toContain(`"id":"${INVITATION_ACTIONS_ID}"`)

      // 2. Pepper clicks Join; Rhodey says yes in text. Every node of all three gets thread.updated.
      node(pepper).send('ui.action', {
        threadId: pepper.main,
        messageId: (invitations.Pepper as MessageDto).id,
        blockId: INVITATION_ACTIONS_ID,
        actionId: 'join',
      })
      expect(
        (await node(pepper).next('message.completed', (f) => f.data.message.content === JOINED)).data.message
          .threadId,
      ).toBe(pepper.main)
      node(rhodey).say(rhodey.main, 'Yes, join.')
      expect(
        (await node(rhodey).next('message.completed', (f) => f.data.message.content === JOINED)).data.message
          .threadId,
      ).toBe(rhodey.main)
      await settle(keith)
      const all3 = [tony.person.id, pepper.person.id, rhodey.person.id].sort()
      for (const n of everyNode) expect(idsOf(updates(n, gid).at(-1)?.participants)).toEqual(all3)
      for (const n of everyNode) expect((await openThread(n, gid)).thread.title).toBe('Mission')

      // 3a. Pepper and Rhodey talk to each other: every other attached node gets the line, and no
      //     model is called.
      const chatCalls = chat.calls
      node(pepper).say(gid, P_TO_R)
      await settle(keith)
      node(rhodey).say(gid, R_TO_P)
      await settle(keith)
      expect(chat.calls).toBe(chatCalls)
      expect(utility.calls).toBe(0)
      for (const n of [laptop, phone]) expect(echoes(n, gid)).toEqual([P_TO_R, R_TO_P])
      expect(echoes(node(rhodey), gid)).toEqual([P_TO_R])
      expect(echoes(node(pepper), gid)).toEqual([R_TO_P])
      for (const n of everyNode)
        expect(n.frames.some((f) => f.type === 'message.started' && f.data.threadId === gid)).toBe(false)

      // 3b. "Keith, what's our status?" runs one turn with every card, the tone rule and names.
      let statusReq: LlmRequest | undefined
      chat.route({
        name: 'status',
        when: (r) => lastUser(r) === `Pepper: ${STATUS_Q}`,
        reply: (r) => {
          statusReq = r
          return fakeText(STATUS_A)
        },
      })
      node(pepper).say(gid, STATUS_Q)
      await eventually(() => statusHeld)

      // 4. Meanwhile Tony asks Keith privately in his direct thread. His digest mentions the busy
      //    group; the group's other nodes see nothing of it.
      let privateReq: LlmRequest | undefined
      chat.route({
        name: 'private',
        when: (r) => lastUser(r) === PRIVATE_Q,
        reply: (r) => {
          privateReq = r
          return fakeText(PRIVATE_A)
        },
      })
      phone.say(tonyMain, PRIVATE_Q)
      await phone.next(
        'message.completed',
        (f) => f.data.message.threadId === tonyMain && f.data.message.content === PRIVATE_A,
      )
      expect(digestOf(privateReq)).toContain('- Replying in your other thread "Mission".')
      expect(isGroupRequest(privateReq as LlmRequest)).toBe(false)

      statusGate.open()
      for (const n of everyNode) {
        await n.next(
          'message.completed',
          (f) => f.data.message.threadId === gid && f.data.message.content === STATUS_A,
        )
      }
      await settle(keith)
      expect(chat.calls).toBe(chatCalls + 2)
      const statusSystem = systemOf(statusReq)
      for (const line of [
        '- Tony (tier: owner)',
        '  Tone: Dry wit. Calls him sir.',
        '- Pepper (tier: member)',
        '  Tone: Warm and direct.',
        '- Rhodey (tier: member)',
        '  Tone: Military formal.',
        GROUP_TONE_RULE,
        "You are answering Pepper's message.",
        `Its purpose: ${PURPOSE}`,
      ]) {
        expect(statusSystem).toContain(line)
      }
      expect(statusReq?.messages.filter((m) => m.role === 'user')).toEqual([
        { role: 'user', name: 'Pepper', content: `Pepper: ${P_TO_R}` },
        { role: 'user', name: 'Rhodey', content: `Rhodey: ${R_TO_P}` },
        { role: 'user', name: 'Pepper', content: `Pepper: ${STATUS_Q}` },
      ])
      for (const a of [pepper, rhodey]) {
        const seen = JSON.stringify(a.nodes.map((n) => n.frames))
        expect(seen).not.toContain(tonyMain)
        expect(seen).not.toContain(PRIVATE_Q)
        expect(seen).not.toContain(PRIVATE_A)
      }

      // 3c. A line the rules can't decide goes to fake:utility once; its "no" makes no turn.
      utility.push(fakeText(JSON.stringify({ addressed: false, confidence: 0.9 })))
      node(rhodey).say(gid, UNSURE)
      await settle(keith)
      expect(utility.calls).toBe(1)
      expect(utility.requests[0]?.tools ?? []).toEqual([])
      expect(utility.requests[0]?.messages.at(-1)?.content).toContain(UNSURE)
      expect(chat.calls).toBe(chatCalls + 2)
      for (const n of [laptop, phone, node(pepper)]) expect(echoes(n, gid).at(-1)).toBe(UNSURE)

      // 5. Rhodey's model remembers a fact in the group: it is `thread`.
      chat.route(
        {
          name: 'remember',
          when: (r) => lastUser(r) === `Rhodey: ${REMEMBER}`,
          reply: () => [fakeToolCall('memory.remember', { content: MEMO, pinned: true })],
        },
        {
          name: 'remembered',
          when: (r) => afterTool(r, 'memory.remember'),
          reply: () => fakeText('Noted, Colonel.'),
        },
      )
      const written = nextEvent(keith, 'memory.written')
      node(rhodey).say(gid, REMEMBER)
      await node(rhodey).next('message.completed', (f) => f.data.message.content === 'Noted, Colonel.')
      const memo = await keith.repos.memories.get((await written).memoryId)
      expect(memo).toMatchObject({
        content: MEMO,
        visibility: 'thread',
        threadId: gid,
        authorPersonId: rhodey.person.id,
      })
      await settle(keith)

      // Who sees it outside the group: Happy (not a participant) never does. Pepper's direct thread
      // does, because a group's `thread` memories show in each current participant's direct thread
      // (memory.md "In group threads"; see the P5-I2 Outcome).
      const directAsk = async (a: Actor, text: string): Promise<LlmRequest> => {
        let req: LlmRequest | undefined
        chat.route({
          name: `direct: ${a.person.name}: ${text}`,
          when: (r) => lastUser(r) === text,
          reply: (r) => {
            req = r
            return fakeText('Nothing new.')
          },
        })
        node(a).say(a.main, text)
        await node(a).reply(a.main)
        await settle(keith)
        return req as LlmRequest
      }
      expect(requestText(await directAsk(happy, 'Anything new, Keith?'))).not.toContain(MEMO)
      expect(systemOf(await directAsk(pepper, 'Anything new for me?'))).toContain(MEMO)

      // 6. A task started in the group reports back to the group.
      chat.route(
        {
          name: 'route task',
          when: (r) => lastUser(r) === `Tony: ${ROUTE_Q}`,
          reply: () => [
            fakeToolCall('task.start', {
              goal: ROUTE_GOAL,
              notify: 'when-done',
              promise: 'I will tell you all.',
            }),
          ],
        },
        { name: 'route started', when: (r) => afterTool(r, 'task.start'), reply: () => fakeText('On it.') },
        {
          name: 'route report',
          when: (r) => lastUser(r) === null && isGroupRequest(r) && systemOf(r).includes(ROUTE_RESULT),
          reply: () => fakeText(ROUTE_REPORT),
        },
      )
      const taskDone = nextEvent(keith, 'task.completed')
      laptop.say(gid, ROUTE_Q)
      const { taskId } = await taskDone
      expect(await keith.repos.tasks.get(taskId)).toMatchObject({
        threadId: gid,
        visibility: 'thread',
        goal: ROUTE_GOAL,
      })
      for (const n of everyNode) {
        const report = await n.next(
          'message.completed',
          (f) => f.data.message.threadId === gid && f.data.message.content === ROUTE_REPORT,
        )
        const started = await n.next('message.started', (f) => f.data.messageId === report.data.message.id)
        expect(started.data.proactive).toBe(true)
      }
      await settle(keith)
      // Happy's node, outside the group, got nothing of the group.
      expect(JSON.stringify(node(happy).frames)).not.toContain(gid)

      // A light browser check: Pepper's web app lists the group and shows who said what.
      if (browser && web) {
        const context = await browser.newContext()
        cleanups.push(() => context.close())
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on('pageerror', (e) => pageErrors.push(String(e)))
        await page.goto(`${keith.url}/`)
        await page.getByLabel('Username').fill(pepper.person.username)
        await page.getByLabel('Password').fill(pepper.person.password)
        await page.getByRole('button', { name: 'Sign in' }).click()
        const item = page.locator(`[data-slot="sidebar"] [data-slot="thread-item"][data-thread-id="${gid}"]`)
        await item.waitFor({ timeout: UI_WAIT_MS })
        expect(await item.innerText()).toContain('Mission')
        expect(await item.locator('[data-slot="thread-participants"]').innerText()).toContain('Rhodey')
        await item.click()
        const timeline = page.locator('[data-slot="timeline"]')
        await timeline.getByText(R_TO_P).waitFor({ timeout: UI_WAIT_MS })
        const authors = await timeline.locator('[data-slot="author"]').allInnerTexts()
        expect(authors).toEqual(expect.arrayContaining(['Rhodey', 'Tony']))
        expect(pageErrors).toEqual([])
        await context.close()
      } else {
        console.warn(`S-6: browser check skipped: ${browserSkipReason ?? 'no browser'}`)
      }

      // 7. Rhodey leaves (from his main thread): his node gets thread.removed; the others keep the
      //    history and the group's memory.
      chat.route(
        {
          name: 'leave',
          when: (r) => lastUser(r) === 'Take me out of Mission.',
          reply: () => [fakeToolCall('thread.leave', { threadId: gid })],
        },
        {
          name: 'left',
          when: (r) => afterTool(r, 'thread.leave'),
          reply: () => fakeText('You left Mission.'),
        },
      )
      node(rhodey).say(rhodey.main, 'Take me out of Mission.')
      expect((await node(rhodey).next('thread.removed')).data).toEqual({ threadId: gid })
      await node(rhodey).reply(rhodey.main)
      await settle(keith)
      for (const n of [laptop, phone, node(pepper)]) {
        const last = updates(n, gid).at(-1)
        expect(idsOf(last?.participants)).toEqual([tony.person.id, pepper.person.id].sort())
        expect(idsOf(last?.formerParticipants)).toEqual([rhodey.person.id])
      }
      const history = (await openThread(node(pepper), gid)).messages.map((m) => m.content)
      expect(history).toEqual(
        expect.arrayContaining([P_TO_R, R_TO_P, STATUS_A, UNSURE, REMEMBER, ROUTE_REPORT]),
      )

      let whereReq: LlmRequest | undefined
      chat.route({
        name: 'where',
        when: (r) => lastUser(r) === `Tony: ${WHERE_Q}`,
        reply: (r) => {
          whereReq = r
          return fakeText('Hangar 3.')
        },
      })
      laptop.say(gid, WHERE_Q)
      await node(pepper).next('message.completed', (f) => f.data.message.content === 'Hangar 3.')
      expect(systemOf(whereReq)).toContain(MEMO)
      expect(systemOf(whereReq)).not.toContain('- Rhodey (tier: member)')
      // Rhodey no longer sees the group's memory, and his node got nothing more of the group.
      const removedAt = node(rhodey).frames.findIndex((f) => f.type === 'thread.removed')
      expect(requestText(await directAsk(rhodey, 'Anything new for me?'))).not.toContain(MEMO)
      expect(JSON.stringify(node(rhodey).frames.slice(removedAt + 1))).not.toContain('Hangar 3.')

      // The private aside never reached a group request.
      for (const req of chat.requests.filter(isGroupRequest)) {
        expect(requestText(req)).not.toContain(PRIVATE_Q)
        expect(requestText(req)).not.toContain(PRIVATE_A)
      }
      expect(chat.unmatched.map((r) => lastUser(r))).toEqual([])
    },
    S6_TIMEOUT_MS,
  )
})
