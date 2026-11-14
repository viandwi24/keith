import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keithContract } from '@keith/contracts'
import { aclCommand } from './acl-command.ts'
import { groupsCommand } from './groups-command.ts'
import { guestsCommand } from './guests-command.ts'
import { peopleCommand } from './people-commands.ts'
import { pluginCommand } from './plugin-command.ts'
import { protocolsCommand } from './protocols-command.ts'
import { reviewsCommand } from './reviews-command.ts'
import { successionCommand } from './succession-command.ts'

/**
 * `keith-core <group> <verb>` is a thin client of one oRPC procedure: it enforces nothing itself, so who may run it
 * and whether it needs a step-up is the procedure's metadata in `contract.ts`. This table pins the mapping; a new
 * subcommand or a new procedure call without a row fails here, and the metadata is read from the contract.
 */
const MAP = {
  people: {
    list: ['admin.people.list'],
    add: ['admin.people.add'],
    rename: ['admin.people.rename'],
    role: ['admin.people.setRole'],
    suspend: ['admin.people.suspend'],
    reactivate: ['admin.people.reactivate'],
    remove: ['admin.people.remove'],
    export: ['admin.people.export'],
    login: ['admin.people.setLogin'],
    'transfer-owner': ['admin.people.transferOwner'],
    passwd: ['admin.people.setPassword'],
    pin: ['admin.people.setPin'],
    grant: ['admin.people.grants', 'admin.people.grant'],
    'revoke-grant': ['admin.people.revokeGrant'],
    alias: ['admin.people.alias.add', 'admin.people.alias.remove', 'admin.people.alias.list'],
    unlock: ['admin.people.unlock'],
    'clear-password': ['admin.people.clearSecret'],
    'clear-pin': ['admin.people.clearSecret'],
  },
  groups: {
    list: ['admin.groups.list'],
    show: ['admin.groups.get'],
    create: ['admin.groups.create'],
    delete: ['admin.groups.delete'],
    add: ['admin.groups.add'],
    remove: ['admin.groups.remove'],
  },
  acl: {
    show: ['acl.show'],
    share: ['acl.share'],
    unshare: ['acl.unshare'],
    chmod: ['acl.chmod'],
    chgrp: ['acl.chgrp'],
    chown: ['acl.chown'],
  },
  plugin: {
    list: ['admin.plugins.list'],
    show: ['admin.plugins.show'],
    enable: ['admin.plugins.enable'],
    disable: ['admin.plugins.disable'],
  },
  guests: {
    status: ['admin.guests.get'],
    enable: ['admin.guests.get', 'admin.guests.set'],
    disable: ['admin.guests.get', 'admin.guests.set'],
    set: ['admin.guests.set'],
    kill: ['admin.guests.killswitch'],
    list: ['admin.guests.list'],
    peek: ['admin.guests.peek'],
    end: ['admin.guests.end'],
  },
  reviews: {
    list: ['admin.reviews.list'],
    approve: ['admin.reviews.approve'],
    deny: ['admin.reviews.deny'],
  },
  // the protocol engine (contract.ts `protocols`): own protocols need `chat`, the settings their own capabilities
  protocols: {
    list: ['protocols.list'],
    show: ['protocols.get'],
    pause: ['protocols.setEnabled', 'protocols.pause'],
    resume: ['protocols.get', 'protocols.setEnabled', 'protocols.pause'],
    delete: ['protocols.delete'],
    runs: ['protocols.runs'],
    settings: ['protocols.settings.get', 'protocols.settings.set'],
  },
  // the owner-absence settings (succession.md "CLI and TUI"): every change is the owner's, with a step-up over TCP
  succession: {
    status: ['admin.succession.get'],
    heir: ['admin.succession.setHeir', 'admin.succession.clearHeir'],
    window: ['admin.succession.setWindow'],
    pause: ['admin.succession.pause'],
    resume: ['admin.succession.resume'],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>

const COMMANDS = {
  people: peopleCommand,
  groups: groupsCommand,
  acl: aclCommand,
  plugin: pluginCommand,
  guests: guestsCommand,
  reviews: reviewsCommand,
  protocols: protocolsCommand,
  succession: successionCommand,
}
const SOURCES = {
  people: 'people-commands.ts',
  groups: 'groups-command.ts',
  acl: 'acl-command.ts',
  plugin: 'plugin-command.ts',
  guests: 'guests-command.ts',
  reviews: 'reviews-command.ts',
  protocols: 'protocols-command.ts',
  succession: 'succession-command.ts',
}
/** The capability that guards a family; `acl.*` decide on the stored resource in the handler (`authenticated`). */
const CAPABILITY = {
  people: 'people.manage',
  groups: 'groups.manage',
  acl: 'authenticated',
  plugin: 'plugins.manage',
  guests: 'guests.manage',
  reviews: 'reviews.decide',
  protocols: 'chat',
  succession: 'succession.manage',
} as const
/** Procedures that only read: they need no step-up. */
const READS = /\.(list|get|show|grants|status)$/

const meta = (path: string): { capability?: string; stepUp?: boolean } => {
  let node: unknown = keithContract
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part]
  return ((node as { '~orpc'?: { meta?: object } } | undefined)?.['~orpc']?.meta ?? {}) as {
    capability?: string
    stepUp?: boolean
  }
}

describe('keith-core subcommands against the contract', () => {
  for (const [family, make] of Object.entries(COMMANDS) as [
    keyof typeof COMMANDS,
    typeof peopleCommand,
  ][]) {
    const table: Record<string, readonly string[]> = MAP[family]

    test(`${family}: every subcommand has a row, and the table has no stale one`, () => {
      const names = (make({}).subcommands ?? []).map((s) => s.name).sort()
      expect(Object.keys(table).sort()).toEqual(names)
    })

    test(`${family}: the procedures the source calls are the ones in the table`, () => {
      const source = readFileSync(join(import.meta.dir, SOURCES[family]), 'utf8')
      const called = new Set(
        [...source.matchAll(/rpc\.((?:admin\.)?[a-z]+(?:\.[a-zA-Z]+)+)/g)]
          .map((m) => m[1] as string)
          // `client.rpc.admin.plugins` is held in a variable and called as `api.enable|disable`
          .filter((p) => p !== 'admin.plugins'),
      )
      const mapped = new Set(Object.values(table).flat())
      for (const p of called)
        expect(mapped.has(p), `${p} is called but not in the table`).toBe(true)
      // `enable` and `disable` call through `api.enable|disable`, so the source never spells their path
      const spelled =
        family === 'plugin' ? new Set(['admin.plugins.list', 'admin.plugins.show']) : mapped
      for (const p of spelled)
        expect(called.has(p), `${p} is in the table but never called`).toBe(true)
    })

    test(`${family}: each procedure has the family's capability, and a step-up unless it only reads`, () => {
      for (const [verb, paths] of Object.entries(table))
        for (const path of paths) {
          const m = meta(path)
          expect(m.capability, `${family} ${verb}: ${path}`).toBeDefined()
          const expected =
            family === 'acl' && path === 'acl.chown'
              ? 'people.manage'
              : family === 'protocols' && path.startsWith('protocols.settings.')
                ? path.endsWith('.get')
                  ? 'settings.read'
                  : 'settings.manage'
                : family === 'succession' && path === 'admin.succession.get'
                  ? 'authenticated' // the handler decides: the owner's view, the heir's view, or NOT_FOUND
                  : CAPABILITY[family]
          expect(m.capability, `${family} ${verb}: ${path}`).toBe(expected)
          if (family === 'acl' && path !== 'acl.chown') continue // widening is checked in the handler (permissions.md)
          // a person's own protocol changes with `chat` and no step-up; only the settings `set` is owner-sensitive
          if (family === 'protocols')
            expect(m.stepUp === true, `${family} ${verb}: ${path} step-up`).toBe(
              path === 'protocols.settings.set',
            )
          else
            expect(m.stepUp === true, `${family} ${verb}: ${path} step-up`).toBe(!READS.test(path))
        }
    })
  }
})
