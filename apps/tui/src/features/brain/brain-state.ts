// The brain state lives in `@keith/app-model` (shared with the web); the panel imports it from here.
export {
  type BrainState,
  describeEvent,
  dreamLineOf,
  FADE_MS,
  initialBrain,
  type Lamp,
  lampOf,
  type RegionView,
  reduceBrain,
  resyncBrain,
  TRACE_LIMIT,
  type TraceEntry,
  viewKey,
  viewOf,
} from '@keith/app-model'
