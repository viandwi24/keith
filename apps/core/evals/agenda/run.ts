/** `bun run eval:agenda [--scripted] [--script honest|leaky] [--front-model ref] [--max-usd N] [--out dir]`. */
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
