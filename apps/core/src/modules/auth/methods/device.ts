import type { AuthMethod } from './types.ts'

/**
 * Device code: the code is shown on this client and the owner approves it elsewhere. The routes
 * (`/auth/device/start|poll`) stay in `../device.ts`; this adapter is the data the registry lists.
 */
export const deviceMethod: AuthMethod = {
  id: 'device',
  label: 'Device code',
  assurance: 0,
  interaction: 'poll',
  firstStep: {
    id: 'device',
    title: 'Device code',
    help: 'Approve the code on a device that is already signed in.',
    fields: [],
  },
  refusal: 'not accepted from this network: use a private network address or the device code',
}
