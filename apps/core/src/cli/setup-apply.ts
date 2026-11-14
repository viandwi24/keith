import type { AccessMode, PrimaryModelRole } from '@keith/contracts'
import type { OfflineAdmin } from '../modules/admin/index.ts'
import type { Hasher } from '../modules/auth/index.ts'
import { budgetFlag } from './prompt-helpers.ts'
import {
  markSetupDone,
  modelRef,
  ownerSignInKinds,
  putProvider,
  ROLES,
  recordOwnerSignIn,
  type SetupSummary,
  saveAccess,
  saveBudget,
  saveOwnerName,
  saveOwnerPin,
  saveRole,
} from './setup-steps.ts'

/** Everything the wizard collected, written in one go when the owner confirms the summary. */
export interface SetupAnswers {
  name: string
  /** The provider to save; undefined when skipped (or only the connection already there is used). */
  provider?: {
    pid: string
    /** A connection of this id exists (its key is kept unless a new one is given). */
    exists: boolean
    /** A new API key; undefined keeps the saved one or takes the environment's. */
    apiKey?: string | undefined
  }
  /** The connection the models belong to (the saved one, or the one `provider` creates). */
  connection?: string | undefined
  models?: Record<PrimaryModelRole, string> | undefined
  /** The budget as typed: a number of USD, or `none`. */
  budget: string
  mode: AccessMode
  publicUrl?: string | undefined
  pin?: string | undefined
}

/**
 * Write the answers through the offline admin, in the order of the line-prompt flow: name,
 * provider, models, budget, access, then (when asked) the owner PIN, and last the setup mark.
 * Throws with a readable message when the PIN is refused; nothing after that is written.
 */
export async function applySetup(
  admin: OfflineAdmin,
  answers: SetupAnswers,
  hasher?: Hasher,
): Promise<SetupSummary> {
  await saveOwnerName(admin, answers.name)
  const { provider, connection } = answers
  if (provider !== undefined && (provider.apiKey !== undefined || !provider.exists)) {
    await putProvider(admin, {
      pid: provider.pid,
      exists: provider.exists,
      settings: provider.apiKey === undefined ? undefined : { apiKey: provider.apiKey },
    })
  }
  let models: Record<PrimaryModelRole, string> | undefined
  if (connection !== undefined && answers.models !== undefined) {
    models = {} as Record<PrimaryModelRole, string>
    for (const role of ROLES) {
      const ref = modelRef(connection, answers.models[role])
      await saveRole(admin, role, ref)
      models[role] = ref
    }
  }
  const budget = budgetFlag(answers.budget)
  saveBudget(admin, budget)
  const access = saveAccess(admin, { mode: answers.mode, publicUrl: answers.publicUrl })
  if (answers.pin !== undefined) {
    const problem = await saveOwnerPin(admin, answers.pin, hasher)
    if (problem !== undefined) throw new Error(`the PIN was refused: ${problem}`)
  }
  // required: without a PIN or a password nobody could sign in to the socket
  const signIn = ownerSignInKinds(admin)
  if (signIn.length === 0) throw new Error('the owner needs a PIN to sign in')
  if (answers.pin !== undefined) recordOwnerSignIn(admin, signIn)
  markSetupDone(admin)
  return { owner: answers.name, connection, models, budget, access, signIn }
}
