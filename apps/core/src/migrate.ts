// `bun run db:migrate`: alias of `keith-core db migrate`.
import { processIo } from '@keith/cli'
import { runCoreCli } from './cli/program.ts'
import { applyUmask } from './platform/bootstrap.ts'

applyUmask()
process.exit(await runCoreCli(['db', 'migrate'], processIo()))
