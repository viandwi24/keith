import type { CliIo } from '@keith/cli'
import type { Config } from '../platform/config.ts'
import type { Check } from './doctor.ts'
import type { SetupSummary } from './setup-steps.ts'

/** How the setup wizard ended: everything saved, or the owner left and nothing was. */
export type WizardOutcome = { status: 'saved'; summary: SetupSummary } | { status: 'cancelled' }

/** What the owner picked on the home screen (Doctor stays on the screen and is not a choice). */
export type HomeChoice = 'start' | 'setup' | 'quit'

export interface HomeProps {
  /** A line above the menu (`Setup saved.`). */
  notice?: string | undefined
  /** Runs the doctor checks; the screen shows them. */
  doctor(): Promise<Check[]>
}

/** What the console needs from outside; the defaults are the real process, tests override. */
export interface ConsoleDeps {
  /** Whether a core answers on this socket path (default: `probeSocket`). */
  probe?: (socketPath: string) => Promise<boolean>
  /** Path of an executable on PATH, or null (default: `Bun.which`). */
  which?: (name: string) => string | null
  /** Run a command with inherited stdio and wait for its exit code (default: `Bun.spawn`). */
  spawn?: (command: string[]) => Promise<number>
  /** Run core in this process (default: `startCore`). */
  start?: (io: CliIo) => Promise<number>
  /** The owner sign-in offer asked before Start (default: `ensureOwnerSignIn`, as in `start`). */
  ownerSignIn?: (io: CliIo) => Promise<unknown>
  /** Whether setup completed in this data folder (default: reads the database). */
  configured?: (config: Config) => boolean
  /** The full-screen views (tests replace them; the defaults draw with Ink). */
  ui?: {
    wizard?: (io: CliIo, config: Config) => Promise<WizardOutcome>
    home?: (props: HomeProps, config: Config) => Promise<HomeChoice>
  }
}
