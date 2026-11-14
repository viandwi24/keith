import { describe, expect, test } from 'bun:test'
import { jpegSize } from './jpeg.ts'
import { fakeJpeg } from './testing/fake-backend.ts'

describe('jpegSize', () => {
  test('reads width and height from the frame header', () => {
    expect(jpegSize(fakeJpeg(1280, 800))).toEqual({ width: 1280, height: 800 })
    expect(jpegSize(fakeJpeg(3840, 2160, 100))).toEqual({ width: 3840, height: 2160 })
  })

  test('skips an APP0 segment before the frame header', () => {
    // SOI, APP0 with a 4-byte payload (length 6), then the SOF0 frame header of 640x480.
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
      0x01, 0xe0, 0x02, 0x80, 0x03,
    ])
    expect(jpegSize(bytes)).toEqual({ width: 640, height: 480 })
  })

  test('returns undefined for bytes that are not a JPEG', () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]))).toBeUndefined()
    expect(jpegSize(new Uint8Array([0xff, 0xd8]))).toBeUndefined()
  })

  test('returns undefined when the frame header is cut short', () => {
    expect(
      jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20])),
    ).toBeUndefined()
  })
})
