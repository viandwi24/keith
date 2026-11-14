/** `bun run eval:guest [--scripted] [--script honest|leaky] [--guest-model ref] [--max-usd N] [--out dir]`. */
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
