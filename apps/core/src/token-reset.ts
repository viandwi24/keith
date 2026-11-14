// `bun run --filter @keith/core token:reset`: alias of `keith-core token recover`.
import { processIo } from '@keith/cli'
import { runCoreCli } from './cli/program.ts'
import { applyUmask } from './platform/bootstrap.ts'

applyUmask()
process.exit(await runCoreCli(['token', 'recover'], processIo()))
