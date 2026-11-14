import { driverLines, formatLastSeen, nodeIcon, refusedLines } from '../../nodes/index.ts'
import type { ActionSpec, ManageEnv, Row, SectionData } from '../manage-types.ts'

const when = (ms: number | null): string => formatLastSeen(ms, Date.now())

/** Nodes: the app's live registry, with pair and revoke for a `nodes.manage` holder. */
export function useNodesSection(env: ManageEnv): SectionData {
  const { client, nodes, caps } = env
  const manage = caps.has('nodes.manage')
  const rows: Row[] = nodes.nodes.map((n) => ({
    id: n.id,
    cells: [
      `${nodeIcon(n.status)} ${n.name}`,
      n.status,
      `${n.os}/${n.arch}`,
      `seen ${when(n.lastSeenAt)}`,
    ],
    ...(n.status === 'online'
      ? {}
      : { tone: n.status === 'revoked' ? ('danger' as const) : ('muted' as const) }),
    detail: [
      `v${n.version}`,
      ...driverLines(n),
      ...refusedLines(n),
      `shell ${n.allowShell ? 'allowed' : 'off'}`,
    ].join(' · '),
    actions:
      manage && n.status !== 'revoked'
        ? [
            {
              id: 'nodes.revoke',
              label: 'Revoke',
              hint: 'the node can no longer connect',
              confirm: { text: `Revoke node ${n.name}? It can no longer connect.` },
              run: async () => {
                await client.rpc.nodes.revoke({ id: n.id })
                return { message: `node ${n.name}: revoked` }
              },
            } satisfies ActionSpec,
          ]
        : [],
  }))
  return {
    lines: [],
    header: ['NODE', 'STATE', 'PLATFORM', 'LAST SEEN'],
    widths: [20, 8, 14],
    rows,
    empty: manage
      ? 'No nodes yet. Press n to pair one.'
      : 'No nodes yet. Ask the owner to pair one.',
    actions: manage
      ? [
          {
            id: 'nodes.pair',
            label: 'Pair a node',
            hint: 'a code for keith-node join; shown once',
            run: async () => {
              const pairing = await client.rpc.nodes.pair()
              return {
                note: {
                  title: 'Pair a node',
                  once: true,
                  lines: [
                    pairing.code,
                    `valid until ${new Date(pairing.expiresAt).toISOString().slice(11, 16)} UTC`,
                    `run on the new node: ${pairing.joinCommand}`,
                  ],
                },
              }
            },
          },
        ]
      : [],
    error: nodes.error,
    loading: false,
    reload: nodes.reload,
  }
}
