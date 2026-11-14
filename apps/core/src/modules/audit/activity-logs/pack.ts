// Stored bodies are gzipped JSON (ADR-0032 §5).

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function pack(value: unknown): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(encoder.encode(JSON.stringify(value) ?? 'null'))
}

export function unpack(bytes: Uint8Array<ArrayBuffer>): unknown {
  return JSON.parse(decoder.decode(Bun.gunzipSync(bytes)))
}
