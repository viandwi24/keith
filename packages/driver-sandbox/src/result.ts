// The outcome helpers of a call: an answer with its output, or a failure with the code the core reports.
import type { CapabilityResult, DriverFailureCode } from '@keith/driver-sdk'

export const ok = (output: unknown, exitCode?: number): CapabilityResult => ({
  ok: true,
  output,
  ...(exitCode === undefined ? {} : { exitCode }),
})

export const failed = (message: string, code: DriverFailureCode = 'failed'): CapabilityResult => ({
  ok: false,
  code,
  message,
})
