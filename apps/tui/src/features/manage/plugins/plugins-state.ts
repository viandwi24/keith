import type { PluginDetail, PluginInfo } from '@keith/contracts'
import { G } from '@keith/ui'
import type { NoteSpec, Row } from '../manage-types.ts'

export const PLUGINS_HEADER = ['PLUGIN', 'STATUS', 'VERSION', 'REVIEWS'] as const
export const PLUGINS_WIDTHS = [14, 14, 9] as const

const GLYPH = { enabled: G.dot, disabled: G.idle, failed: G.failed } as const

/** `● enabled`, and `● enabled` plus what the setting says when it differs from what this boot runs. */
export function statusCell(p: PluginInfo): string {
  return `${GLYPH[p.state]} ${p.state}`
}

/** What the line under the list says about the selected plugin. */
export function pluginDetail(p: PluginInfo): string {
  if (p.state === 'failed') return `failed to load: ${p.reason ?? 'no reason recorded'}`
  const title = p.title === null ? p.id : p.title
  if (p.restartPending)
    return `${title}: set to ${p.nextBoot}; this takes effect at the next boot of the core`
  return title
}

/** The row of a plugin; `actions` are filled in by the hook. */
export function pluginRow(p: PluginInfo, actions: Row['actions']): Row {
  return {
    id: p.id,
    cells: [
      p.id,
      statusCell(p),
      p.version,
      p.pendingReviews === 0 ? '-' : String(p.pendingReviews),
    ],
    ...(p.state === 'failed'
      ? { tone: 'danger' as const }
      : p.state === 'disabled'
        ? { tone: 'muted' as const }
        : {}),
    detail: pluginDetail(p),
    actions,
  }
}

/** Whether the setting turns this plugin on at the next boot: the toggle offers the opposite. */
export const wantsOn = (p: PluginInfo): boolean => p.nextBoot === 'enabled'

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** The read-only detail view: status, capabilities, operations, timers, reviews waiting. */
export function detailNote(d: PluginDetail): NoteSpec {
  const lines: string[] = [`${d.id} ${d.version}${d.title === null ? '' : ` · ${d.title}`}`]
  if (d.description !== null) lines.push(d.description)
  lines.push(`status ${d.state}${d.restartPending ? ` (setting: ${d.nextBoot} at next boot)` : ''}`)
  if (d.reason !== null) lines.push(`reason ${d.reason}`)
  lines.push(`reviews waiting ${d.pendingReviews}`)
  lines.push(
    d.schedules === null
      ? 'timers (not loaded)'
      : `timers ${d.schedules.active} waiting${
          d.schedules.nextAt === null ? '' : `, next ${when(d.schedules.nextAt)} UTC`
        }`,
  )
  lines.push('', 'capabilities')
  if (d.capabilities.length === 0) lines.push('  (none of its own)')
  for (const c of d.capabilities)
    lines.push(`  ${c.id}${c.roles.length === 0 ? '' : ` [${c.roles.join(', ')}]`}`)
  lines.push('', 'operations')
  for (const o of d.operations)
    lines.push(
      `  ${o.name} · ${o.capability}${o.review ? ' · review' : ''}${o.audience === 'user' ? '' : ` · ${o.audience}`}`,
    )
  return { title: `Plugin ${d.id}`, lines }
}
