import type { DoctorCheck } from '../types.ts'

/** The system date is plausible (a dead clock breaks expiry and audit order). */
export const clockCheck: DoctorCheck = () => [
  new Date().getFullYear() >= 2026
    ? { level: 'ok', name: 'clock', hint: new Date().toISOString() }
    : {
        level: 'fail',
        name: 'clock',
        hint: `system date looks wrong (${new Date().toISOString()})`,
      },
]
