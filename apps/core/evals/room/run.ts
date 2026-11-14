/** `bun run eval:room [--scripted] [--script honest|leaky] [--model ref] [--max-usd N] [--out dir]`. */
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
