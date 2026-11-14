/** `bun run eval:dreaming [--scripted] [--script honest|leaky] [--max-usd N] [--out dir]`. */
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
