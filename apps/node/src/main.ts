#!/usr/bin/env bun
import { main } from './cli.ts'

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

process.exit(await main(process.argv.slice(2), controller.signal))
