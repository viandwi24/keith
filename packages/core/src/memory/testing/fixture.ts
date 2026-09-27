// A small household for memory tests: Tony (owner), Pepper (member), Happy (guest). Test-only.

import { createFakeClock, createMemoryLogger, type FakeClock, type MemoryLogger } from '@keith/sdk/testing'
import type { PersonDto, TaskId, TaskStatus, ThreadId, Visibility } from '../../shared/types.ts'
import { MemoryStore } from '../service.ts'
import {
  createFakeIds,
  FakeEventBus,
  FakeMemoriesRepository,
  FakePersonsRepository,
  FakeTasksRepository,
  FakeThreadsRepository,
  fixedId,
} from './fakes.ts'

export const TONY = fixedId('per', 901)
export const PEPPER = fixedId('per', 902)
export const HAPPY = fixedId('per', 903)
export const TONY_MAIN = fixedId('thr', 911)
export const PEPPER_MAIN = fixedId('thr', 912)
export const HAPPY_MAIN = fixedId('thr', 913)
/** Tony and Pepper. */
export const MISSION = fixedId('thr', 914)
/** Tony, Pepper and Happy. */
export const PARTY = fixedId('thr', 915)

export type Household = {
  memory: MemoryStore
  memories: FakeMemoriesRepository
  persons: FakePersonsRepository
  threads: FakeThreadsRepository
  tasks: FakeTasksRepository
  events: FakeEventBus
  clock: FakeClock
  log: MemoryLogger
  dto: Record<'tony' | 'pepper' | 'happy', PersonDto>
  addTask(a: {
    n: number
    personId: PersonDto['id']
    threadId: ThreadId | null
    goal: string
    visibility?: Visibility
    status?: TaskStatus
  }): Promise<TaskId>
}

export async function createHousehold(opts: { coreMaxChars?: number } = {}): Promise<Household> {
  const memories = new FakeMemoriesRepository()
  const persons = new FakePersonsRepository()
  const threads = new FakeThreadsRepository()
  const tasks = new FakeTasksRepository()
  const events = new FakeEventBus()
  const clock = createFakeClock(1_000_000)
  const log = createMemoryLogger()

  persons.add(TONY, 'Tony', 'owner')
  persons.add(PEPPER, 'Pepper', 'member')
  persons.add(HAPPY, 'Happy', 'guest')
  await threads.add(TONY_MAIN, 'Tony', [TONY])
  await threads.add(PEPPER_MAIN, 'Pepper', [PEPPER])
  await threads.add(HAPPY_MAIN, 'Happy', [HAPPY])
  await threads.add(MISSION, 'Mission', [TONY, PEPPER])
  await threads.add(PARTY, 'Party', [TONY, PEPPER, HAPPY])

  const memory = new MemoryStore({
    repos: { memories, persons, threads, tasks },
    events,
    config: {
      memory: {
        coreMaxChars: opts.coreMaxChars ?? 1500,
        reflect: { enabled: true, idleMinutes: 20, maxMessages: 200, cardMaxChars: 1_000 },
        summary: { enabled: true, minMessages: 20, maxChars: 2_000 },
      },
    },
    clock,
    ids: createFakeIds(),
    log,
  })

  return {
    memory,
    memories,
    persons,
    threads,
    tasks,
    events,
    clock,
    log,
    dto: {
      tony: { id: TONY, name: 'Tony', tier: 'owner' },
      pepper: { id: PEPPER, name: 'Pepper', tier: 'member' },
      happy: { id: HAPPY, name: 'Happy', tier: 'guest' },
    },
    async addTask(a) {
      const id = fixedId('tsk', a.n)
      await tasks.create({
        id,
        personId: a.personId,
        threadId: a.threadId,
        agentId: 'general',
        goal: a.goal,
        status: a.status ?? 'running',
        attempt: 1,
        visibility: a.visibility ?? 'subject',
        summary: null,
        detail: null,
        ui: null,
        createdAt: a.n,
        startedAt: a.n,
        finishedAt: null,
      })
      return id
    },
  }
}
