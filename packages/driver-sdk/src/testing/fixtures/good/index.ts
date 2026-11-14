import { defineDriver } from '../../../index.ts'

export default defineDriver({
  name: 'fixture',
  version: '0.1.0',
  capabilities: [{ id: 'fixture.ping', schemaVersion: 1 }],
  invoke: (call) => ({ ok: true, output: { pong: call.input } }),
})
