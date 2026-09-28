// Builds the scheduler folder against in-memory fakes, for tests.

import type { Agent } from '@keith/sdk'
import { createFakeClock, createMemoryLogger, type FakeClock, type MemoryLogger } from '@keith/sdk/testing'
import type { KeithConfig } from '../../config/types.ts'
import type { RunLoop } from '../../mind/types.ts'
import type { Ids } from '../../shared/types.ts'
import { createScheduling, type Scheduling } from '../index.ts'
import {
  type ControlledRunLoop,
  createControlledRunLoop,
  createFakeAgents,
  createFakeEventBus,
  createFakeIds,
  createFakeRepos,
  createTestConfig,
  type FakeEventBus,
  type FakeRepos,
  GENERAL_TEST_AGENT,
} from './fakes.ts'

export type Harness = Scheduling & {
  config: KeithConfig
  clock: FakeClock
  ids: Ids
  events: FakeEventBus
  repos: FakeRepos
  loop: ControlledRunLoop
  log: MemoryLogger
}

export function createHarness(
  opts: {
    config?: KeithConfig
    agents?: Agent[]
    repos?: FakeRepos
    ids?: Ids
    /** A real RunLoop instead of the controlled one (`loop` then sees no calls). */
    runLoop?: RunLoop
  } = {},
): Harness {
  const config = opts.config ?? createTestConfig()
  const clock = createFakeClock(1_000_000)
  const ids = opts.ids ?? createFakeIds()
  const events = createFakeEventBus(clock)
  const repos = opts.repos ?? createFakeRepos()
  const loop = createControlledRunLoop()
  const log = createMemoryLogger()
  const scheduling = createScheduling({
    config,
    repos,
    runLoop: opts.runLoop ?? loop.runLoop,
    agents: createFakeAgents(opts.agents ?? [GENERAL_TEST_AGENT]),
    events,
    ids,
    clock,
    log,
  })
  return { ...scheduling, config, clock, ids, events, repos, loop, log }
}
