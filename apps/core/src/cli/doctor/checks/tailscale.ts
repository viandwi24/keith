import type { DoctorCheck } from '../types.ts'

async function tailscalePresent(): Promise<boolean> {
  try {
    const r = await Bun.$`tailscale version`.quiet().nothrow()
    return r.exitCode === 0
  } catch {
    return false
  }
}

/** Remote mode only: the tailscale binary is installed. */
export const tailscaleCheck: DoctorCheck = async ({ net, deps }) => {
  if (net.mode !== 'remote') return []
  const present = await (deps.tailscale ?? tailscalePresent)()
  return [
    present
      ? { level: 'ok', name: 'tailscale', hint: 'installed' }
      : {
          level: 'warn',
          name: 'tailscale',
          hint: 'not found: install it, or reach core another way',
        },
  ]
}
