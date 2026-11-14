#!/usr/bin/env bun
// `keith-core`: run and administer the core. The work is in cli/.
import { processIo } from '@keith/cli'
import { runCoreCli } from './cli/program.ts'
import { applyUmask } from './platform/bootstrap.ts'

applyUmask()
process.exit(await runCoreCli(Bun.argv.slice(2), processIo()))
