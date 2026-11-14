import type { Access, AuditRetentionView } from '@keith/contracts'
import type { ActionSpec, ManageEnv, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'

/** The lines that describe the access settings. */
export const accessLines = (a: Access): string[] => [
  `mode      ${a.mode}`,
  `bind      ${a.host}:${a.port}`,
  `public    ${a.publicUrl ?? '(none)'}`,
  `proxy     ${a.proxy}`,
  ...(a.restartRequired ? ['The bind address changed: stop core, then keith-core start.'] : []),
]

/** The audit retention line: how long the log is kept (`0` keeps everything). */
export const retentionLine = (r: AuditRetentionView): string =>
  `audit     ${r.days === 0 ? 'kept forever' : `kept ${r.days} days`}`

/** Access: who can reach core, local or remote (`admin.access.get` / `set`). */
export function useAccess(env: ManageEnv): SectionData {
  const { client } = env
  const load = useLoad(async () => ({
    access: await client.rpc.admin.access.get(),
    // a person granted settings.manage without audit.read has no retention to show
    retention: await client.rpc.admin.audit.retention.get().catch(() => undefined),
  }))
  const a = load.data?.access
  const retention = load.data?.retention
  const change: ActionSpec = {
    id: 'access.set',
    label: 'Change access',
    hint: 'local or remote',
    fields: [
      { id: 'mode', label: 'Mode', options: ['local', 'remote'], initial: a?.mode ?? 'local' },
      {
        id: 'publicUrl',
        label: 'Public URL',
        optional: true,
        initial: a?.publicUrl ?? '',
        placeholder: 'https://…',
      },
      { id: 'host', label: 'Bind address', optional: true, placeholder: 'derived from the mode' },
      {
        id: 'proxy',
        label: 'Proxy',
        options: ['none', 'tailscale-serve'],
        initial: a?.proxy ?? 'none',
      },
    ],
    run: async (v) => {
      const mode = v.mode === 'remote' ? 'remote' : 'local'
      const url = (v.publicUrl ?? '').trim()
      const host = (v.host ?? '').trim()
      const set = await client.rpc.admin.access.set({
        mode,
        ...(url === '' ? (mode === 'local' ? { publicUrl: null } : {}) : { publicUrl: url }),
        ...(host === '' ? {} : { host }),
        proxy: v.proxy === 'tailscale-serve' ? 'tailscale-serve' : 'none',
      })
      return {
        message: `access: ${set.mode}, public url ${set.publicUrl ?? '(none)'}, proxy ${set.proxy}${set.restartRequired ? '. Restart needed: the bind address changed' : ''}`,
      }
    },
  }
  const keep: ActionSpec = {
    id: 'access.retention',
    label: 'Audit retention',
    hint: 'days kept, 0 keeps everything',
    fields: [
      {
        id: 'days',
        label: 'Days',
        initial: retention === undefined ? '' : String(retention.days),
      },
    ],
    run: async (v) => {
      const text = (v.days ?? '').trim()
      if (!/^\d+$/.test(text)) throw new Error('days must be a whole number (0 keeps everything)')
      const set = await client.rpc.admin.audit.retention.set({ days: Number(text) })
      return { message: `audit kept ${set.days === 0 ? 'forever' : `${set.days} days`}` }
    },
  }
  return {
    lines:
      a === undefined
        ? []
        : [...accessLines(a), ...(retention === undefined ? [] : [retentionLine(retention)])],
    rows: [],
    actions: a === undefined ? [] : retention === undefined ? [change] : [change, keep],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
