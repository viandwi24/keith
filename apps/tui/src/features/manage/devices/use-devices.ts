import type { DeviceList, TokenInfo } from '@keith/contracts'
import type { ActionSpec, ManageEnv, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { DEVICES_HEADER, DEVICES_WIDTHS, deviceRow, pendingRow, tokenRow } from './devices-state.ts'

const NO_DEVICES: DeviceList = { pending: [], devices: [] }

/** Devices that log in with a code, and long-lived tokens. */
export function useDevices(env: ManageEnv): SectionData {
  const { client, caps } = env
  const canDevices = caps.has('devices.manage')
  const canTokens = caps.has('tokens.manage')
  const devices = useLoad(() =>
    canDevices ? client.rpc.admin.devices.list() : Promise.resolve(NO_DEVICES),
  )
  const tokens = useLoad<TokenInfo[]>(() =>
    canTokens ? client.rpc.admin.tokens.list() : Promise.resolve([]),
  )
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
  const list = devices.data ?? NO_DEVICES
  return {
    lines: [],
    header: DEVICES_HEADER,
    widths: DEVICES_WIDTHS,
    rows: [
      ...list.pending.map(pendingRow),
      ...list.devices.map((d) => deviceRow(d, [revoke('device', d.id, d.label)])),
      ...(tokens.data ?? []).map((t) => tokenRow(t, [revoke('token', t.id, t.label)])),
    ],
    empty: 'No devices or tokens yet.',
    actions,
    error: devices.error ?? tokens.error,
    loading: devices.loading || tokens.loading,
    reload: () => {
      devices.reload()
      tokens.reload()
    },
  }
}
