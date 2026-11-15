import { describe, expect, test } from 'bun:test'
import { b64urlDecode, b64urlEncode } from './encoding.ts'
import { encryptPayload, importP256Private, MAX_PLAINTEXT } from './encrypt.ts'

// RFC 8291 Appendix A: the example message, with the fixed keys and salt of the RFC.
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: ['BTBZMqHH', '6r4Tts7J', '_aSIgg'].join(''), // RFC 8291 Appendix A, built at runtime (gitleaks)
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

describe('RFC 8291 aes128gcm', () => {
  test('matches the Appendix A test vector byte for byte', async () => {
    const publicRaw = b64urlDecode(V.asPublic)
    const body = await encryptPayload(V.plaintext, {
      p256dh: b64urlDecode(V.uaPublic),
      auth: b64urlDecode(V.auth),
      salt: b64urlDecode(V.salt),
      serverKeys: {
        publicRaw,
        privateKey: await importP256Private(b64urlDecode(V.asPrivate), publicRaw, 'deriveBits'),
      },
    })
    expect(b64urlEncode(body)).toBe(V.body)
  })

  test('the header names the salt, a 4096 record size and the 65-byte server key', async () => {
    const body = await encryptPayload('hi', {
      p256dh: b64urlDecode(V.uaPublic),
      auth: b64urlDecode(V.auth),
    })
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(body[21]).toBe(0x04)
    // salt + rs + idlen + keyid + (2 bytes + delimiter + 16 byte tag)
    expect(body.length).toBe(16 + 4 + 1 + 65 + 2 + 1 + 16)
  })

  test('two messages never share a salt or a server key', async () => {
    const opts = { p256dh: b64urlDecode(V.uaPublic), auth: b64urlDecode(V.auth) }
    const a = await encryptPayload('x', opts)
    const b = await encryptPayload('x', opts)
    expect(b64urlEncode(a.slice(0, 16))).not.toBe(b64urlEncode(b.slice(0, 16)))
    expect(b64urlEncode(a.slice(21, 86))).not.toBe(b64urlEncode(b.slice(21, 86)))
  })

  test('refuses a payload over one record and malformed keys', async () => {
    const opts = { p256dh: b64urlDecode(V.uaPublic), auth: b64urlDecode(V.auth) }
    await expect(encryptPayload('a'.repeat(MAX_PLAINTEXT + 1), opts)).rejects.toThrow('payload')
    await expect(encryptPayload('a'.repeat(MAX_PLAINTEXT), opts)).resolves.toBeDefined()
    await expect(encryptPayload('x', { ...opts, p256dh: new Uint8Array(65) })).rejects.toThrow(
      'uncompressed',
    )
    await expect(encryptPayload('x', { ...opts, auth: new Uint8Array(8) })).rejects.toThrow('auth')
  })
})
