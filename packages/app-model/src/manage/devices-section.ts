import type { DeviceList, TokenInfo } from '@keith/contracts'
import { DEVICES_HEADER, DEVICES_WIDTHS, deviceRow, pendingRow, tokenRow } from './devices-state.ts'
import type { ActionSpec, SectionEnv, SectionModel } from './types.ts'

const NO_DEVICES: DeviceList = { pending: [], devices: [] }

/** Devices that log in with a code, and long-lived tokens. */
export function devicesSection(env: SectionEnv): SectionModel<{
  devices: DeviceList
  tokens: TokenInfo[]
}> {
  const { client, caps } = env
  const canDevices = caps.has('devices.manage')
  const canTokens = caps.has('tokens.manage')
  const revoke = (kind: 'device' | 'token', id: string, label: string): ActionSpec => ({
    id: `${kind}s.revoke`,
    label: 'Revoke',
    hint: kind === 'device' ? 'log the device out' : 'the token stops working',
    confirm: { text: `Revoke ${kind} ${label}? It stops working at once.` },
    run: async () => {
      if (kind === 'device') await client.rpc.admin.devices.revoke({ id })
      else await client.rpc.admin.tokens.revoke({ id })
      return { message: `${kind} ${label}: revoked` }
    },
  })
  const actions: ActionSpec[] = []
  if (canDevices)
    actions.push(
      {
        id: 'devices.approve',
        label: 'Approve a login',
        hint: 'type the code the device shows',
        fields: [
          { id: 'code', label: 'Code', placeholder: 'ABCD-EFGH' },
          { id: 'label', label: 'Device name', optional: true },
        ],
        run: async (v) => {
          const label = (v.label ?? '').trim()
          const done = await client.rpc.admin.devices.approve({
            code: (v.code ?? '').trim(),
            ...(label === '' ? {} : { label }),
          })
          return { message: `approved: ${done.label} (${done.credentialId})` }
        },
      },
      {
        id: 'devices.deny',
        label: 'Deny a login',
        fields: [{ id: 'code', label: 'Code', placeholder: 'ABCD-EFGH' }],
        run: async (v) => {
          await client.rpc.admin.devices.deny({ code: (v.code ?? '').trim() })
          return { message: 'denied' }
        },
      },
    )
  if (canTokens)
    actions.push({
      id: 'tokens.create',
      label: 'Create a token',
      hint: 'for scripts; shown once',
      fields: [{ id: 'label', label: 'Label', placeholder: 'ci' }],
      run: async (v) => {
        const label = (v.label ?? '').trim()
        const created = await client.rpc.admin.tokens.create({ label })
        return {
          note: {
            title: 'New token',
            once: true,
            lines: [created.token, `label ${label} · id ${created.id}`],
          },
        }
      },
    })
  return {
    load: async () => ({
      devices: canDevices ? await client.rpc.admin.devices.list() : NO_DEVICES,
      tokens: canTokens ? await client.rpc.admin.tokens.list() : [],
    }),
    build: (d) => ({
      lines: [],
      header: DEVICES_HEADER,
      widths: DEVICES_WIDTHS,
      rows: [
        ...(d?.devices ?? NO_DEVICES).pending.map(pendingRow),
        ...(d?.devices ?? NO_DEVICES).devices.map((x) =>
          deviceRow(x, [revoke('device', x.id, x.label)]),
        ),
        ...(d?.tokens ?? []).map((t) => tokenRow(t, [revoke('token', t.id, t.label)])),
      ],
      empty: 'No devices or tokens yet.',
      actions,
    }),
  }
}
