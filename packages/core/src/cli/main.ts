#!/usr/bin/env bun
// The `keith` executable (`bin` of @keith/core).

import { runCli } from './index.ts'

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
  // Keith is stopped; don't wait for handles a plugin may have left open.
  process.exit()
}
