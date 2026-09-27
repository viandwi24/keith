#!/usr/bin/env bun
import { main } from './main.ts'

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env)
  process.exit()
}
