import { expect, test } from 'bun:test'
import { sha256Hex } from './hash.ts'

test('sha256Hex is the SHA-256 of the UTF-8 bytes in lowercase hex', () => {
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const bytes = new TextEncoder().encode('é-code')
  expect(sha256Hex('é-code')).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'))
})
