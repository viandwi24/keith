// Runs `keith start --port 0` with a fake LLM whose replies stall after the first delta, for the
// signal shutdown test. KEITH_HOME comes from the environment.

import { createFakeLlm, createFakeLlmPlugin, fakeDelay, fakeText } from '@keith/sdk/testing'
import { runCli } from '../../src/cli/index.ts'

const fake = createFakeLlm([], {
  fallback: [...fakeText('Partial'), fakeDelay(60_000), ...fakeText(' never')],
})

process.exitCode = await runCli(['start', '--port', '0'], {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  bootstrap: { plugins: [createFakeLlmPlugin(fake)] },
})
process.exit()
