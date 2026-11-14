/** The runner behind `bun run eval:persona` (docs/specs/evals.md, the persona scenario). */
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
