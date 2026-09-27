/** `@keith/vad-energy`: a dependency-free energy VAD behind the `VadProvider` seam (ADR-0013). */
import { definePlugin } from '@keith/sdk'
import { createEnergyVad, energyVadOptions } from './vad.ts'

export {
  createEnergyVad,
  ENERGY_VAD_ID,
  type EnergyVadOptions,
  type EnergyVadOptionsInput,
  energyVadOptions,
  levelDb,
} from './vad.ts'

export default definePlugin({
  id: '@keith/vad-energy',
  namespace: 'vad_energy',
  version: '0.0.0',
  kind: 'provider',
  config: energyVadOptions,
  setup(ctx) {
    ctx.providers.vad.register(createEnergyVad(ctx.config))
  },
})
