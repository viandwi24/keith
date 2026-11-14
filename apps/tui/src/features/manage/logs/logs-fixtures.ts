import type {
  LlmCallRecord,
  LlmSessionRecord,
  LogsCallOutput,
  LogsRawOutput,
  LogsSessionOutput,
} from '@keith/contracts'

// Fixtures of the Logs tests: one chat session with a stored generation and a failed one, its call in detail and its raw JSON.

export const T0 = Date.UTC(2026, 10, 11, 14, 2, 11)

export const SESSION: LlmSessionRecord = {
  id: 'front:ana:g0',
  kind: 'chat',
  personId: 'ana',
  roomId: null,
  app: 'Front',
  firstAt: T0,
  lastAt: T0 + 192_000,
  calls: 2,
  costMicro: 45_600,
  primaryModel: 'claude-sonnet-4.5',
  primaryProvider: 'openrouter',
}

const CALL_BASE: LlmCallRecord = {
  id: 'call-ok-1',
  sessionId: 'front:ana:g0',
  kind: 'step',
  trigger: 'send',
  turnId: 'turn-1',
  stepIndex: 0,
  startedAt: T0,
  durationMs: 1840,
  firstChunkMs: 410,
  status: 'ok',
  finishReason: 'stop',
  modelId: 'claude-sonnet-4.5',
  provider: 'openrouter',
  upstreamProvider: 'anthropic',
  tokensIn: 1200,
  tokensOut: 340,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  costMicro: 4200,
  costSource: 'provider',
  fallbackNote: null,
  errorName: null,
  errorMessage: null,
  requestBytes: 2000,
  responseBytes: 900,
  bodyState: 'stored',
  speakerId: null,
}

export const CALL_OK: LlmCallRecord = CALL_BASE

export const CALL_ERR: LlmCallRecord = {
  ...CALL_BASE,
  id: 'call-err-2',
  startedAt: T0 + 120_000,
  durationMs: 900,
  firstChunkMs: null,
  status: 'error',
  finishReason: null,
  modelId: 'gpt-4.1-mini',
  tokensIn: 300,
  tokensOut: 0,
  costMicro: null,
  costSource: null,
  errorName: 'TimeoutError',
  errorMessage: 'the provider did not answer',
  stepIndex: 1,
}

export const SESSION_DETAIL: LogsSessionOutput = {
  session: SESSION,
  generations: [CALL_OK, CALL_ERR],
  more: false,
}

export const CALL_DETAIL: LogsCallOutput = {
  call: CALL_OK,
  messages: [
    { role: 'system', text: 'You are Keith.' },
    { role: 'user', text: 'what is using my disk?' },
  ],
  toolCalls: [{ toolCallId: 'tool-1', toolName: 'motor_remote', input: '{"node":"laptop-e"}' }],
  outputText: 'Checking the disk now.',
  reasoning: '',
  truncated: false,
}

export const RAW: LogsRawOutput = {
  callId: 'call-ok-1',
  bodyState: 'stored',
  request: '{"model":"claude-sonnet-4.5","messages":[]}',
  response: '{"id":"gen-1","usage":{"input_tokens":1200}}',
  truncated: true,
}
