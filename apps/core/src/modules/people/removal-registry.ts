/**
 * The removal hook registry (ADR-0027 §26, docs/specs/people.md "Removal"): every module that holds a
 * person's data registers what happens to it when the person is removed. `keep` runs inside
 * `people.remove` before the person row is deleted, `purge` runs after the keep time. A `keep` that
 * throws refuses the removal, and the parts that already ran are undone.
 */

/** Puts back what a `keep` moved or deleted. Called when a later part of the same removal fails. */
export type RemovalUndo = () => void | Promise<void>

/** One module's share of a removed person's data. */
export interface PersonRemovalHooks {
  /**
   * Stop what runs for the person (a worker of theirs). Called for every module before any `keep`, so
   * nothing is written after the data is kept. A throw refuses the removal.
   */
  stop?(personId: string): void | Promise<void>
  /**
   * Move or write this module's data of `personId` into `folder` (the person's kept folder, already
   * created). Returns how to undo it, or nothing when there was nothing to keep.
   */
  keep(personId: string, folder: string): RemovalUndo | undefined | Promise<RemovalUndo | undefined>
  /**
   * Write this module's data of `personId` into `dest` for `people export`: from the kept folder once the
   * person is removed, else from the live data. Writes nothing when there is nothing to export.
   */
  export(personId: string, dest: string): void | Promise<void>
  /** Delete what `keep` left. Called once the keep time has passed, before the folder is removed. */
  purge(personId: string, folder: string): void | Promise<void>
}

export interface RemovalRegistration {
  /** Unique name of the module, for the errors and the tests (`memory`, `workspace`, `conversations`, ...). */
  module: string
  onPersonRemoved: PersonRemovalHooks
}

export interface RemovalRegistry {
  registerRemoval(registration: RemovalRegistration): void
  registrations(): readonly RemovalRegistration[]
}

/** The registry the core fills at wiring time; a module registers once, in the order it is wired. */
export function createRemovalRegistry(): RemovalRegistry {
  const list: RemovalRegistration[] = []
  return {
    registerRemoval(registration) {
      if (list.some((r) => r.module === registration.module))
        throw new Error(`removal of ${registration.module} is registered twice`)
      list.push(registration)
    },
    registrations: () => [...list],
  }
}
