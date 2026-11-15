/** `bun run eval:consent [--scripted] [--script honest|obedient] [--model ref] [--max-usd N] [--out dir]`. */
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
