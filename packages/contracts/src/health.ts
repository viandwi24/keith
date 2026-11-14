import { z } from 'zod'

export const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  /** Short git SHA of the running build, `unknown` outside a git checkout. */
  sha: z.string(),
  /** Changes on every core start; a client uses it to notice a restart. */
  boot: z.string(),
})
export type Health = z.infer<typeof HealthSchema>
