import { defineDriver } from '../../../index.ts'

// declares fixture.pong, the manifest says fixture.ping: loadDriver must refuse the mismatch
export default defineDriver({
  name: 'fixture',
  version: '0.1.0',
  capabilities: [{ id: 'fixture.pong', schemaVersion: 1 }],
  invoke: () => ({ ok: true, output: null }),
})
