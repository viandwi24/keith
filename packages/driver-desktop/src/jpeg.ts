// Reads the size of a JPEG from its header, so the driver never needs an image library.

/** Width and height in pixels from the JPEG frame header, or undefined when the bytes are not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const at = (index: number): number => bytes[index] ?? 0
  if (bytes.length < 4 || at(0) !== 0xff || at(1) !== 0xd8) return undefined
  let i = 2
  while (i + 3 < bytes.length) {
    if (at(i) !== 0xff) return undefined
    const marker = at(i + 1)
    if (marker === 0xff) {
      i += 1
      continue
    }
    // Markers without a length: start of image, end of image, restart markers, temporary.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2
      continue
    }
    // Start of frame: SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= bytes.length) return undefined
      const height = (at(i + 5) << 8) | at(i + 6)
      const width = (at(i + 7) << 8) | at(i + 8)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    // Start of scan comes after the frame header; no size was found before it.
    if (marker === 0xda) return undefined
    i += 2 + ((at(i + 2) << 8) | at(i + 3))
  }
  return undefined
}
