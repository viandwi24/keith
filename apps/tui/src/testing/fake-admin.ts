import type {
  Access,
  AuditEvent,
  AuditRetentionView,
  BudgetPerson,
  DeviceList,
  GroupView,
  MyAuditEvent,
  Node,
  Person,
  PluginDetail,
  PluginInfo,
  ReviewView,
  TokenInfo,
} from '@keith/contracts'
import { CAPABILITY_IDS, keithContract, OWNER_ONLY_CAPABILITIES } from '@keith/contracts'

/** Whether the contract marks a procedure (`admin/people/add`) as a sensitive call (`stepUp`). */
export function isSensitive(name: string): boolean {
  let node: unknown = keithContract
  for (const part of name.split('/')) node = (node as Record<string, unknown> | undefined)?.[part]
  const meta = (node as { '~orpc'?: { meta?: { stepUp?: boolean } } } | undefined)?.['~orpc']?.meta
  return meta?.stepUp === true
}

export interface FakeAdminCall {
  /** `admin/people/add` */
  name: string
  input: unknown
}

export interface FakeAdmin {
  /** Every admin procedure the TUI called, in order, with its input. */
  calls: FakeAdminCall[]
  /** Pass as `rpc` of `setupApp` / `startFakeCore`. */
  rpc: Record<string, (input: unknown) => unknown>
  people: Person[]
  tokens: TokenInfo[]
  devices: DeviceList
  nodes: Node[]
  audit: AuditEvent[]
  /** What `admin/audit/mine` returns: the lines about the caller. */
  mine: MyAuditEvent[]
  access: Access
  groups: GroupView[]
  plugins: PluginInfo[]
  reviews: ReviewView[]
  retention: AuditRetentionView
  /** Per-person budget rows `budget/get` returns for an owner. */
  budgetPeople: BudgetPerson[]
  grants: Map<string, string[]>
  /** The inputs of every call to `name`. */
  inputs(name: string): unknown[]
}

const NOW = Date.UTC(2026, 9, 28, 9, 41)

const person = (
  id: string,
  username: string,
  role: 'owner' | 'member',
  status: Person['status'] = 'active',
): Person => ({
  id,
  username,
  name: username[0]?.toUpperCase() + username.slice(1),
  role,
  status,
  canLogin: true,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
})

/**
 * The admin procedures of the fake core (people, devices, tokens, nodes, providers, models, access,
 * budget, audit) over small in-memory tables. Each call is recorded with its input.
 */
export function createFakeAdmin(): FakeAdmin {
  const calls: FakeAdminCall[] = []
  const people = [
    person('owner', 'owner', 'owner'),
    person('ana-id', 'ana', 'member'),
    person('bo-id', 'bo', 'member', 'suspended'),
  ]
  const tokens: TokenInfo[] = [
    {
      id: 'tok1',
      label: 'ci',
      personId: 'owner',
      createdAt: NOW,
      revokedAt: null,
      legacy: false,
      lastSeenAt: null,
    },
  ]
  const devices: DeviceList = {
    pending: [
      { id: 'req1', label: 'laptop', ip: '10.0.0.5', createdAt: NOW, expiresAt: NOW + 600_000 },
    ],
    devices: [
      {
        id: 'dev1',
        label: 'phone',
        createdAt: NOW,
        lastSeenAt: NOW,
        lastIp: '10.0.0.9',
        revokedAt: null,
      },
    ],
  }
  const nodes: Node[] = []
  const audit: AuditEvent[] = [
    { id: 1, at: NOW, kind: 'people.add', actor: 'owner', via: 'local', detail: { person: 'ana' } },
  ]
  const mine: MyAuditEvent[] = [
    {
      id: 5,
      at: NOW,
      kind: 'acl.owner-access',
      actorName: 'Vian',
      summary: 'looked at 3 of your notes',
      resource: { kind: 'note', count: 3 },
    },
  ]
  const access: Access = {
    mode: 'local',
    host: '127.0.0.1',
    port: 7777,
    proxy: 'none',
    publicUrl: null,
    restartRequired: false,
  }
  const groups: GroupView[] = [
    { id: 'g-fam', name: 'family', createdBy: 'owner', createdAt: NOW, members: [], usage: 0 },
  ]
  const plugins: PluginInfo[] = ['notes', 'reminders'].map((id) => ({
    id,
    version: '1.0.0',
    title: id === 'notes' ? 'Notes' : 'Reminders',
    state: 'enabled' as const,
    reason: null,
    nextBoot: 'enabled' as const,
    restartPending: false,
    pendingReviews: id === 'reminders' ? 1 : 0,
  }))
  const reviews: ReviewView[] = [
    {
      id: 'rev-1',
      requester: { id: 'ana-id', username: 'ana', name: 'Ana' },
      plugin: 'reminders',
      operation: 'create',
      payload: { text: 'call the dentist', to: 'bo', at: '2026-11-10T09:00:00Z' },
      status: 'pending',
      reason: null,
      outcome: null,
      createdAt: NOW,
      expiresAt: NOW + 7 * 86_400_000,
      decidedAt: null,
      decidedBy: null,
    },
  ]
  const findPlugin = (ref: unknown): PluginInfo => {
    const id = (ref as { id: string }).id
    const found = plugins.find((p) => p.id === id)
    if (found === undefined) throw new Error(`no plugin "${id}"`)
    return found
  }
  const toggle = (ref: unknown, on: boolean) => {
    const p = findPlugin(ref)
    const changed = p.nextBoot !== (on ? 'enabled' : 'disabled')
    p.nextBoot = on ? 'enabled' : 'disabled'
    p.restartPending = p.state !== p.nextBoot
    return { plugin: p, changed, effective: 'next-boot' as const }
  }
  const findReview = (ref: unknown): ReviewView => {
    const id = (ref as { id: string }).id
    const found = reviews.find((r) => r.id === id && r.status === 'pending')
    if (found === undefined) throw new Error('no such pending review')
    return found
  }
  const retention: AuditRetentionView = { days: 180, defaultDays: 180, maxDays: 3650 }
  const budgetPeople: BudgetPerson[] = [
    {
      personId: 'ana-id',
      username: 'ana',
      name: 'Ana',
      limitUsd: null,
      spentUsd: 1.5,
      reservedUsd: 0,
      remainingUsd: null,
    },
  ]
  const grants = new Map<string, string[]>()
  const connections = [
    {
      id: 'openrouter',
      providerId: 'openrouter',
      label: 'OpenRouter',
      enabled: true,
      source: 'store',
      settings: { apiKey: { set: true } },
      updatedAt: NOW,
    },
  ]
  const roles: { front: string | null; cortex: string | null } = { front: null, cortex: null }
  const find = (ref: unknown): Person => {
    const key = (ref as { person: string }).person
    const found = people.find((p) => p.id === key || p.username === key)
    if (found === undefined) throw new Error(`no such person: ${key}`)
    return found
  }
  const findGroup = (ref: unknown): GroupView => {
    const key = (ref as { group: string }).group
    const found = groups.find((g) => g.id === key || g.name === key)
    if (found === undefined) throw new Error(`no such group: ${key}`)
    return found
  }
  const ok = { ok: true as const }
  const record =
    <T>(name: string, fn: (input: unknown) => T) =>
    (input: unknown): T => {
      calls.push({ name, input })
      return fn(input)
    }
  const raw: Record<string, (input: unknown) => unknown> = {
    'admin/people/list': () => people,
    'admin/people/get': (i) => find(i),
    'admin/people/add': (i) => {
      const { username, name, role } = i as {
        username: string
        name?: string
        role?: 'owner' | 'member'
      }
      const p = {
        ...person(`${username}-id`, username, role ?? 'member'),
        ...(name === undefined ? {} : { name }),
      }
      people.push(p)
      return p
    },
    'admin/people/rename': (i) => {
      const p = find(i)
      const { username, name } = i as { username?: string; name?: string }
      if (username !== undefined) p.username = username
      if (name !== undefined) p.name = name
      return p
    },
    'admin/people/setRole': (i) =>
      Object.assign(find(i), { role: (i as { role: 'owner' | 'member' }).role }),
    'admin/people/suspend': (i) => Object.assign(find(i), { status: 'suspended' }),
    'admin/people/reactivate': (i) => Object.assign(find(i), { status: 'active' }),
    'admin/people/remove': (i) => {
      people.splice(people.indexOf(find(i)), 1)
      return ok
    },
    'admin/people/transferOwner': (i) => {
      const next = find(i)
      const previous = people.find((p) => p.role === 'owner') ?? next
      previous.role = 'member'
      next.role = 'owner'
      return { owner: next, previousOwner: previous }
    },
    'admin/people/setPassword': () => ok,
    'admin/people/setPin': () => ok,
    'admin/people/clearSecret': () => ok,
    'admin/people/unlock': () => ({ ok: true, wasLocked: true }),
    'admin/people/grants': (i) => grants.get(find(i).id) ?? [],
    'admin/people/grant': (i) => {
      const { capability } = i as { capability: string }
      const list = [...(grants.get(find(i).id) ?? []), capability]
      grants.set(find(i).id, list)
      return list
    },
    'admin/people/revokeGrant': (i) => {
      const { capability } = i as { capability: string }
      const list = (grants.get(find(i).id) ?? []).filter((c) => c !== capability)
      grants.set(find(i).id, list)
      return list
    },
    'admin/groups/list': () => groups,
    'admin/groups/get': (i) => findGroup(i),
    'admin/groups/create': (i) => {
      const { name } = i as { name: string }
      if (groups.some((g) => g.name === name)) throw new Error(`the group ${name} exists`)
      const g: GroupView = {
        id: `g-${name}`,
        name,
        createdBy: 'owner',
        createdAt: NOW,
        members: [],
        usage: 0,
      }
      groups.push(g)
      return g
    },
    'admin/groups/delete': (i) => {
      const g = findGroup(i)
      if (g.usage > 0)
        throw new Error(
          `${g.name} is used by ${g.usage} resource${g.usage === 1 ? '' : 's'}: unshare or change their team first`,
        )
      groups.splice(groups.indexOf(g), 1)
      return ok
    },
    'admin/groups/add': (i) => {
      const g = findGroup(i)
      const p = find(i)
      if (!g.members.some((m) => m.id === p.id))
        g.members.push({ id: p.id, username: p.username, name: p.name, status: p.status })
      return g
    },
    'admin/groups/remove': (i) => {
      const g = findGroup(i)
      const p = find(i)
      g.members = g.members.filter((m) => m.id !== p.id)
      return g
    },
    'admin/plugins/list': () => plugins,
    'admin/plugins/show': (i): PluginDetail => ({
      ...findPlugin(i),
      description: 'A fake plugin.',
      capabilities: [],
      operations: [
        {
          name: 'create',
          description: 'Create one.',
          capability: 'authenticated',
          audience: 'user',
          risk: 'write',
          review: true,
          ai: true,
          http: true,
        },
      ],
      schedules: { active: 2, nextAt: NOW + 3_600_000 },
    }),
    'admin/plugins/enable': (i) => toggle(i, true),
    'admin/plugins/disable': (i) => toggle(i, false),
    'admin/capabilities/list': () => [
      ...CAPABILITY_IDS.map((id) => ({
        id,
        owner: 'core',
        description: null,
        ownerOnly: (OWNER_ONLY_CAPABILITIES as readonly string[]).includes(id),
      })),
      { id: 'notes.share', owner: 'notes', description: 'Share notes', ownerOnly: false },
    ],
    'admin/reviews/list': (i) => {
      const { status } = i as { status?: string }
      return reviews.filter((r) => status === undefined || r.status === status)
    },
    'admin/reviews/approve': (i) =>
      Object.assign(findReview(i), { status: 'approved', outcome: 'ok', decidedBy: 'owner' }),
    'admin/reviews/deny': (i) =>
      Object.assign(findReview(i), {
        status: 'denied',
        reason: (i as { reason?: string }).reason ?? null,
        decidedBy: 'owner',
      }),
    'admin/audit/retention/get': () => retention,
    'admin/audit/retention/set': (i) => Object.assign(retention, i),
    'admin/devices/list': () => devices,
    'admin/devices/approve': (i) => ({
      credentialId: 'cred1',
      label: (i as { label?: string }).label ?? 'device',
    }),
    'admin/devices/deny': () => ok,
    'admin/devices/revoke': () => ok,
    'admin/tokens/list': () => tokens,
    'admin/tokens/create': (i) => ({
      id: 'tok2',
      token: `keith_${'t'.repeat(8)}_${(i as { label: string }).label}`,
    }),
    'admin/tokens/revoke': () => ok,
    'admin/audit/list': () => audit,
    'admin/audit/mine': () => mine,
    'admin/access/get': () => access,
    'admin/access/set': (i) => Object.assign(access, i),
    'nodes/list': () => nodes,
    'nodes/pair': () => ({
      code: 'ABCD-EFGH',
      expiresAt: NOW + 600_000,
      joinCommand: 'keith-node join --core http://x --code ABCD-EFGH',
    }),
    'nodes/revoke': () => ok,
    'providers/describe': () => [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        fields: [
          {
            path: 'apiKey',
            kind: 'string',
            label: 'API key',
            required: true,
            secret: true,
            secretValues: false,
            group: 'auth',
          },
        ],
        canListModels: true,
        canTest: true,
      },
    ],
    'providers/list': () => connections,
    'providers/put': (i) => {
      const { id, providerId } = i as { id?: string; providerId?: string }
      const saved = {
        ...connections[0],
        id: id ?? providerId ?? 'x',
        providerId: providerId ?? 'x',
      }
      return saved
    },
    'providers/remove': () => ok,
    'providers/test': () => ({ ok: true, latencyMs: 12 }),
    'models/roles/get': () => roles,
    'models/price/list': () => [],
    'models/price/set': (i) => i,
    'models/price/clear': () => ({ ok: true }),
    'models/roles/set': (i) =>
      Object.assign(roles, { [(i as { role: string }).role]: (i as { ref: string }).ref }),
    'budget/set': (i) => ({
      scope: 'owner',
      limitUsd: (i as { limitUsd: number | null }).limitUsd,
      spentUsd: 0,
      reservedUsd: 0,
      remainingUsd: null,
      periodStart: 0,
      periodEnd: 1,
      unpriced: [],
    }),
    'budget/setPersonCap': (i) => ({
      ...budgetPeople[0],
      limitUsd: (i as { usd: number | null }).usd,
    }),
  }
  const rpc = Object.fromEntries(Object.entries(raw).map(([name, fn]) => [name, record(name, fn)]))
  return {
    calls,
    rpc,
    people,
    tokens,
    devices,
    nodes,
    audit,
    mine,
    access,
    groups,
    plugins,
    reviews,
    retention,
    budgetPeople,
    grants,
    inputs: (name) => calls.filter((c) => c.name === name).map((c) => c.input),
  }
}
