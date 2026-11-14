/** `bun run eval:news [--scripted] [--runs N] [--max-usd N] [--data dir] [--out dir]`. */
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
