// The Mind: threads, the turn loop and the context builder. Interfaces: ./types.ts.

export { type ContextBuilderDeps, createContextBuilder, personaFromFile } from './context-builder.ts'
export { createRunLoop, type RunLoopDeps } from './run-loop.ts'
export {
  APOLOGY_TEXT,
  createThreadManager,
  type MindThreadManager,
  type ThreadManagerDeps,
} from './thread-manager.ts'
